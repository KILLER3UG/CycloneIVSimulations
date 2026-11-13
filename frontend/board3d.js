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
const DISPLAY_POS = new THREE.Vector3(2.35, TOP, -3.1);

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
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.08;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.domElement.className = "board3d-canvas-el";
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(36, this.width / this.height, 0.1, 200);
        this.homePosition = new THREE.Vector3(11.6, 10.6, 14.8);
        this.homeTarget = new THREE.Vector3(0, 0.55, 0);
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
                color: 0x0b0e13,
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

        this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x05080c, 0.55));

        const key = new THREE.DirectionalLight(0xfff0dd, 2.35);
        key.position.set(8, 14, 10);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = -10;
        key.shadow.camera.right = 10;
        key.shadow.camera.top = 10;
        key.shadow.camera.bottom = -10;
        key.shadow.camera.near = 1;
        key.shadow.camera.far = 40;
        key.shadow.bias = -0.0006;
        key.shadow.normalBias = 0.02;
        this.scene.add(key);

        const fill = new THREE.DirectionalLight(0x88bbff, 0.85);
        fill.position.set(-10, 7, -8);
        this.scene.add(fill);

        const rim = new THREE.DirectionalLight(0xffb36b, 0.7);
        rim.position.set(0, 6, -12);
        this.scene.add(rim);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(60, 60),
            new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.36 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.03;
        ground.receiveShadow = true;
        this.scene.add(ground);
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

    addSilk(text, x, z, width = 1.2, color = "#cfe0ea", y = TOP + 0.006) {
        const texture = this.makeTextTexture(text, { color, size: 46 });
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, y, z);
        this.boardGroup.add(mesh);
        return mesh;
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

        // Solder-mask inset and silkscreen border.
        const border = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(BOARD_W - 0.5, 0.004, BOARD_D - 0.5)),
            new THREE.LineBasicMaterial({ color: 0xa9c4d3, transparent: true, opacity: 0.28 })
        );
        border.position.y = TOP + 0.003;
        this.boardGroup.add(border);

        // Gold pads along the long edges.
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

        this.buildFpga();
        this.buildHeaders();
        this.buildMemory();
        this.buildPower();
        this.buildConnectors();
        this.buildSwitches();
        this.buildLeds();
        this.buildLabels();
    }

    buildFpga() {
        const group = new THREE.Group();
        group.position.set(0.15, TOP, 0.15);
        this.boardGroup.add(group);

        // Socket frame and 144-pin QFP.
        this.addBox(group, 2.72, 0.06, 2.72, this.mats.plasticSoft, 0, 0.03, 0, 0.05);
        this.addBox(group, 2.3, 0.17, 2.3, this.mats.chip, 0, 0.15, 0, 0.055);

        const pinGeo = new THREE.BoxGeometry(0.045, 0.035, 0.19);
        const pins = new THREE.InstancedMesh(pinGeo, this.mats.gold, 144);
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3(1, 1, 1);
        let idx = 0;
        for (let side = 0; side < 4; side += 1) {
            for (let i = 0; i < 36; i += 1) {
                const t = (i - 17.5) * (2.02 / 36);
                if (side === 0) {
                    position.set(t, 0.1, 1.19);
                    quaternion.identity();
                } else if (side === 1) {
                    position.set(t, 0.1, -1.19);
                    quaternion.identity();
                } else if (side === 2) {
                    position.set(1.19, 0.1, t);
                    quaternion.setFromAxisAngle(yAxis, Math.PI / 2);
                } else {
                    position.set(-1.19, 0.1, t);
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
        this.addCylinder(group, 0.065, 0.065, 0.012, this.mats.white, -0.88, 0.24, -0.88, 16);
        const label = new THREE.Mesh(
            new THREE.PlaneGeometry(1.55, 0.3875),
            new THREE.MeshBasicMaterial({
                map: this.makeTextTexture("EP4CE6E22C8N", { color: "#9fb2c0", size: 38 }),
                transparent: true,
                depthWrite: false,
                toneMapped: false,
            })
        );
        label.rotation.x = -Math.PI / 2;
        label.position.set(0, 0.238, 0.12);
        group.add(label);

        // Decoupling capacitors around the FPGA.
        for (const [x, z] of [[-1.5, 0.2], [-1.5, -1.3], [0.25, 0.2], [0.25, -1.3]]) {
            this.addBox(group, 0.14, 0.07, 0.09, this.mats.ceramic, x, 0.045, z, 0.01);
        }
    }

    buildMemory() {
        // SDRAM HY57V641620 (TSSOP-II, 54 pins) below-left of the FPGA.
        const sdram = new THREE.Group();
        sdram.position.set(-4.2, TOP, 3.0);
        this.boardGroup.add(sdram);
        this.addBox(sdram, 1.85, 0.12, 0.8, this.mats.chip, 0, 0.08, 0, 0.03);
        const sdramPinGeo = new THREE.BoxGeometry(0.04, 0.03, 0.13);
        const sdramPins = new THREE.InstancedMesh(sdramPinGeo, this.mats.gold, 54);
        const matrix = new THREE.Matrix4();
        let idx = 0;
        for (const z of [-0.34, 0.34]) {
            for (let i = 0; i < 27; i += 1) {
                matrix.makeTranslation(-0.9 + i * 0.0693, 0.04, z);
                sdramPins.setMatrixAt(idx, matrix);
                idx += 1;
            }
        }
        sdramPins.castShadow = true;
        sdram.add(sdramPins);
        this.addSilk("SDRAM", -4.2, 3.62, 0.7, "#cfe0ea", TOP + 0.006);

        // M25P16 SPI configuration flash near the AS header.
        const flash = new THREE.Group();
        flash.position.set(-4.5, TOP, -0.45);
        this.boardGroup.add(flash);
        this.addBox(flash, 0.55, 0.1, 0.4, this.mats.chip, 0, 0.06, 0, 0.02);
        for (let i = 0; i < 4; i += 1) {
            this.addBox(flash, 0.06, 0.04, 0.08, this.mats.silver, -0.18 + i * 0.12, 0.03, 0.22, 0.005);
            this.addBox(flash, 0.06, 0.04, 0.08, this.mats.silver, -0.18 + i * 0.12, 0.03, -0.22, 0.005);
        }
        this.addSilk("M25P16", -4.5, 0.18, 0.6, "#cfe0ea", TOP + 0.006);
    }

    buildPower() {
        // 50 MHz active crystal left of the FPGA.
        const crystal = new THREE.Group();
        crystal.position.set(-2.55, TOP, 0.15);
        this.boardGroup.add(crystal);
        this.addBox(crystal, 0.75, 0.16, 0.5, this.mats.silver, 0, 0.08, 0, 0.02);
        this.addBox(crystal, 0.5, 0.03, 0.3, this.mats.steel, 0, 0.165, 0, 0.005);
        this.addSilk("CLOCK_50", -2.55, 0.72, 0.6, "#cfe0ea", TOP + 0.006);

        // Two AMS1117 regulators and the bulk capacitors on the right.
        for (const [x, z] of [[4.0, -0.9], [4.0, -0.15]]) {
            const reg = new THREE.Group();
            reg.position.set(x, TOP, z);
            this.boardGroup.add(reg);
            this.addBox(reg, 0.5, 0.16, 0.42, this.mats.chip, 0, 0.08, 0, 0.02);
            this.addBox(reg, 0.26, 0.1, 0.3, this.mats.silver, 0, 0.2, 0, 0.01);
        }
        for (const [x, z] of [[4.0, 0.75], [4.7, 0.75], [5.4, 0.75]]) {
            this.addCylinder(this.boardGroup, 0.17, 0.17, 0.4, this.mats.plasticSoft, x, TOP + 0.2, z, 20);
            this.addCylinder(this.boardGroup, 0.14, 0.14, 0.014, this.mats.silver, x, TOP + 0.41, z, 20);
            this.addBox(this.boardGroup, 0.05, 0.32, 0.03, this.mats.white, x + 0.15, TOP + 0.2, z, 0.004);
        }
    }

    buildHeaders() {
        // Four 2x13 expansion headers ringing the FPGA (the yellow rows).
        const yellow = new THREE.MeshStandardMaterial({ color: 0xe3c231, roughness: 0.5, metalness: 0.05 });
        const specs = [
            { x: -0.9, z: -2.0, w: 4.0, vertical: false },
            { x: -0.9, z: 2.2, w: 4.0, vertical: false },
            { x: -3.2, z: 0.1, w: 4.0, vertical: true },
            { x: 3.0, z: 0.1, w: 4.0, vertical: true },
        ];
        for (const spec of specs) {
            const group = new THREE.Group();
            group.position.set(spec.x, TOP, spec.z);
            if (spec.vertical) group.rotation.y = Math.PI / 2;
            this.boardGroup.add(group);
            this.addBox(group, spec.w, 0.24, 0.46, yellow, 0, 0.12, 0, 0.04);
            this.addBox(group, spec.w - 0.08, 0.05, 0.3, this.mats.dark, 0, 0.25, 0, 0.005);
            const count = 13;
            const pinGeo = new THREE.BoxGeometry(0.05, 0.06, 0.05);
            const pins = new THREE.InstancedMesh(pinGeo, this.mats.gold, count * 2);
            const matrix = new THREE.Matrix4();
            let idx = 0;
            for (const row of [-0.12, 0.12]) {
                for (let i = 0; i < count; i += 1) {
                    matrix.makeTranslation(-spec.w / 2 + 0.16 + i * ((spec.w - 0.32) / (count - 1)), 0.27, row);
                    pins.setMatrixAt(idx, matrix);
                    idx += 1;
                }
            }
            pins.castShadow = true;
            group.add(pins);
        }
    }

    buildConnectors() {
        // USB Mini-B (power only) on the top edge.
        const usb = new THREE.Group();
        usb.position.set(-3.5, TOP, -4.0);
        this.boardGroup.add(usb);
        this.addBox(usb, 0.85, 0.4, 0.62, this.mats.silver, 0, 0.2, 0, 0.03);
        this.addBox(usb, 0.6, 0.22, 0.44, this.mats.dark, 0, 0.31, 0, 0.02);

        // LCD 12864/1602 header on the top edge.
        const lcd = new THREE.Group();
        lcd.position.set(-0.9, TOP, -4.05);
        this.boardGroup.add(lcd);
        this.addBox(lcd, 3.4, 0.24, 0.5, this.mats.plastic, 0, 0.12, 0, 0.03);
        const lcdPins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), this.mats.gold, 20);
        const lm = new THREE.Matrix4();
        for (let i = 0; i < 20; i += 1) {
            lm.makeTranslation(-1.6 + i * 0.168, 0.3, 0);
            lcdPins.setMatrixAt(i, lm);
        }
        lcdPins.castShadow = true;
        lcd.add(lcdPins);

        // Blue trimmer pot for the LCD contrast.
        const pot = new THREE.Group();
        pot.position.set(4.1, TOP, -3.95);
        this.boardGroup.add(pot);
        this.addBox(pot, 0.55, 0.24, 0.5, this.mats.ceramic, 0, 0.12, 0, 0.02);
        this.addCylinder(pot, 0.14, 0.14, 0.12, this.mats.plastic, 0, 0.3, 0, 16);

        // Barrel jack and power switch on the left edge.
        const jack = new THREE.Group();
        jack.position.set(-5.5, TOP, -1.55);
        this.boardGroup.add(jack);
        this.addCylinder(jack, 0.3, 0.3, 0.55, this.mats.dark, 0, 0.27, 0, 20);
        this.addCylinder(jack, 0.12, 0.12, 0.2, this.mats.steel, -0.12, 0.27, 0, 14);

        const pswitch = new THREE.Group();
        pswitch.position.set(-5.5, TOP, -2.95);
        this.boardGroup.add(pswitch);
        this.addBox(pswitch, 0.5, 0.3, 0.75, this.mats.plastic, 0, 0.15, 0, 0.03);
        this.addBox(pswitch, 0.22, 0.16, 0.32, this.mats.ceramic, 0.08, 0.2, 0, 0.02);

        // AS + JTAG IDC headers on the left edge.
        const asHeader = new THREE.Group();
        asHeader.position.set(-5.5, TOP, 0.15);
        this.boardGroup.add(asHeader);
        this.addBox(asHeader, 0.7, 0.42, 1.15, this.mats.gold, 0, 0.21, 0, 0.04);
        this.addBox(asHeader, 0.72, 0.18, 0.9, this.mats.dark, 0, 0.42, 0, 0.02);

        const jtag = new THREE.Group();
        jtag.position.set(-5.5, TOP, 2.15);
        this.boardGroup.add(jtag);
        this.addBox(jtag, 0.7, 0.42, 1.5, this.mats.gold, 0, 0.21, 0, 0.04);
        this.addBox(jtag, 0.72, 0.18, 1.2, this.mats.dark, 0, 0.42, 0, 0.02);

        // Reset key, bottom-left.
        const rst = new THREE.Group();
        rst.position.set(-4.4, TOP, 3.9);
        this.boardGroup.add(rst);
        this.addBox(rst, 0.42, 0.18, 0.42, this.mats.plastic, 0, 0.09, 0, 0.02);
        this.addCylinder(rst, 0.12, 0.12, 0.08, this.mats.steel, 0, 0.2, 0, 16);

        // PS/2 on the top-right corner.
        const ps2 = new THREE.Group();
        ps2.position.set(5.05, TOP, -3.55);
        this.boardGroup.add(ps2);
        this.addCylinder(ps2, 0.42, 0.36, 0.34, this.mats.plastic, 0, 0.17, 0, 26);
        this.addCylinder(ps2, 0.36, 0.36, 0.05, this.mats.dark, 0, 0.31, 0, 26);

        // RS232 DB9 on the right edge.
        const rs232 = new THREE.Group();
        rs232.position.set(5.45, TOP, -2.35);
        rs232.rotation.y = Math.PI / 2;
        this.boardGroup.add(rs232);
        this.addBox(rs232, 1.1, 0.5, 0.85, this.mats.silver, 0, 0.25, 0, 0.04);
        this.addBox(rs232, 0.1, 0.36, 0.66, this.mats.dark, 0.5, 0.25, 0, 0.02);
        for (let i = 0; i < 9; i += 1) {
            this.addCylinder(rs232, 0.03, 0.03, 0.1, this.mats.gold, 0.52, 0.18 + (i % 3) * 0.14, -0.28 + Math.floor(i / 3) * 0.28, 8);
        }

        // Buzzer, centre-right.
        const buzzer = new THREE.Group();
        buzzer.position.set(3.7, TOP, 0.9);
        this.boardGroup.add(buzzer);
        this.addCylinder(buzzer, 0.35, 0.35, 0.3, this.mats.dark, 0, 0.15, 0, 26);
        this.addCylinder(buzzer, 0.3, 0.3, 0.03, this.mats.steel, 0, 0.31, 0, 26);
        this.addCylinder(buzzer, 0.07, 0.07, 0.05, this.mats.silver, 0, 0.33, 0, 12);

        // VGA D-SUB 15, bottom-right.
        const vga = new THREE.Group();
        vga.position.set(4.85, TOP, 3.2);
        vga.rotation.y = Math.PI / 2;
        this.boardGroup.add(vga);
        this.addBox(vga, 1.45, 0.52, 1.05, this.mats.silver, 0, 0.26, 0, 0.04);
        this.addBox(vga, 0.12, 0.4, 0.86, this.mats.dark, 0.7, 0.26, 0, 0.02);
        for (let row = 0; row < 3; row += 1) {
            for (let i = 0; i < 5; i += 1) {
                this.addCylinder(vga, 0.035, 0.035, 0.12, this.mats.gold, 0.72, 0.1 + row * 0.16, -0.4 + i * 0.2, 10);
            }
        }

        // Infrared receiver, bottom-right corner.
        const ir = new THREE.Group();
        ir.position.set(5.6, TOP, 4.05);
        this.boardGroup.add(ir);
        this.addCylinder(ir, 0.2, 0.24, 0.3, this.mats.dark, 0, 0.15, 0, 18);
        this.addCylinder(ir, 0.16, 0.16, 0.04, this.mats.steel, 0, 0.31, 0, 16);

        // AT24C08 EEPROM (SOIC-8), bottom-centre.
        const eeprom = new THREE.Group();
        eeprom.position.set(-0.7, TOP, 3.75);
        this.boardGroup.add(eeprom);
        this.addBox(eeprom, 0.42, 0.09, 0.3, this.mats.chip, 0, 0.05, 0, 0.01);
        for (let i = 0; i < 4; i += 1) {
            this.addBox(eeprom, 0.05, 0.04, 0.07, this.mats.silver, -0.15 + i * 0.1, 0.03, 0.18, 0.005);
            this.addBox(eeprom, 0.05, 0.04, 0.07, this.mats.silver, -0.15 + i * 0.1, 0.03, -0.18, 0.005);
        }
    }

    buildSwitches() {
        // Red 4-position DIP switch (wired to the same pins as the keys).
        const dip = new THREE.Group();
        dip.position.set(4.35, TOP, 1.6);
        this.boardGroup.add(dip);
        const red = new THREE.MeshStandardMaterial({ color: 0xb5342a, roughness: 0.5 });
        this.addBox(dip, 0.42, 0.22, 1.0, red, 0, 0.11, 0, 0.03);
        for (let i = 0; i < 4; i += 1) {
            const slider = this.addBox(dip, 0.2, 0.09, 0.17, this.mats.white, 0, 0.26, -0.36 + i * 0.24, 0.01);
            this.switchCells.push({ port: null, bit: i, slider, baseZ: slider.position.z });
        }
    }

    buildKeys() {
        // Four tactile keys (KEY[3:0]) along the bottom-right edge.
        const red = new THREE.MeshStandardMaterial({ color: 0xb5342a, roughness: 0.5 });
        for (let i = 0; i < 4; i += 1) {
            const group = new THREE.Group();
            group.position.set(2.3 + i * 0.53, TOP, 3.5);
            this.boardGroup.add(group);
            this.addBox(group, 0.44, 0.2, 0.44, red, 0, 0.1, 0, 0.03);
            this.addCylinder(group, 0.13, 0.13, 0.06, this.mats.steel, 0, 0.22, 0, 18);
            const actuator = this.addCylinder(group, 0.1, 0.1, 0.05, this.mats.plasticSoft, 0, 0.26, 0, 18);
            this.keyCells.push({ port: null, bit: i, actuator, baseY: actuator.position.y });
        }
    }

    buildLeds() {
        // Four red LEDs along the bottom edge.
        for (let i = 0; i < 4; i += 1) {
            const group = new THREE.Group();
            group.position.set(0.5 + i * 0.5, TOP, 3.6);
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

    buildLabels() {
        const vertical = this.addSilk("Cyclone IV", 2.75, 0.1, 1.4, "#d7e6ef", TOP + 0.006);
        vertical.rotation.z = -Math.PI / 2;
        this.addSilk("JTAG", -5.5, 3.1, 0.5, "#cfe0ea", TOP + 0.006);
        this.addSilk("AS", -5.5, 1.05, 0.35, "#cfe0ea", TOP + 0.006);
        this.addSilk("RST", -4.4, 4.25, 0.4, "#cfe0ea", TOP + 0.006);
        this.addSilk("KEY", 3.1, 4.15, 0.45, "#cfe0ea", TOP + 0.006);
        this.addSilk("LED", 1.2, 4.15, 0.45, "#cfe0ea", TOP + 0.006);
        this.addSilk("VGA", 4.85, 2.45, 0.45, "#cfe0ea", TOP + 0.006);
        this.addSilk("PS/2", 5.05, -2.8, 0.45, "#cfe0ea", TOP + 0.006);
        this.addSilk("RS232", 5.5, -1.3, 0.5, "#cfe0ea", TOP + 0.006);
        this.addSilk("SW", 4.9, 1.6, 0.35, "#cfe0ea", TOP + 0.006);
        this.addSilk("CLOCK_50", -2.55, 0.72, 0.6, "#cfe0ea", TOP + 0.006);
        this.addSilk("SEG/DIG", 2.35, -2.35, 0.7, "#cfe0ea", TOP + 0.006);
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

        // Board polarity from the RZ-EasyFPGA A2.2 profile (board_spec.md).
        this.ledActiveLow = !board.leds || board.leds.activeLow !== false;
        const disp = board.displays || {};
        this.segActiveLow = disp.segmentActiveLow === true;
        this.digitActiveLow = disp.digitActiveLow === true;
        this.segBitMap = disp.segBitMap || null;
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
        if (unknown) {
            // X/Z/U: striped blue-grey, clearly neither on nor off.
            cell.material.color.setHex(0x27415c);
            cell.material.emissiveIntensity = 0.5;
            cell.glow.material.opacity = 0.25;
            cell.glow.scale.setScalar(0.8);
            return;
        }
        cell.material.color.setHex(on ? this.mats.ledOn : this.mats.ledOff);
        cell.material.emissiveIntensity = on ? 2.9 : 0;
        cell.glow.material.opacity = on ? 0.8 : 0;
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
        const map = this.segBitMap || { a: 6, b: 5, c: 4, d: 3, e: 2, f: 1, g: 0 };
        const activeLow = this.segActiveLow;
        let count = 0;
        for (let i = 0; i < 7; i += 1) {
            const name = "abcdefg"[i];
            const material = digit.segments[name];
            const bit = (v >>> map[name]) & 1;
            const on = !unknown && (activeLow ? bit === 0 : bit === 1);
            material.emissiveIntensity = on ? 3.1 * lit : unknown ? 0.12 : 0;
            material.color.setHex(on ? 0xff5a3a : unknown ? 0x27415c : 0x2a0a07);
            if (on) count += 1;
        }
        const dpBit = (v >>> 7) & 1;
        const dpOn = !unknown && (activeLow ? dpBit === 0 : dpBit === 1);
        digit.segments.dp.emissiveIntensity = dpOn ? 2.6 * lit : unknown ? 0.12 : 0;
        digit.segments.dp.color.setHex(dpOn ? 0xffb02e : unknown ? 0x27415c : 0x2a0a07);
        if (dpOn) count += 1;
        digit.glow.material.opacity = lit * (count / 8) * 0.5;
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
        this.tweenCamera(new THREE.Vector3(6.2, 4.8, 5.4), new THREE.Vector3(2.8, 1.2, -1.9), 0.9);
    }

    resetView() {
        this.tweenCamera(this.homePosition, this.homeTarget, 0.9);
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
            this.renderer.render(this.scene, this.camera);
        }
        this.emitReadout();
    }

    dispose() {
        if (this.frame) cancelAnimationFrame(this.frame);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.controls) this.controls.dispose();
        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
    }
}