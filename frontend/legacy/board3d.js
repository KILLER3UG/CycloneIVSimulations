/* Cyclone IV dev-board 3D view (Three.js).
 *
 * The board is a real object, not a diagram: PCB, 144-pin FPGA, SDRAM, flash,
 * crystal, regulators, USB, headers, switches, LEDs and a four-digit
 * multiplexed seven-segment display.  Every lit segment, LED and switch is
 * driven by the simulation's cycle data.
 */
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";
import { RoundedBoxGeometry } from "./vendor/RoundedBoxGeometry.js";

const TOP = 0.16; // PCB top surface
const BOARD_W = 12;
const BOARD_D = 9;
const DISPLAY_POS = new THREE.Vector3(2.4, TOP, -3.3);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function toInt(value) {
    if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") {
        const text = value.trim().toLowerCase();
        if (text === "1" || text === "true") return 1;
        if (text === "0" || text === "false" || text === "x" || text === "z") return 0;
        if (/^0x[0-9a-f]+$/.test(text)) return parseInt(text.slice(2), 16) || 0;
        if (/^[01]+$/.test(text)) return parseInt(text, 2) || 0;
        const number = Number(text);
        return Number.isFinite(number) ? Math.trunc(number) : 0;
    }
    return 0;
}

function bitAt(value, bit) {
    return (toInt(value) >>> bit) & 1;
}

function popcount(value) {
    let count = 0;
    let v = toInt(value);
    while (v) {
        count += v & 1;
        v >>>= 1;
    }
    return count;
}

function decodeActiveDigit(value, width) {
    const v = toInt(value);
    if (width <= 2) return v & 3;
    const set = [];
    for (let i = 0; i < width; i += 1) if (v & (1 << i)) set.push(i);
    if (set.length === 1) return set[0];
    if (set.length === width - 1) {
        for (let i = 0; i < width; i += 1) if (!(v & (1 << i))) return i;
    }
    return -1;
}

function roundedRectShape(width, depth, radius) {
    const shape = new THREE.Shape();
    const x = -width / 2;
    const y = -depth / 2;
    shape.moveTo(x + radius, y);
    shape.lineTo(x + width - radius, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + radius);
    shape.lineTo(x + width, y + depth - radius);
    shape.quadraticCurveTo(x + width, y + depth, x + width - radius, y + depth);
    shape.lineTo(x + radius, y + depth);
    shape.quadraticCurveTo(x, y + depth, x, y + depth - radius);
    shape.lineTo(x, y + radius);
    shape.quadraticCurveTo(x, y, x + radius, y);
    return shape;
}

export class Board3D {
    constructor(container) {
        this.container = container;
        this.ok = false;
        this.active = true;
        this.reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        this.width = Math.max(320, container.clientWidth || 800);
        this.height = Math.max(200, container.clientHeight || 300);
        this.entity = null;
        this.board = null;
        this.displayMode = "blank";
        this.displayPorts = [];
        this.digitPort = null;
        this.latched = [0, 0, 0, 0];
        this.latchedSeen = [false, false, false, false];
        this.glow = [0, 0, 0, 0];
        this.directValues = [0, 0, 0, 0];
        this.staticValue = 0;
        this.lastHex = 0;
        this.lastDig = 0;
        this.activeDigit = -1;
        this.scanHz = 90;
        this.values = {};
        this.readoutTimer = 0;
        this.onReadout = null;
        this.lastReadout = "";
        this.ledCells = [];
        this.switchCells = [];
        this.keyCells = [];
        this.digitSegments = [];
        this.camTween = null;
        this.interactive = [];
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this.hovered = null;
        this.onToggle = null;
        this.onHover = null;
        this.peripherals = new Map();
        this.periphSlots = [
            new THREE.Vector3(-4.2, TOP, -6.6),
            new THREE.Vector3(-2.1, TOP, -6.6),
            new THREE.Vector3(0.0, TOP, -6.6),
            new THREE.Vector3(2.1, TOP, -6.6),
            new THREE.Vector3(4.2, TOP, -6.6),
            new THREE.Vector3(6.3, TOP, -6.6),
        ];
        this.glowScale = 1;
        this.particles = null;
        this.grid = null;
        this.ghost = false;
        this._pointerDown = null;

        try {
            this.renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: true,
                powerPreference: "high-performance",
            });
        } catch (error) {
            this.fail(error);
            return;
        }

        this.ok = true;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        this.renderer.setSize(this.width, this.height);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.08;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.domElement.className = "board3d-canvas-el";
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(36, this.width / this.height, 0.1, 200);
        this.homePosition = new THREE.Vector3(8.6, 8.0, 11.0);
        this.homeTarget = new THREE.Vector3(0, 0.3, 0);
        this.camera.position.copy(this.homePosition);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.copy(this.homeTarget);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.075;
        this.controls.rotateSpeed = 0.65;
        this.controls.zoomSpeed = 0.85;
        this.controls.panSpeed = 0.6;
        this.controls.minDistance = 4.5;
        this.controls.maxDistance = 38;
        this.controls.maxPolarAngle = Math.PI * 0.49;
        this.controls.minPolarAngle = 0.12;
        this.controls.autoRotateSpeed = 0.55;

        this.clock = new THREE.Clock();
        this.buildMaterials();
        this.buildEnvironment();
        this.buildBoard();
        this.buildDisplay();
        this.setupInteraction();

        // The board is a static object: bake its shadow map once instead of
        // re-rendering it every frame, so orbiting stays smooth at full quality.
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = true;

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.animate = this.animate.bind(this);
        this.frame = requestAnimationFrame(this.animate);
    }

    fail(error) {
        this.ok = false;
        console.error("Board3D:", error);
        if (this.container) {
            this.container.innerHTML = "";
            const fallback = document.createElement("div");
            fallback.className = "board3d-fallback";
            fallback.innerHTML = '<div class="fallback-title">3D view unavailable</div><div class="fallback-body">WebGL could not start. Use the 2D board or enable hardware acceleration.</div>';
            this.container.appendChild(fallback);
        }
    }

    // ------------------------------------------------------------- materials
    buildMaterials() {
        this.mats = {
            pcb: new THREE.MeshPhysicalMaterial({
                color: 0x0a0e15,
                roughness: 0.52,
                metalness: 0.18,
                clearcoat: 0.4,
                clearcoatRoughness: 0.6,
            }),
            pcbEdge: new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.85 }),
            chip: new THREE.MeshPhysicalMaterial({
                color: 0x090b0e,
                roughness: 0.36,
                metalness: 0.18,
                clearcoat: 0.5,
                clearcoatRoughness: 0.35,
            }),
            plastic: new THREE.MeshPhysicalMaterial({
                color: 0x10151b,
                roughness: 0.46,
                metalness: 0.06,
                clearcoat: 0.2,
            }),
            plasticSoft: new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.8 }),
            white: new THREE.MeshStandardMaterial({ color: 0xd9d4c6, roughness: 0.7 }),
            gold: new THREE.MeshStandardMaterial({ color: 0xd9a53f, metalness: 1, roughness: 0.27 }),
            silver: new THREE.MeshStandardMaterial({ color: 0xcbd4da, metalness: 0.95, roughness: 0.22 }),
            steel: new THREE.MeshStandardMaterial({ color: 0x8f9aa2, metalness: 0.9, roughness: 0.34 }),
            copper: new THREE.MeshStandardMaterial({ color: 0xb56a3a, metalness: 1, roughness: 0.3 }),
            dark: new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.62 }),
            ceramic: new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.75 }),
            rubber: new THREE.MeshStandardMaterial({ color: 0x07090b, roughness: 0.95 }),
            blue: new THREE.MeshStandardMaterial({ color: 0x1f63b8, roughness: 0.42, metalness: 0.08 }),
            red: new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 }),
            yellow: new THREE.MeshStandardMaterial({ color: 0xe3c231, roughness: 0.5, metalness: 0.05 }),
            capSleeve: new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.7 }),
            ledOff: 0x2a0c0a,
            ledOn: 0xff3a24,
        };
    }

    buildEnvironment() {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment();
        this.scene.environment = pmrem.fromScene(room, 0.04).texture;
        this.scene.environmentIntensity = 0.62;
        pmrem.dispose();

        // Atmospheric depth: subtle exponential fog tinted to the PCB navy.
        this.scene.fog = new THREE.FogExp2(0x070b12, 0.021);

        this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x05080c, 0.55));

        const key = new THREE.DirectionalLight(0xfff0dd, 2.35);
        key.position.set(8, 14, 10);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = -12;
        key.shadow.camera.right = 12;
        key.shadow.camera.top = 12;
        key.shadow.camera.bottom = -12;
        key.shadow.camera.near = 1;
        key.shadow.camera.far = 44;
        key.shadow.bias = -0.0006;
        key.shadow.normalBias = 0.02;
        this.scene.add(key);
        this.keyLight = key;

        const fill = new THREE.DirectionalLight(0x88bbff, 0.85);
        fill.position.set(-10, 7, -8);
        this.scene.add(fill);
        this.fillLight = fill;

        const rim = new THREE.DirectionalLight(0xffb36b, 0.7);
        rim.position.set(0, 6, -12);
        this.scene.add(rim);
        this.rimLight = rim;

        // Cool electric-blue kicker from the front-left for drama.
        const kick = new THREE.DirectionalLight(0x3d9bff, 0.5);
        kick.position.set(-9, 4, 12);
        this.scene.add(kick);
        this.kickLight = kick;

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(80, 80),
            new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.36 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.03;
        ground.receiveShadow = true;
        this.scene.add(ground);

        // Reference grid (hidden by default), toggled from the Scene panel.
        this.grid = new THREE.GridHelper(40, 40, 0x2a4a6a, 0x16283c);
        this.grid.position.y = -0.02;
        this.grid.material.transparent = true;
        this.grid.material.opacity = 0.5;
        this.grid.visible = false;
        this.scene.add(this.grid);

        this.buildParticles();
    }

    buildParticles() {
        const count = 220;
        const positions = new Float32Array(count * 3);
        const speeds = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
            positions[i * 3] = (Math.random() - 0.5) * 30;
            positions[i * 3 + 1] = Math.random() * 12 + 0.5;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 26;
            speeds[i] = 0.15 + Math.random() * 0.4;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0x6fb6ff,
            size: 0.06,
            map: this.makeGlowTexture(),
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            sizeAttenuation: true,
        });
        this.particles = new THREE.Points(geo, mat);
        this.particles.userData.speeds = speeds;
        this.particles.frustumCulled = false;
        this.scene.add(this.particles);
    }

    // --------------------------------------------------------------- helpers
    addBox(parent, width, height, depth, material, x, y, z, radius = 0.03) {
        const geometry = radius > 0
            ? new RoundedBoxGeometry(width, height, depth, 2, Math.min(radius, Math.min(width, height, depth) / 2 - 0.001))
            : new THREE.BoxGeometry(width, height, depth);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        return mesh;
    }

    addCylinder(parent, radiusTop, radiusBottom, height, material, x, y, z, segments = 24) {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
            material
        );
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        return mesh;
    }

    addTorus(parent, radius, tube, material, x, y, z) {
        const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 28), material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        parent.add(mesh);
        return mesh;
    }

    makeTextTexture(text, options = {}) {
        const width = 512;
        const height = 128;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = options.color || "#dfeaf2";
        ctx.font = `${options.weight || 600} ${options.size || 46}px "Cascadia Code", Consolas, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, width / 2, height / 2 + 2);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        return texture;
    }

    makeChipTexture(lines, options = {}) {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = options.color || "#aeb9c2";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const n = lines.length;
        const lh = options.lineHeight || 42;
        const startY = size / 2 - ((n - 1) * lh) / 2;
        lines.forEach((line, i) => {
            ctx.font = `${i === 0 ? 700 : 500} ${i === 0 ? (options.titleSize || 40) : (options.size || 28)}px "Cascadia Code", Consolas, monospace`;
            ctx.fillText(line, size / 2, startY + i * lh);
        });
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        return texture;
    }

    makeGlowTexture() {
        const size = 128;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        gradient.addColorStop(0, "rgba(255,255,255,1)");
        gradient.addColorStop(0.22, "rgba(255,255,255,0.72)");
        gradient.addColorStop(0.55, "rgba(255,255,255,0.16)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    addGlow(parent, color, x, y, z, scale = 1) {
        const material = new THREE.SpriteMaterial({
            map: this.glowTexture,
            color,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.set(x, y, z);
        sprite.scale.setScalar(scale);
        parent.add(sprite);
        return sprite;
    }

    // A gull-wing IC (SOIC/SSOP/TSOP) with two rows of pins along the long (x)
    // axis, a pin-1 dot and an optional laser marking on top.
    addChip(w, d, h, pinsPerSide, x, z, opts = {}) {
        const group = new THREE.Group();
        group.position.set(x, TOP, z);
        this.boardGroup.add(group);
        this.addBox(group, w, h, d, this.mats.chip, 0, h / 2 + 0.02, 0, 0.02);
        const pinGeo = new THREE.BoxGeometry(0.035, 0.028, 0.11);
        const pins = new THREE.InstancedMesh(pinGeo, this.mats.silver, pinsPerSide * 2);
        const matrix = new THREE.Matrix4();
        let idx = 0;
        const span = w - 0.14;
        const step = pinsPerSide > 1 ? span / (pinsPerSide - 1) : 0;
        for (const zz of [d / 2 + 0.03, -d / 2 - 0.03]) {
            for (let i = 0; i < pinsPerSide; i += 1) {
                matrix.makeTranslation(-span / 2 + i * step, 0.03, zz);
                pins.setMatrixAt(idx, matrix);
                idx += 1;
            }
        }
        pins.castShadow = true;
        group.add(pins);
        this.addCylinder(group, 0.028, 0.028, 0.01, this.mats.white, -w / 2 + 0.1, h + 0.021, d / 2 - 0.1, 10);
        if (opts.marking) {
            const tex = this.makeChipTexture(opts.marking, { color: opts.markColor || "#9fb0bc", size: 26, titleSize: 32 });
            const plane = new THREE.Mesh(
                new THREE.PlaneGeometry(w * 0.86, d * 0.86),
                new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })
            );
            plane.rotation.x = -Math.PI / 2;
            plane.position.set(0, h + 0.022, 0);
            group.add(plane);
        }
        return group;
    }

    // ----------------------------------------------------------------- board
    buildBoard() {
        this.glowTexture = this.makeGlowTexture();
        this.boardGroup = new THREE.Group();
        this.scene.add(this.boardGroup);

        const shape = roundedRectShape(BOARD_W, BOARD_D, 0.55);
        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: TOP,
            steps: 1,
            bevelEnabled: true,
            bevelThickness: 0.035,
            bevelSize: 0.045,
            bevelSegments: 2,
            curveSegments: 12,
        });
        geometry.rotateX(-Math.PI / 2);
        const pcb = new THREE.Mesh(geometry, this.mats.pcb);
        pcb.castShadow = true;
        pcb.receiveShadow = true;
        this.boardGroup.add(pcb);

        // Silkscreen border.
        const border = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(BOARD_W - 0.5, 0.004, BOARD_D - 0.5)),
            new THREE.LineBasicMaterial({ color: 0xa9c4d3, transparent: true, opacity: 0.22 })
        );
        border.position.y = TOP + 0.003;
        this.boardGroup.add(border);

        // Gold edge pads.
        const padGeo = new THREE.BoxGeometry(0.18, 0.012, 0.09);
        const pads = new THREE.InstancedMesh(padGeo, this.mats.gold, 64);
        const matrix = new THREE.Matrix4();
        let index = 0;
        for (let i = 0; i < 16; i += 1) {
            const x = -4.8 + i * 0.64;
            for (const z of [-BOARD_D / 2 + 0.22, BOARD_D / 2 - 0.22]) {
                matrix.makeTranslation(x, TOP + 0.006, z);
                pads.setMatrixAt(index, matrix);
                index += 1;
            }
        }
        pads.count = index;
        pads.castShadow = false;
        this.boardGroup.add(pads);

        // Mounting holes and rubber feet.
        for (const x of [-5.35, 5.35]) {
            for (const z of [-3.85, 3.85]) {
                this.addCylinder(this.boardGroup, 0.21, 0.21, TOP + 0.02, this.mats.dark, x, TOP / 2, z, 20);
                this.addTorus(this.boardGroup, 0.25, 0.028, this.mats.gold, x, TOP + 0.004, z);
                this.addCylinder(this.boardGroup, 0.28, 0.3, 0.1, this.mats.rubber, x, -0.05, z, 20);
            }
        }

        this.buildSilkscreen();
        this.buildFpga();
        this.buildHeaders();
        this.buildMemory();
        this.buildPower();
        this.buildConnectors();
        this.buildSwitches();
        this.buildKeys();
        this.buildLeds();
    }

    buildFpga() {
        const group = new THREE.Group();
        group.position.set(-1.6, TOP, 0.4);
        this.boardGroup.add(group);

        // 144-pin EQFP body.
        this.addBox(group, 2.5, 0.17, 2.5, this.mats.chip, 0, 0.15, 0, 0.05);

        const pinGeo = new THREE.BoxGeometry(0.04, 0.032, 0.17);
        const pins = new THREE.InstancedMesh(pinGeo, this.mats.gold, 144);
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3(1, 1, 1);
        let idx = 0;
        for (let side = 0; side < 4; side += 1) {
            for (let i = 0; i < 36; i += 1) {
                const t = (i - 17.5) * (2.24 / 36);
                if (side === 0) {
                    position.set(t, 0.09, 1.28);
                    quaternion.identity();
                } else if (side === 1) {
                    position.set(t, 0.09, -1.28);
                    quaternion.identity();
                } else if (side === 2) {
                    position.set(1.28, 0.09, t);
                    quaternion.setFromAxisAngle(yAxis, Math.PI / 2);
                } else {
                    position.set(-1.28, 0.09, t);
                    quaternion.setFromAxisAngle(yAxis, Math.PI / 2);
                }
                matrix.compose(position, quaternion, scale);
                pins.setMatrixAt(idx, matrix);
                idx += 1;
            }
        }
        pins.castShadow = true;
        group.add(pins);

        // Pin-1 marker and laser-etched top marking.
        this.addCylinder(group, 0.06, 0.06, 0.012, this.mats.white, -0.95, 0.24, -0.95, 16);
        const label = new THREE.Mesh(
            new THREE.PlaneGeometry(1.7, 1.7),
            new THREE.MeshBasicMaterial({
                map: this.makeChipTexture(["ALTERA", "Cyclone IV", "EP4CE6E22C8N", "E22C8N · 91 I/O"], {
                    color: "#9fb2c0", size: 24, titleSize: 34, lineHeight: 46,
                }),
                transparent: true,
                depthWrite: false,
                toneMapped: false,
            })
        );
        label.rotation.x = -Math.PI / 2;
        label.position.set(0, 0.238, 0.05);
        group.add(label);

        // Decoupling capacitors around the FPGA.
        for (const [x, z] of [[-1.45, 1.0], [1.45, 1.0], [-1.45, -1.0], [1.45, -1.0]]) {
            this.addBox(group, 0.13, 0.07, 0.09, this.mats.ceramic, x, 0.045, z, 0.01);
        }
    }

    buildMemory() {
        // SDRAM HY57V641620 (TSOP-II-54) below the FPGA.
        this.addChip(1.85, 0.8, 0.12, 27, -2.1, 3.25, { marking: ["hynix", "HY57V641620"], markColor: "#8f9fac" });
        // EPCS16 serial configuration flash (SOIC-8) near the AS header.
        this.addChip(0.55, 0.4, 0.1, 4, -4.2, 0.3, { marking: ["EPCS16"], markColor: "#8f9fac" });
        // AT24C08 EEPROM (SOIC-8), bottom-centre.
        this.addChip(0.46, 0.34, 0.09, 4, 1.3, 3.45, { marking: ["24C08"], markColor: "#8f9fac" });
        // LM75 temperature sensor (SOIC-8), centre-right.
        this.addChip(0.46, 0.34, 0.09, 4, 3.6, -0.1, { marking: ["LM75"], markColor: "#8f9fac" });
        // MAX3232 RS232 transceiver (SSOP-16), near the DB9.
        this.addChip(0.62, 0.5, 0.1, 8, 3.3, -1.4, { marking: ["MAX3232"], markColor: "#8f9fac" });
    }

    buildPower() {
        // 50 MHz active crystal oscillator (metal can), left of the FPGA.
        const crystal = new THREE.Group();
        crystal.position.set(-3.5, TOP, 0.9);
        this.boardGroup.add(crystal);
        this.addBox(crystal, 0.75, 0.16, 0.5, this.mats.silver, 0, 0.08, 0, 0.03);
        this.addBox(crystal, 0.55, 0.03, 0.32, this.mats.steel, 0, 0.165, 0, 0.01);

        // Three AMS1117 regulators (3.3 V, 2.5 V, 1.2 V) on the left edge.
        for (const z of [-1.35, -1.75, -2.15]) {
            const reg = new THREE.Group();
            reg.position.set(-4.6, TOP, z);
            this.boardGroup.add(reg);
            this.addBox(reg, 0.4, 0.15, 0.34, this.mats.chip, 0, 0.075, 0, 0.02);
            this.addBox(reg, 0.28, 0.05, 0.22, this.mats.silver, 0, 0.17, -0.05, 0.01);
            for (let i = 0; i < 3; i += 1) {
                this.addBox(reg, 0.05, 0.03, 0.1, this.mats.silver, -0.1 + i * 0.1, 0.03, 0.22, 0.005);
            }
        }

        // Electrolytic bulk capacitors near the regulators.
        for (const z of [1.55, 1.95, 2.35, 2.75]) {
            this.addCylinder(this.boardGroup, 0.15, 0.15, 0.4, this.mats.capSleeve, -3.5, TOP + 0.2, z, 20);
            this.addCylinder(this.boardGroup, 0.13, 0.13, 0.014, this.mats.silver, -3.5, TOP + 0.41, z, 20);
            this.addBox(this.boardGroup, 0.04, 0.3, 0.03, this.mats.white, -3.36, TOP + 0.2, z, 0.004);
        }

        // Power indicator LED (always on), next to the power switch.
        const pwr = new THREE.Group();
        pwr.position.set(-4.55, TOP, -3.6);
        this.boardGroup.add(pwr);
        const pwrMat = new THREE.MeshPhysicalMaterial({
            color: 0x1f7a3a, emissive: 0x35d06a, emissiveIntensity: 1.6, roughness: 0.25, clearcoat: 0.7,
        });
        this.addBox(pwr, 0.16, 0.08, 0.12, pwrMat, 0, 0.1, 0, 0.01);
        this.addGlow(pwr, 0x35d06a, 0, 0.22, 0, 0.5).material.opacity = 0.5;
    }

    buildHeaders() {
        // P1 / P2 long expansion headers above and below the FPGA, P3 vertical.
        const specs = [
            { x: -1.4, z: -1.25, w: 5.0, n: 20, vertical: false },
            { x: -1.4, z: 2.05, w: 5.0, n: 20, vertical: false },
            { x: 0.55, z: 0.4, w: 2.4, n: 10, vertical: true },
        ];
        for (const spec of specs) {
            const group = new THREE.Group();
            group.position.set(spec.x, TOP, spec.z);
            if (spec.vertical) group.rotation.y = Math.PI / 2;
            this.boardGroup.add(group);
            this.addBox(group, spec.w, 0.24, 0.46, this.mats.yellow, 0, 0.12, 0, 0.04);
            this.addBox(group, spec.w - 0.08, 0.05, 0.3, this.mats.dark, 0, 0.25, 0, 0.005);
            const pinGeo = new THREE.BoxGeometry(0.05, 0.06, 0.05);
            const pins = new THREE.InstancedMesh(pinGeo, this.mats.gold, spec.n * 2);
            const matrix = new THREE.Matrix4();
            let idx = 0;
            for (const row of [-0.12, 0.12]) {
                for (let i = 0; i < spec.n; i += 1) {
                    matrix.makeTranslation(-spec.w / 2 + 0.16 + i * ((spec.w - 0.32) / (spec.n - 1)), 0.27, row);
                    pins.setMatrixAt(idx, matrix);
                    idx += 1;
                }
            }
            pins.castShadow = true;
            group.add(pins);
        }
    }

    buildConnectors() {
        // USB-B (power only) on the top edge.
        const usb = new THREE.Group();
        usb.position.set(-3.6, TOP, -3.85);
        this.boardGroup.add(usb);
        this.addBox(usb, 0.8, 0.42, 0.72, this.mats.silver, 0, 0.21, 0, 0.03);
        this.addBox(usb, 0.56, 0.24, 0.42, this.mats.dark, 0, 0.3, -0.12, 0.02);

        // LCD 1602/12864 socket (20-pin) on the top edge.
        const lcd = new THREE.Group();
        lcd.position.set(-1.2, TOP, -3.9);
        this.boardGroup.add(lcd);
        this.addBox(lcd, 3.2, 0.24, 0.4, this.mats.plastic, 0, 0.12, 0, 0.03);
        const lcdPins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), this.mats.gold, 20);
        const lm = new THREE.Matrix4();
        for (let i = 0; i < 20; i += 1) {
            lm.makeTranslation(-1.5 + i * (3.0 / 19), 0.3, 0);
            lcdPins.setMatrixAt(i, lm);
        }
        lcdPins.castShadow = true;
        lcd.add(lcdPins);

        // Blue LCD contrast trimmer, top-right.
        const pot = new THREE.Group();
        pot.position.set(4.3, TOP, -3.7);
        this.boardGroup.add(pot);
        this.addBox(pot, 0.5, 0.24, 0.5, this.mats.blue, 0, 0.12, 0, 0.02);
        this.addCylinder(pot, 0.13, 0.13, 0.1, this.mats.silver, 0, 0.3, 0, 16);
        this.addBox(pot, 0.22, 0.03, 0.04, this.mats.dark, 0, 0.35, 0, 0.005);

        // 5 V barrel jack, left edge.
        const jack = new THREE.Group();
        jack.position.set(-5.4, TOP, -2.7);
        this.boardGroup.add(jack);
        this.addCylinder(jack, 0.3, 0.3, 0.55, this.mats.dark, 0, 0.27, 0, 20);
        this.addCylinder(jack, 0.12, 0.12, 0.2, this.mats.steel, -0.12, 0.27, 0, 14);

        // Self-locking power switch (red), top-left corner.
        const pswitch = new THREE.Group();
        pswitch.position.set(-5.15, TOP, -3.85);
        this.boardGroup.add(pswitch);
        this.addBox(pswitch, 0.5, 0.3, 0.55, this.mats.plastic, 0, 0.15, 0, 0.03);
        this.addBox(pswitch, 0.26, 0.2, 0.28, this.mats.red, 0, 0.32, 0, 0.03);

        // AS + JTAG 2x5 IDC headers on the left edge.
        const asHeader = new THREE.Group();
        asHeader.position.set(-5.15, TOP, -0.5);
        this.boardGroup.add(asHeader);
        this.addBox(asHeader, 0.6, 0.42, 1.15, this.mats.plastic, 0, 0.21, 0, 0.04);
        this.addBox(asHeader, 0.5, 0.18, 0.95, this.mats.dark, 0, 0.42, 0, 0.02);
        this.addHeaderPins(asHeader, 5, 0.42, 0.42);

        const jtag = new THREE.Group();
        jtag.position.set(-5.15, TOP, 1.7);
        this.boardGroup.add(jtag);
        this.addBox(jtag, 0.6, 0.42, 1.15, this.mats.plastic, 0, 0.21, 0, 0.04);
        this.addBox(jtag, 0.5, 0.18, 0.95, this.mats.dark, 0, 0.42, 0, 0.02);
        this.addHeaderPins(jtag, 5, 0.42, 0.42);

        // Reset key, bottom-left.
        const rst = new THREE.Group();
        rst.position.set(-4.9, TOP, 3.4);
        this.boardGroup.add(rst);
        this.addBox(rst, 0.42, 0.18, 0.42, this.mats.plastic, 0, 0.09, 0, 0.02);
        this.addCylinder(rst, 0.12, 0.12, 0.08, this.mats.steel, 0, 0.2, 0, 16);

        // PS/2 mini-DIN, top-right corner.
        const ps2 = new THREE.Group();
        ps2.position.set(5.05, TOP, -3.35);
        this.boardGroup.add(ps2);
        this.addCylinder(ps2, 0.4, 0.36, 0.34, this.mats.plastic, 0, 0.17, 0, 26);
        this.addCylinder(ps2, 0.34, 0.34, 0.05, this.mats.dark, 0, 0.31, 0, 26);
        this.addBox(ps2, 0.1, 0.06, 0.16, this.mats.dark, 0, 0.33, 0.1, 0.01);

        // RS232 DB9 (male), right edge.
        const rs232 = new THREE.Group();
        rs232.position.set(5.3, TOP, -1.6);
        rs232.rotation.y = Math.PI / 2;
        this.boardGroup.add(rs232);
        this.addBox(rs232, 1.1, 0.5, 0.85, this.mats.silver, 0, 0.25, 0, 0.04);
        this.addBox(rs232, 0.1, 0.36, 0.66, this.mats.dark, 0.5, 0.25, 0, 0.02);
        for (let i = 0; i < 9; i += 1) {
            this.addCylinder(rs232, 0.03, 0.03, 0.1, this.mats.gold, 0.52, 0.18 + (i % 3) * 0.14, -0.28 + Math.floor(i / 3) * 0.28, 8);
        }

        // Buzzer (passive speaker), centre.
        const buzzer = new THREE.Group();
        buzzer.position.set(1.7, TOP, -0.5);
        this.boardGroup.add(buzzer);
        this.addCylinder(buzzer, 0.35, 0.35, 0.3, this.mats.dark, 0, 0.15, 0, 26);
        this.addCylinder(buzzer, 0.3, 0.3, 0.03, this.mats.steel, 0, 0.31, 0, 26);
        this.addCylinder(buzzer, 0.06, 0.06, 0.05, this.mats.dark, 0, 0.33, 0, 12);

        // VGA D-SUB 15 (blue), right edge.
        const vga = new THREE.Group();
        vga.position.set(5.15, TOP, 2.1);
        vga.rotation.y = Math.PI / 2;
        this.boardGroup.add(vga);
        this.addBox(vga, 1.45, 0.52, 1.05, this.mats.blue, 0, 0.26, 0, 0.04);
        this.addBox(vga, 0.12, 0.4, 0.86, this.mats.dark, 0.7, 0.26, 0, 0.02);
        for (let row = 0; row < 3; row += 1) {
            for (let i = 0; i < 5; i += 1) {
                this.addCylinder(vga, 0.035, 0.035, 0.12, this.mats.gold, 0.72, 0.1 + row * 0.16, -0.4 + i * 0.2, 10);
            }
        }

        // Infrared receiver, bottom-right corner.
        const ir = new THREE.Group();
        ir.position.set(5.2, TOP, 3.7);
        this.boardGroup.add(ir);
        this.addBox(ir, 0.34, 0.3, 0.28, this.mats.dark, 0, 0.15, 0, 0.03);
        this.addCylinder(ir, 0.13, 0.13, 0.06, this.mats.plasticSoft, 0, 0.31, 0, 16);
    }

    addHeaderPins(group, rows, span, y) {
        const pinGeo = new THREE.BoxGeometry(0.05, 0.12, 0.05);
        const pins = new THREE.InstancedMesh(pinGeo, this.mats.gold, rows * 2);
        const matrix = new THREE.Matrix4();
        let idx = 0;
        for (const x of [-0.12, 0.12]) {
            for (let i = 0; i < rows; i += 1) {
                matrix.makeTranslation(x, y + 0.1, -span + i * ((span * 2) / (rows - 1)));
                pins.setMatrixAt(idx, matrix);
                idx += 1;
            }
        }
        pins.castShadow = true;
        group.add(pins);
    }

    buildSwitches() {
        // Red 4-position DIP switch (wired to the same nets as the keys).
        const dip = new THREE.Group();
        dip.position.set(2.2, TOP, 1.55);
        this.boardGroup.add(dip);
        this.addBox(dip, 1.0, 0.22, 0.44, this.mats.red, 0, 0.11, 0, 0.03);
        this.addBox(dip, 0.92, 0.04, 0.3, this.mats.dark, 0, 0.2, 0, 0.005);
        for (let i = 0; i < 4; i += 1) {
            const slider = this.addBox(dip, 0.16, 0.09, 0.16, this.mats.white.clone(), -0.33 + i * 0.22, 0.26, 0, 0.01);
            const cell = { port: null, bit: i, slider, baseZ: slider.position.z };
            this.switchCells.push(cell);
            slider.userData.interactive = { kind: "switch", index: i, cell };
            this.interactive.push(slider);
        }
    }

    buildKeys() {
        // Four tactile keys (KEY[3:0]) along the bottom-right edge.
        for (let i = 0; i < 4; i += 1) {
            const group = new THREE.Group();
            group.position.set(2.25 + i * 0.55, TOP, 3.55);
            this.boardGroup.add(group);
            const body = this.addBox(group, 0.44, 0.2, 0.44, this.mats.red.clone(), 0, 0.1, 0, 0.03);
            this.addCylinder(group, 0.13, 0.13, 0.06, this.mats.steel, 0, 0.22, 0, 18);
            const actuator = this.addCylinder(group, 0.1, 0.1, 0.05, this.mats.plasticSoft.clone(), 0, 0.26, 0, 18);
            const cell = { port: null, bit: i, actuator, baseY: actuator.position.y };
            this.keyCells.push(cell);
            body.userData.interactive = { kind: "key", index: i, cell };
            actuator.userData.interactive = { kind: "key", index: i, cell };
            this.interactive.push(body, actuator);
        }
    }

    buildLeds() {
        // Four red LEDs along the bottom edge.
        for (let i = 0; i < 4; i += 1) {
            const group = new THREE.Group();
            group.position.set(-0.75 + i * 0.5, TOP, 3.55);
            this.boardGroup.add(group);
            this.addBox(group, 0.3, 0.1, 0.22, this.mats.plasticSoft, 0, 0.05, 0, 0.01);
            const material = new THREE.MeshPhysicalMaterial({
                color: this.mats.ledOff,
                emissive: 0xff2a12,
                emissiveIntensity: 0,
                roughness: 0.22,
                metalness: 0.05,
                clearcoat: 0.7,
                clearcoatRoughness: 0.2,
            });
            this.addBox(group, 0.2, 0.08, 0.16, material, 0, 0.13, 0, 0.01);
            const glow = this.addGlow(group, 0xff3a1e, 0, 0.24, 0, 0.6);
            this.ledCells.push({ port: null, bit: i, material, glow });
        }
    }

    // A single canvas texture carrying the board's silkscreen: copper traces,
    // the Cyclone IV logo, the board name and every component designator.
    buildSilkscreen() {
        const CW = 1200;
        const CH = 900;
        const canvas = document.createElement("canvas");
        canvas.width = CW;
        canvas.height = CH;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, CW, CH);
        const px = (x) => ((x + BOARD_W / 2) / BOARD_W) * CW;
        const py = (z) => ((z + BOARD_D / 2) / BOARD_D) * CH;
        const U = CW / BOARD_W; // pixels per world unit

        // Decorative copper traces fanning out of the FPGA toward the headers.
        ctx.strokeStyle = "rgba(150,120,60,0.16)";
        ctx.lineWidth = 2;
        for (let i = 0; i < 14; i += 1) {
            const sx = px(-1.6 + (i - 7) * 0.12);
            ctx.beginPath();
            ctx.moveTo(sx, py(0.4));
            ctx.lineTo(sx, py(i % 2 ? -1.25 : 2.05));
            ctx.stroke();
        }
        for (let i = 0; i < 8; i += 1) {
            const sz = py(0.4 + (i - 4) * 0.14);
            ctx.beginPath();
            ctx.moveTo(px(-1.6), sz);
            ctx.lineTo(px(0.55), sz);
            ctx.stroke();
        }

        const label = (text, x, z, size = 15, color = "rgba(206,222,233,0.82)", rot = 0, weight = 600) => {
            ctx.save();
            ctx.translate(px(x), py(z));
            if (rot) ctx.rotate(rot);
            ctx.fillStyle = color;
            ctx.font = `${weight} ${size}px "Cascadia Code", Consolas, monospace`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(text, 0, 0);
            ctx.restore();
        };
        const outline = (x, z, w, d) => {
            ctx.strokeStyle = "rgba(200,216,226,0.32)";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(px(x - w / 2), py(z - d / 2), w * U, d * U);
        };

        // Branding.
        label("Cyclone IV", 2.35, -0.95, 34, "rgba(226,238,246,0.92)", 0, 700);
        label("ALTERA", -1.6, -0.95, 16, "rgba(210,226,236,0.8)", 0, 700);
        label("RZ-EasyFPGA A2.2", 3.1, -4.15, 17, "rgba(226,238,246,0.9)", 0, 700);
        label("www.rzrd.net", -3.0, -3.95, 12, "rgba(180,198,210,0.7)");

        // IC designators + outlines.
        outline(-1.6, 0.4, 2.5, 2.5);
        label("U5", -3.0, -0.7, 13);
        outline(-2.1, 3.25, 1.9, 0.85);
        label("U6  SDRAM", -2.1, 3.95, 13);
        outline(-4.2, 0.3, 0.6, 0.45);
        label("U7", -4.2, 0.75, 12);
        label("EPCS16", -4.2, -0.05, 11);
        outline(1.3, 3.45, 0.5, 0.38);
        label("U8", 1.3, 3.95, 12);
        label("AT24C08", 1.3, 3.05, 10);
        outline(3.6, -0.1, 0.5, 0.38);
        label("U9  LM75", 3.6, 0.4, 12);
        outline(3.3, -1.4, 0.66, 0.55);
        label("U4", 3.3, -1.95, 12);
        label("MAX3232", 3.3, -0.95, 10);
        label("U1 U2 U3", -4.6, -1.0, 11);
        label("3.3V 2.5V 1.2V", -4.6, -2.55, 10);
        label("Y1  50MHz", -3.5, 1.35, 11);

        // Headers.
        label("P1", -4.0, -1.25, 13);
        label("P2", -4.0, 2.05, 13);
        label("P3", 0.55, -0.85, 13);
        label("AS", -5.15, -1.05, 12);
        label("JTAG", -5.15, 2.35, 12);
        label("LCD 1602 / 12864", -1.2, -3.5, 12);
        label("SEG / DIG", 2.4, -2.55, 12);

        // Peripherals.
        label("POWER", -5.15, -3.35, 11);
        label("USB", -3.6, -3.4, 11);
        label("5V", -5.4, -2.2, 11);
        label("PS/2", 5.05, -2.75, 11);
        label("RS232", 5.3, -0.85, 11);
        label("VGA", 5.15, 1.35, 12);
        label("BUZZER", 1.7, 0.15, 11);
        label("DIP", 2.2, 1.05, 12);
        label("ON", 2.2, 2.0, 10);
        label("RESET", -4.9, 3.9, 11);
        label("LED1  2  3  4", 0.0, 3.05, 11);
        label("KEY1  2  3  4", 3.05, 3.05, 11);
        label("IR", 5.2, 3.2, 11);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_D), material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = TOP + 0.004;
        mesh.renderOrder = 1;
        this.boardGroup.add(mesh);
    }

    // --------------------------------------------------------------- display
    buildDisplay() {
        const group = new THREE.Group();
        group.position.copy(DISPLAY_POS);
        this.boardGroup.add(group);
        this.displayGroup = group;

        this.addBox(group, 3.05, 0.16, 1.2, this.mats.plastic, 0, 0.08, 0, 0.03);
        this.addBox(group, 2.85, 0.03, 1.05, this.mats.dark, 0, 0.165, 0, 0.008);

        const hGeo = new THREE.BoxGeometry(0.3, 0.02, 0.1);
        const vGeo = new THREE.BoxGeometry(0.1, 0.02, 0.3);
        const dpGeo = new THREE.BoxGeometry(0.09, 0.02, 0.09);
        const definitions = [
            ["a", 0, 0.24, hGeo],
            ["b", 0.15, 0.12, vGeo],
            ["c", 0.15, -0.12, vGeo],
            ["d", 0, -0.24, hGeo],
            ["e", -0.15, -0.12, vGeo],
            ["f", -0.15, 0.12, vGeo],
            ["g", 0, 0, hGeo],
        ];

        for (let digit = 0; digit < 4; digit += 1) {
            const x = -1.05 + digit * 0.7;
            this.addBox(group, 0.56, 0.02, 0.74, this.mats.chip, x, 0.18, 0, 0.005);

            const segments = {};
            for (const [name, dx, dy, geometry] of definitions) {
                const material = new THREE.MeshPhysicalMaterial({
                    color: 0x2a0a07,
                    emissive: 0xff2a12,
                    emissiveIntensity: 0,
                    roughness: 0.34,
                    metalness: 0.0,
                    clearcoat: 0.6,
                    clearcoatRoughness: 0.3,
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.position.set(x + dx, 0.2, dy);
                mesh.castShadow = false;
                group.add(mesh);
                segments[name] = material;
            }

            const dpMaterial = new THREE.MeshPhysicalMaterial({
                color: 0x2a0a07,
                emissive: 0xffb02e,
                emissiveIntensity: 0,
                roughness: 0.34,
                clearcoat: 0.6,
            });
            const dp = new THREE.Mesh(dpGeo, dpMaterial);
            dp.position.set(x + 0.31, 0.2, -0.26);
            group.add(dp);
            segments.dp = dpMaterial;

            const glow = this.addGlow(group, 0xff2a12, x, 0.42, 0, 0.85);
            this.digitSegments.push({ segments, glow });
        }

        // Twelve through-hole pins along the bottom of the tube.
        for (let i = 0; i < 6; i += 1) {
            this.addBox(group, 0.07, 0.07, 0.22, this.mats.gold, -1.3 + i * 0.52, 0.05, 0.48, 0.01);
            this.addBox(group, 0.07, 0.07, 0.22, this.mats.gold, -1.3 + i * 0.52, 0.05, 0.7, 0.01);
        }

        const label = new THREE.Mesh(
            new THREE.PlaneGeometry(1.3, 0.2),
            new THREE.MeshBasicMaterial({
                map: this.makeTextTexture("4-DIGIT MULTIPLEX", { color: "#c9d8e2", size: 34 }),
                transparent: true,
                depthWrite: false,
                toneMapped: false,
            })
        );
        label.rotation.x = -Math.PI / 2;
        label.position.set(0, 0.185, 0.44);
        group.add(label);
    }

    // -------------------------------------------------------------- design
    setDesign(entity, board) {
        this.entity = entity;
        this.board = board;
        this.clearFrame();

        if (!entity || !board) {
            this.displayMode = "blank";
            return;
        }

        const byName = {};
        for (const port of entity.ports) byName[port.name] = port;
        const displays = (board.displays || []).map((name) => byName[name]).filter(Boolean);
        const digits = (board.digits || []).map((name) => byName[name]).filter(Boolean);
        this.displayPorts = displays;
        this.digitPort = digits[0] || null;

        if (!displays.length) this.displayMode = "blank";
        else if (displays.length >= 4) this.displayMode = "direct";
        else if (this.digitPort) this.displayMode = "multiplexed";
        else this.displayMode = "static";

        // Attach port names to LED/switch/key cells, expanding vectors bit
        // by bit (LEDR[9:0] drives the 10 LED cells, SW[9:0] the 10 sliders).
        const assignCells = (cells, portNames) => {
            cells.forEach((cell) => { cell.port = null; cell.bit = 0; });
            let index = 0;
            for (const portName of portNames) {
                const port = byName[portName];
                if (!port) continue;
                const bits = Math.min(port.width || 1, 16);
                for (let bit = 0; bit < bits && index < cells.length; bit += 1) {
                    cells[index].port = portName;
                    cells[index].bit = bit;
                    index += 1;
                }
            }
        };
        assignCells(this.ledCells, board.leds || []);
        assignCells(this.switchCells, board.switches || []);
        assignCells(this.keyCells, board.buttons || []);

        // Board polarity from the RZ-EasyFPGA A2.2 profile (board.json):
        // common-anode tube, SEG/DIG active-low, SEG0=b, SEG1=a, ... SEG7=dp.
        const ledConfig = board.ledConfig || {};
        this.ledActiveLow = ledConfig.activeLow !== false;
        const disp = board.displayConfig || {};
        this.segActiveLow = disp.segmentActiveLow !== false;
        this.digitActiveLow = disp.digitActiveLow !== false;
        // board.json wins; legacy fallback = SEG0=a … SEG7=dp.
        this.segBitMap = disp.segBitMap || { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 };
    }

    clearFrame() {
        this.values = {};
        this.latched = [0, 0, 0, 0, 0, 0];
        this.latchedSeen = [false, false, false, false, false, false];
        this.glow = [0, 0, 0, 0, 0, 0];
        this.directValues = [0, 0, 0, 0, 0, 0];
        this.staticValue = 0;
        this.lastHex = 0;
        this.lastDig = 0;
        this.activeDigit = -1;
        this.ledCells.forEach((cell) => this.setLed(cell, false));
        this.switchCells.forEach((cell) => this.setSwitch(cell, false));
        this.keyCells.forEach((cell) => this.setKey(cell, false));
        for (let i = 0; i < this.digitSegments.length; i += 1) this.setDigit(i, 0, 0);
        this.emitReadout(true);
    }

    valueFrom(source, name) {
        if (!source || !name) return 0;
        if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
        const lower = name.toLowerCase();
        for (const key of Object.keys(source)) {
            if (key.toLowerCase() === lower) return source[key];
        }
        return 0;
    }

    value(name) {
        return this.valueFrom(this.values, name);
    }

    setCycles(cycles) {
        if (this.displayMode !== "multiplexed" || !this.digitPort || !this.displayPorts[0]) return;
        for (const cycle of cycles || []) {
            const dig = toInt(this.valueFrom(cycle.values, this.digitPort.name));
            const hex = toInt(this.valueFrom(cycle.values, this.displayPorts[0].name));
            const active = decodeActiveDigit(dig, this.digitPort.width || 4);
            if (active >= 0 && active < 4) {
                this.latched[active] = hex;
                this.latchedSeen[active] = true;
            }
        }
    }

    setFrame(values, meta = {}) {
        this.values = values || {};
        if (typeof meta.cycleIndex === "number") this.lastCycleIndex = meta.cycleIndex;

        for (const cell of this.ledCells) {
            const raw = this.value(cell.port);
            const unknown = typeof raw === "string" && /[xz]/i.test(raw);
            const bit = (toInt(raw) >>> cell.bit) & 1;
            const lit = this.ledActiveLow ? bit === 0 && !unknown : bit === 1 && !unknown;
            this.setLed(cell, lit, unknown);
        }
        for (const cell of this.switchCells) {
            // DIP ON/closed reads 0 on this board.
            this.setSwitch(cell, bitAt(this.value(cell.port), cell.bit) === 0);
        }
        for (const cell of this.keyCells) {
            // A pressed key reads 0 on this board.
            this.setKey(cell, bitAt(this.value(cell.port), cell.bit) === 0);
        }

        if (this.displayMode === "multiplexed" && this.digitPort && this.displayPorts[0]) {
            const dig = toInt(this.value(this.digitPort.name));
            const hex = toInt(this.value(this.displayPorts[0].name));
            const active = decodeActiveDigit(dig, this.digitPort.width || 4);
            if (active >= 0 && active < 4) {
                this.latched[active] = hex;
                this.latchedSeen[active] = true;
                this.lastHex = hex;
                this.lastDig = dig;
                this.activeDigit = active;
            }
        } else if (this.displayMode === "direct") {
            this.directValues = this.displayPorts.slice(0, 4).map((port) => toInt(this.value(port.name)));
            this.lastHex = this.directValues[0] || 0;
        } else if (this.displayMode === "static" && this.displayPorts[0]) {
            this.staticValue = toInt(this.value(this.displayPorts[0].name));
            this.lastHex = this.staticValue;
        }
    }

    setLed(cell, on, unknown = false) {
        if (!cell.material) return;
        cell._on = on;
        cell._unknown = unknown;
        const g = this.glowScale;
        if (unknown) {
            // X/Z/U: striped blue-grey, clearly neither on nor off.
            cell.material.color.setHex(0x27415c);
            cell.material.emissiveIntensity = 0.5 * g;
            cell.glow.material.opacity = 0.25 * g;
            cell.glow.scale.setScalar(0.8);
            return;
        }
        cell.material.color.setHex(on ? this.mats.ledOn : this.mats.ledOff);
        cell.material.emissiveIntensity = on ? 2.9 * g : 0;
        cell.glow.material.opacity = on ? 0.8 * g : 0;
        cell.glow.scale.setScalar(on ? 0.95 : 0.7);
    }

    setSwitch(cell, on) {
        if (!cell.slider) return;
        cell.slider.position.z = cell.baseZ + (on ? 0.055 : -0.055);
    }

    setKey(cell, on) {
        if (!cell.actuator) return;
        cell.actuator.position.y = cell.baseY - (on ? 0.035 : 0);
    }

    setDigit(index, value, intensity) {
        const digit = this.digitSegments[index];
        if (!digit) return;
        const unknown = typeof value === "string" && /[xz]/i.test(value);
        const v = toInt(value);
        const lit = clamp(intensity, 0, 1);
        const map = this.segBitMap || { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 };
        const activeLow = this.segActiveLow;
        let count = 0;
        for (let i = 0; i < 7; i += 1) {
            const name = "abcdefg"[i];
            const material = digit.segments[name];
            const bit = (v >>> map[name]) & 1;
            const on = !unknown && (activeLow ? bit === 0 : bit === 1);
            material.emissiveIntensity = on ? 3.1 * lit * this.glowScale : unknown ? 0.12 : 0;
            material.color.setHex(on ? 0xff5a3a : unknown ? 0x27415c : 0x2a0a07);
            if (on) count += 1;
        }
        const dpBit = (v >>> 7) & 1;
        const dpOn = !unknown && (activeLow ? dpBit === 0 : dpBit === 1);
        digit.segments.dp.emissiveIntensity = dpOn ? 2.6 * lit * this.glowScale : unknown ? 0.12 : 0;
        digit.segments.dp.color.setHex(dpOn ? 0xffb02e : unknown ? 0x27415c : 0x2a0a07);
        if (dpOn) count += 1;
        digit.glow.material.opacity = lit * (count / 8) * 0.5 * this.glowScale;
        digit.glow.scale.setScalar(0.85 + (count / 8) * 0.6);
    }

    updateDisplay(dt) {
        const decay = Math.exp(-dt / 0.085);
        if (this.displayMode === "multiplexed") {
            const index = Math.floor(performance.now() / (1000 / this.scanHz)) % 4;
            for (let i = 0; i < 4; i += 1) {
                if (i === index && this.latchedSeen[i]) this.glow[i] = 1;
                else this.glow[i] *= decay;
                this.setDigit(i, this.latched[i], this.glow[i]);
            }
            this.activeDigit = index;
        } else if (this.displayMode === "direct") {
            for (let i = 0; i < this.digitSegments.length; i += 1) {
                this.setDigit(i, this.directValues[i] || 0, 1);
            }
            this.activeDigit = -1;
        } else if (this.displayMode === "static") {
            for (let i = 0; i < this.digitSegments.length; i += 1) this.setDigit(i, this.staticValue, 1);
            this.activeDigit = -1;
        } else {
            for (let i = 0; i < this.digitSegments.length; i += 1) this.setDigit(i, 0, 0);
            this.activeDigit = -1;
        }
    }

    getInfo() {
        return {
            mode: this.displayMode,
            displays: this.displayPorts.map((port) => port.name),
            digitPort: this.digitPort ? this.digitPort.name : null,
            active: this.activeDigit,
            hex: this.lastHex,
            dig: this.lastDig,
            scanHz: this.scanHz,
        };
    }

    emitReadout(force = false) {
        if (!this.onReadout) return;
        const now = performance.now();
        if (!force && now - this.readoutTimer < 90) return;
        this.readoutTimer = now;
        const info = this.getInfo();
        const key = JSON.stringify(info);
        if (!force && key === this.lastReadout) return;
        this.lastReadout = key;
        this.onReadout(info);
    }

    // -------------------------------------------------------------- camera
    tweenCamera(position, target, duration = 0.85) {
        this.camTween = {
            fromPosition: this.camera.position.clone(),
            toPosition: position.clone(),
            fromTarget: this.controls.target.clone(),
            toTarget: target.clone(),
            elapsed: 0,
            duration,
        };
    }

    focusDisplay() {
        this.tweenCamera(new THREE.Vector3(5.2, 4.6, 1.2), new THREE.Vector3(2.4, 0.4, -3.0), 0.9);
    }

    resetView() {
        this.tweenCamera(this.homePosition, this.homeTarget, 0.9);
    }

    // ----------------------------------------------------------- interaction
    setupInteraction() {
        const el = this.renderer.domElement;
        this._onPointerMove = (e) => this.handlePointerMove(e);
        this._onPointerDown = (e) => { this._pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() }; };
        this._onPointerUp = (e) => this.handlePointerUp(e);
        this._onPointerLeave = () => { this.clearHover(); if (this.onHover) this.onHover(null); };
        el.addEventListener("pointermove", this._onPointerMove);
        el.addEventListener("pointerdown", this._onPointerDown);
        el.addEventListener("pointerup", this._onPointerUp);
        el.addEventListener("pointerleave", this._onPointerLeave);
    }

    pickInteractive(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this.interactive, false);
        return hits.length ? hits[0].object : null;
    }

    handlePointerMove(e) {
        if (!this.active) return;
        const obj = this.pickInteractive(e);
        if (obj !== this.hovered) {
            this.clearHover();
            if (obj) {
                this.hovered = obj;
                const m = obj.material;
                if (m && m.emissive) {
                    m.userData._he = m.emissive.getHex();
                    m.userData._hi = m.emissiveIntensity;
                    m.emissive.setHex(0x3d9bff);
                    m.emissiveIntensity = 0.6;
                }
                this.renderer.domElement.style.cursor = "pointer";
            }
        }
        if (this.onHover) {
            if (obj) {
                const info = obj.userData.interactive;
                const label = info.kind === "switch" ? `DIP ${info.index + 1} · click to toggle` : `KEY ${info.index + 1} · click to press`;
                this.onHover(label, e.clientX, e.clientY);
            } else {
                this.onHover(null);
            }
        }
    }

    clearHover() {
        if (this.hovered) {
            const m = this.hovered.material;
            if (m && m.emissive && m.userData._he !== undefined) {
                m.emissive.setHex(m.userData._he);
                m.emissiveIntensity = m.userData._hi;
            }
            this.hovered = null;
        }
        this.renderer.domElement.style.cursor = "";
    }

    handlePointerUp(e) {
        const d = this._pointerDown;
        this._pointerDown = null;
        if (!d || !this.active) return;
        const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
        if (dist > 6 || performance.now() - d.t > 500) return; // orbit drag, not a click
        const obj = this.pickInteractive(e);
        if (obj && this.onToggle) {
            const info = obj.userData.interactive;
            this.onToggle(info.kind, info.index);
        }
    }

    // ----------------------------------------------------------- peripherals
    attachPeripheral(id, type, opts = {}) {
        if (this.peripherals.has(id)) this.detachPeripheral(id);
        const slot = this.periphSlots[this.peripherals.size % this.periphSlots.length];
        const group = new THREE.Group();
        group.position.copy(slot);
        this.scene.add(group);
        const entry = { id, type, group, slot, label: opts.label || type.toUpperCase(), state: {} };
        this.buildPeripheralModule(entry);
        this.buildPeriphCable(entry);
        this.peripherals.set(id, entry);
        this.renderer.shadowMap.needsUpdate = true;
        return entry;
    }

    buildPeripheralModule(entry) {
        const g = entry.group;
        this.addBox(g, 1.8, 0.1, 1.3, this.mats.pcb.clone(), 0, 0.05, 0, 0.04);
        this.addBox(g, 1.7, 0.02, 1.2, this.mats.dark.clone(), 0, 0.11, 0, 0.02);
        const lbl = new THREE.Mesh(
            new THREE.PlaneGeometry(1.5, 0.3),
            new THREE.MeshBasicMaterial({ map: this.makeTextTexture(entry.label, { color: "#9ad2ff", size: 30 }), transparent: true, depthWrite: false, toneMapped: false })
        );
        lbl.rotation.x = -Math.PI / 2;
        lbl.position.set(0, 0.122, 0.45);
        g.add(lbl);

        if (entry.type === "ledbar") {
            entry.leds = [];
            for (let i = 0; i < 8; i += 1) {
                const mat = new THREE.MeshPhysicalMaterial({ color: 0x2a0c0a, emissive: 0xff2a12, emissiveIntensity: 0, roughness: 0.25, clearcoat: 0.7 });
                this.addBox(g, 0.14, 0.08, 0.14, mat, -0.7 + i * 0.2, 0.16, -0.12, 0.02);
                const glow = this.addGlow(g, 0xff3a1e, -0.7 + i * 0.2, 0.26, -0.12, 0.4);
                entry.leds.push({ mat, glow });
            }
        } else if (entry.type === "lcd") {
            this.addBox(g, 1.62, 0.12, 0.72, this.mats.plastic.clone(), 0, 0.16, -0.12, 0.02);
            const canvas = document.createElement("canvas");
            canvas.width = 256; canvas.height = 96;
            const ctx = canvas.getContext("2d");
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.46, 0.56), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
            screen.rotation.x = -Math.PI / 2;
            screen.position.set(0, 0.225, -0.12);
            g.add(screen);
            entry.lcd = { canvas, ctx, tex };
            this.drawLcd(entry, "READY");
        } else if (entry.type === "servo") {
            this.addBox(g, 0.72, 0.5, 0.52, this.mats.blue.clone(), 0, 0.35, -0.12, 0.03);
            this.addCylinder(g, 0.42, 0.42, 0.04, this.mats.dark.clone(), 0, 0.62, -0.12, 24);
            const horn = new THREE.Group();
            horn.position.set(0, 0.66, -0.12);
            g.add(horn);
            this.addBox(horn, 0.92, 0.05, 0.12, this.mats.white.clone(), 0, 0, 0, 0.02);
            this.addCylinder(horn, 0.1, 0.1, 0.08, this.mats.steel.clone(), 0, 0.02, 0, 16);
            entry.horn = horn;
            entry.angle = 0;
            entry.targetAngle = 0;
        } else if (entry.type === "bargraph") {
            entry.bars = [];
            for (let i = 0; i < 10; i += 1) {
                const mat = new THREE.MeshPhysicalMaterial({ color: 0x0c1a12, emissive: 0x35d06a, emissiveIntensity: 0, roughness: 0.3, clearcoat: 0.6 });
                this.addBox(g, 0.15, 0.06, 0.14, mat, -0.72 + i * 0.16, 0.15, -0.12, 0.01);
                entry.bars.push(mat);
            }
        }
    }

    buildPeriphCable(entry) {
        const s = entry.slot;
        const start = new THREE.Vector3(s.x, TOP + 0.16, s.z + 0.65);
        const mid = new THREE.Vector3(s.x * 0.72, TOP + 0.55, (s.z - 4.5) / 2);
        const end = new THREE.Vector3(s.x * 0.5, TOP + 0.22, -4.4);
        const curve = new THREE.CatmullRomCurve3([start, mid, end]);
        const geo = new THREE.TubeGeometry(curve, 22, 0.06, 6, false);
        const cable = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x33404f, roughness: 0.7 }));
        cable.castShadow = true;
        this.scene.add(cable);
        entry.cable = cable;
    }

    drawLcd(entry, text) {
        const { ctx, canvas, tex } = entry.lcd;
        ctx.fillStyle = "#0a3a2a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#7dffb0";
        ctx.font = "bold 30px 'Cascadia Code', Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(text).slice(0, 16), canvas.width / 2, canvas.height / 2);
        tex.needsUpdate = true;
    }

    updatePeripheral(id, value, meta = {}) {
        const e = this.peripherals.get(id);
        if (!e) return;
        const v = toInt(value);
        if (e.type === "ledbar") {
            const activeLow = meta.activeLow !== false;
            for (let i = 0; i < 8; i += 1) {
                const bit = (v >>> i) & 1;
                const on = activeLow ? bit === 0 : bit === 1;
                e.leds[i].mat.emissiveIntensity = on ? 2.6 * this.glowScale : 0;
                e.leds[i].mat.color.setHex(on ? 0xff3a24 : 0x2a0c0a);
                e.leds[i].glow.material.opacity = on ? 0.7 * this.glowScale : 0;
            }
        } else if (e.type === "lcd") {
            const text = meta.text != null ? meta.text : "0x" + v.toString(16).toUpperCase();
            this.drawLcd(e, text);
        } else if (e.type === "servo") {
            const max = meta.max || 255;
            e.targetAngle = (clamp(v / max, 0, 1) - 0.5) * Math.PI;
        } else if (e.type === "bargraph") {
            const max = meta.max || 255;
            const level = Math.round(clamp(v / max, 0, 1) * 10);
            for (let i = 0; i < 10; i += 1) {
                const on = i < level;
                const col = i < 6 ? 0x35d06a : i < 8 ? 0xffb02e : 0xff5247;
                e.bars[i].emissive.setHex(col);
                e.bars[i].emissiveIntensity = on ? 2.2 * this.glowScale : 0;
                e.bars[i].color.setHex(on ? col : 0x0c1a12);
            }
        }
        e.state = { value: v, meta };
    }

    detachPeripheral(id) {
        const e = this.peripherals.get(id);
        if (!e) return;
        this.scene.remove(e.group);
        e.group.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        if (e.lcd) e.lcd.tex.dispose();
        if (e.cable) {
            this.scene.remove(e.cable);
            e.cable.geometry.dispose();
            e.cable.material.dispose();
        }
        this.peripherals.delete(id);
        this.renderer.shadowMap.needsUpdate = true;
    }

    // --------------------------------------------------------- scene controls
    setKeyLight(v) { if (this.keyLight) this.keyLight.intensity = v; }

    setGlow(v) {
        this.glowScale = v;
        for (const cell of this.ledCells) this.setLed(cell, cell._on, cell._unknown);
        for (const [id, e] of this.peripherals) this.updatePeripheral(id, (e.state && e.state.value) || 0, (e.state && e.state.meta) || {});
    }

    setFog(v) { if (this.scene.fog) this.scene.fog.density = v * 0.06; }

    setExposure(v) { this.renderer.toneMappingExposure = v; }

    setQuality(ratio) {
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratio));
        this.renderer.setSize(this.width, this.height);
    }

    setGrid(on) { if (this.grid) this.grid.visible = Boolean(on); }

    setGhost(on) {
        this.ghost = Boolean(on);
        const apply = (root) => root.traverse((o) => {
            if (o.material && o.material.isMaterial && "wireframe" in o.material) o.material.wireframe = this.ghost;
        });
        apply(this.boardGroup);
        for (const [, e] of this.peripherals) apply(e.group);
        this.renderer.shadowMap.needsUpdate = true;
    }

    setOrbitSpeed(v) { this.controls.autoRotateSpeed = v; }

    randomizeAngle() {
        const az = Math.random() * Math.PI * 2;
        const el = 0.5 + Math.random() * 0.55;
        const dist = 14 + Math.random() * 6;
        const pos = new THREE.Vector3(
            Math.cos(az) * Math.cos(el) * dist,
            Math.sin(el) * dist,
            Math.sin(az) * Math.cos(el) * dist
        );
        this.tweenCamera(pos, this.homeTarget, 0.8);
    }

    resetScene() {
        this.setKeyLight(2.35);
        this.setGlow(1);
        this.setFog(0.35);
        this.setExposure(1.08);
        this.setOrbitSpeed(0.55);
        this.setGrid(false);
        this.setGhost(false);
        this.controls.autoRotate = false;
        this.resetView();
    }

    setActive(active) {
        this.active = Boolean(active);
        if (active) {
            this.resize();
        }
    }

    setAutoRotate(enabled) {
        this.controls.autoRotate = Boolean(enabled);
    }

    resize() {
        if (!this.ok) return;
        const width = Math.max(1, this.container.clientWidth);
        const height = Math.max(1, this.container.clientHeight);
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    updateAtmosphere(dt) {
        if (this.particles && !this.reducedMotion) {
            const pos = this.particles.geometry.attributes.position;
            const speeds = this.particles.userData.speeds;
            for (let i = 0; i < speeds.length; i += 1) {
                let y = pos.getY(i) + speeds[i] * dt;
                if (y > 12.5) y = 0.5;
                pos.setY(i, y);
            }
            pos.needsUpdate = true;
        }
        for (const [, e] of this.peripherals) {
            if (e.type === "servo" && e.horn) {
                e.angle += (e.targetAngle - e.angle) * Math.min(1, dt * 6);
                e.horn.rotation.y = e.angle;
            }
        }
    }

    animate() {
        this.frame = requestAnimationFrame(this.animate);
        const dt = Math.min(0.05, this.clock.getDelta());
        this.controls.update();

        if (this.camTween) {
            this.camTween.elapsed += dt;
            const t = clamp(this.camTween.elapsed / this.camTween.duration, 0, 1);
            const eased = t * t * (3 - 2 * t);
            this.camera.position.lerpVectors(this.camTween.fromPosition, this.camTween.toPosition, eased);
            this.controls.target.lerpVectors(this.camTween.fromTarget, this.camTween.toTarget, eased);
            if (t >= 1) this.camTween = null;
        }

        if (this.active && !document.hidden) {
            this.updateDisplay(dt);
            this.updateAtmosphere(dt);
            this.renderer.render(this.scene, this.camera);
        }
        this.emitReadout();
    }

    dispose() {
        if (this.frame) cancelAnimationFrame(this.frame);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        const el = this.renderer && this.renderer.domElement;
        if (el) {
            el.removeEventListener("pointermove", this._onPointerMove);
            el.removeEventListener("pointerdown", this._onPointerDown);
            el.removeEventListener("pointerup", this._onPointerUp);
            el.removeEventListener("pointerleave", this._onPointerLeave);
        }
        for (const id of [...this.peripherals.keys()]) this.detachPeripheral(id);
        if (this.particles) {
            this.particles.geometry.dispose();
            this.particles.material.dispose();
        }
        if (this.controls) this.controls.dispose();
        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
    }
}