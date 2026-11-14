// index.js — Board3D: the public Three.js board model of the RZ-EasyFPGA A2.2.
//
// Public API (see README in this folder):
//   new Board3D(container, { quality, onPick, theme })
//   mount() / dispose()
//   setProfile(profile)        — pins/labels/polarities from board.json data
//   setDesign(boardMap)        — bind ports → elements
//   applyCycle(values, {time}) — one clock cycle of live values
//   setPower(on) / resetVisual() / setRunning(bool)
//   pressKey(i,down) / setDip(i,on) / pressReset(down) / togglePower()
//   setPreset('top'|'front'|'iso'|'ports') / fit() / zoomIn() / zoomOut() / tweenCamera()
//   focusComponent(id) / highlightPin(pinId) / probePoints()
//   stats() / setQuality() / setTheme()
//   enablePhotoOverlay(url, {opacity,x,y,scale}) / setPhotoOpacity(v) / setDeterministic(seed)

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

import { PCB_OUTLINE, LAYOUT, buildPinIndex, SEG_GLYPHS } from "./layout.js";
import { createMaterials, setupEnvironment, setupLights, applyTheme } from "./materials.js";
import { buildPCB } from "./pcb.js";
import { buildFPGA } from "./fpga.js";
import { buildICs } from "./ics.js";
import { buildPassives } from "./passives.js";
import { buildConnectors } from "./connectors.js";
import { buildHeaders } from "./headers.js";
import { buildIO, LIT_COLOR, DARK_COLOR } from "./io.js";
import { mulberry32, glowTexture, disposeObject } from "./util.js";

const PRESETS = {
    // framing tightened so the 132×104 mm board fills the viewport (was 178/178)
    top: { pos: [0, 152, 0.02], target: [0, 0, 0], up: [0, 0, -1] },
    front: { pos: [4, 58, -122], target: [0, 0, 0], up: [0, 1, 0] },
    iso: { pos: [84, 96, -82], target: [0, 0, 0], up: [0, 1, 0] },
    ports: { pos: [152, 62, 8], target: [0, 0, 0], up: [0, 1, 0] },
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Board3D {
    constructor(container, { quality = "balanced", theme = "dark", onPick = null } = {}) {
        this.container = container;
        this.quality = quality;
        this.theme = theme;
        this.onPick = onPick;

        this.profile = null;
        this.pinIndex = null;
        this.design = { leds: "LED", keys: "KEY", dip: "KEY", seg: "SEG", dig: "DIG", buzzer: "FPGA_BUZZER" };

        this.power = true;
        this.running = true;
        this.deterministic = false;
        this.rng = mulberry32(0xc1c10);

        this._mounted = false;
        this._disposed = false;
        this._fps = { frames: 0, last: performance.now(), value: 0 };
        this._tween = null;
        this._pulse = null;
        // Render throttle: the loop runs at display vsync (up to 165 Hz on
        // gaming monitors); rendering every vsync with bloom costs a full
        // CPU core. Cap to 60 fps while something is animating and drop to
        // 24 fps after 5 s of no activity — visually identical, ~85% less
        // idle CPU (see _loop).
        this._lastActive = performance.now();
        this._lastRender = 0;
        for (const m of ["applyCycle", "setPower", "resetVisual", "pressKey", "setDip", "pressReset", "setPreset", "zoomIn", "zoomOut", "fit", "setTheme"]) {
            const orig = this[m].bind(this);
            this[m] = (...args) => {
                this._lastActive = performance.now();
                return orig(...args);
            };
        }
        this._photo = null;

        this._initRenderer();
        this._initScene();
        this._initControls();
    }

    // ------------------------------------------------------------- setup ----
    _initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: this.quality !== "performance", alpha: false });
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.12;
        this.renderer.shadowMap.enabled = this.quality !== "performance";
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // The board is static: render the shadow map once per build/quality
        // change instead of every frame (halves steady-state draw calls).
        this.renderer.shadowMap.autoUpdate = false;
        // accumulate draw calls across the whole frame (incl. composer passes)
        this.renderer.info.autoReset = false;
        this._applyPixelRatio();
    }

    _applyPixelRatio() {
        const dpr = typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1;
        const cap = this.quality === "high" ? 2 : this.quality === "balanced" ? 1.6 : 1;
        this.renderer.setPixelRatio(Math.min(dpr, cap));
        // Report which GPU (or software fallback) actually renders the scene:
        // a "SwiftShader"/"software" answer means hardware acceleration is
        // OFF and every frame is CPU-drawn — the #1 cause of high CPU.
        try {
            const gl = this.renderer.getContext();
            const dbg = gl.getExtension("WEBGL_debug_renderer_info");
            this.gpuName = String(dbg
                ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                : gl.getParameter(gl.RENDERER));
            this.gpuIsSoftware = /swiftshader|software|basic render|llvmpipe/i.test(this.gpuName);
        } catch {
            this.gpuName = "unknown";
            this.gpuIsSoftware = false;
        }
    }

    _initScene() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2500);
        this.camera.position.set(...PRESETS.iso.pos);
        this.camera.up.set(...PRESETS.iso.up);
        this.mats = createMaterials();
        this.lights = setupLights(this.scene, this.quality);
        setupEnvironment(this.renderer, this.scene);
        applyTheme(this.scene, this.lights, this.theme);

        // subtle floating dust for depth (frozen by setDeterministic)
        const N = 220;
        const pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i += 1) {
            pos[i * 3] = (this.rng() - 0.5) * 200;
            pos[i * 3 + 1] = 4 + this.rng() * 46;
            pos[i * 3 + 2] = (this.rng() - 0.5) * 160;
        }
        const dustGeo = new THREE.BufferGeometry();
        dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
            color: 0x8fa8c0, size: 0.42, transparent: true, opacity: 0.35, depthWrite: false,
        }));
        this.scene.add(this.dust);
    }

    _initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.09;
        this.controls.minDistance = 28;
        this.controls.maxDistance = 520;
        this.controls.maxPolarAngle = 1.52;
        this.controls.target.set(0, 2, 0);
        this.controls.autoRotateSpeed = 0.6;
    }

    _buildBoard() {
        if (this.boardGroup) {
            this.scene.remove(this.boardGroup);
            disposeObject(this.boardGroup);
        }
        this.pinIndex = this.pinIndex || buildPinIndex(null);
        const segBitMap = this.profile?.board?.displays?.segBitMap;
        this.boardGroup = new THREE.Group();
        this.pickables = [];
        this.anchors = [];
        this._probePoints = [];

        const pcb = buildPCB(this.mats);
        const fpga = buildFPGA(this.mats);
        const ics = buildICs(this.mats);
        const passives = buildPassives(this.mats);
        const connectors = buildConnectors(this.mats);
        const headers = buildHeaders(this.mats, this.pinIndex.headerLayouts);
        this.io = buildIO(this.mats, {
            pinIndex: this.pinIndex.index,
            segBitMap: segBitMap && Object.keys(segBitMap).length ? segBitMap : undefined,
        });

        for (const part of [pcb.group, fpga.group, ics.group, passives.group, connectors.group, headers.group, this.io.group]) {
            this.boardGroup.add(part);
        }
        this.pickables.push(
            fpga.anchor.object, ...ics.pickables, ...connectors.pickables,
            ...headers.pickables, ...this.io.pickables,
        );
        this.anchors.push(fpga.anchor, ...ics.anchors, ...connectors.anchors, ...headers.anchors, ...this.io.anchors);
        this._probePoints.push(...fpga.probePoints, ...ics.probePoints, ...headers.probePoints, ...this.io.probePoints);
        this.powerLed = passives.powerLed;
        this._probeMap = new Map();
        for (const p of this._probePoints) {
            if (p.pinId && !this._probeMap.has(p.pinId)) this._probeMap.set(p.pinId, p);
        }
        this.scene.add(this.boardGroup);
        this.renderer.shadowMap.needsUpdate = true;
    }

    // -------------------------------------------------------------- mount ----
    mount() {
        if (this._mounted) return this;
        this._mounted = true;
        const el = this.renderer.domElement;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.display = "block";
        this.container.appendChild(el);
        this._buildBoard();
        this._resize();
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(this.container);
        el.addEventListener("dblclick", this._onDblClick);
        for (const ev of ["pointerdown", "pointermove", "wheel"]) {
            el.addEventListener(ev, () => { this._lastActive = performance.now(); }, { passive: true });
        }
        this.controls.addEventListener("change", () => { this._lastActive = performance.now(); });
        this._raf = requestAnimationFrame(this._loop);
        this.renderer.render(this.scene, this.camera); // first render → ready
        if (this.container) this.container.dataset.ready = "1";
        return this;
    }

    _resize() {
        const w = Math.max(this.container.clientWidth || 800, 2);
        const h = Math.max(this.container.clientHeight || 600, 2);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        if (this.composer) this.composer.setSize(w, h);
    }

    _onDblClick = (event) => {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.camera);
        const hits = ray.intersectObjects(this.pickables, false);
        if (!hits.length) return;
        const hit = hits[0];
        const ud = hit.object.userData || {};
        if (ud.componentId) this.focusComponent(ud.componentId);
        if (this.onPick) this.onPick({ componentId: ud.componentId, pinId: ud.pinId, userData: ud, point: hit.point });
    };

    // ------------------------------------------------------------- profile ----
    setProfile(profile) {
        this.profile = profile || null;
        this.pinIndex = buildPinIndex(profile);
        if (this._mounted) this._buildBoard();
    }

    setDesign(boardMap) {
        if (!boardMap) return;
        Object.assign(this.design, boardMap);
    }

    // ---------------------------------------------------------- live values ----
    setLedTarget(i, on) {
        const led = this.io?.leds[i];
        if (led) led.target = on ? 1 : 0;
    }

    _recomputeDisplayTargets() {
        const d = this.io?.display;
        if (!d) return;
        for (let dig = 0; dig < 4; dig += 1) {
            for (let bit = 0; bit < 8; bit += 1) {
                d.segTarget[dig * 8 + bit] = d.digitOn[dig] && d.segActive[bit] ? 1 : 0;
            }
        }
    }

    _routePin(entry, level) {
        if (!entry) return;
        const high = level === true || level === 1 || level === "1";
        const active = entry.polarity === "active-low" ? !high : high;
        switch (entry.kind) {
            case "led": this.setLedTarget(entry.elementIndex, active); break;
            case "segment":
                this.io.display.segActive[entry.elementIndex] = active ? 1 : 0;
                this._recomputeDisplayTargets();
                break;
            case "digit":
                this.io.display.digitOn[entry.elementIndex] = active ? 1 : 0;
                this._recomputeDisplayTargets();
                break;
            case "buzzer": this.io.buzzer.on = active; break;
            case "button": {
                const key = this.io.keys[entry.elementIndex];
                if (key) key.pressed = active;
                break;
            }
            case "switch": {
                const lever = this.io.dip[entry.elementIndex];
                if (lever) lever.on = active;
                break;
            }
            default: break;
        }
    }

    applyCycle(values, { time } = {}) {
        if (!values || !this.io) return;
        this._cycleTime = time;

        if (values.pins) {
            for (const [pinId, level] of Object.entries(values.pins)) {
                const key = String(pinId).toUpperCase().startsWith("PIN_")
                    ? String(pinId).toUpperCase()
                    : `PIN_${String(pinId).replace(/^PIN/i, "")}`;
                this._routePin(this.pinIndex.index.get(key), level);
            }
        }
        if (values.ports && this.profile?.pinMap) {
            for (const [port, level] of Object.entries(values.ports)) {
                const pins = this.profile.pinMap[port];
                if (!pins) continue;
                (Array.isArray(pins) ? pins : [pins]).forEach((p) => {
                    const key = String(p).toUpperCase();
                    this._routePin(this.pinIndex.index.get(key), level);
                });
            }
        }
        if (values.leds) values.leds.forEach((v, i) => this.setLedTarget(i, !!v));
        if (values.keys) values.keys.forEach((v, i) => { if (this.io.keys[i]) this.io.keys[i].pressed = !!v; });
        if (values.dip) values.dip.forEach((v, i) => { if (this.io.dip[i]) this.io.dip[i].on = !!v; });
        if (values.buzzer !== undefined) this.io.buzzer.on = !!values.buzzer;
        if (values.digits) {
            values.digits.forEach((v, i) => { this.io.display.digitOn[i] = v ? 1 : 0; });
            this._recomputeDisplayTargets();
        }
        if (values.segments) {
            values.segments.forEach((digitBits, dig) => {
                digitBits.forEach((lit, bit) => {
                    this.io.display.segTarget[dig * 8 + bit] = lit ? 1 : 0;
                });
            });
        }
        if (values.chars) {
            const bitToName = this.io.display.bitToName;
            values.chars.forEach((ch, dig) => {
                const glyph = SEG_GLYPHS[ch] ?? "";
                for (let bit = 0; bit < 8; bit += 1) {
                    const name = bitToName[bit] || "g";
                    this.io.display.segTarget[dig * 8 + bit] = glyph.includes(name) ? 1 : 0;
                }
            });
        }
        if (values.power !== undefined) this.setPower(!!values.power);
    }

    // ------------------------------------------------------------ state ----
    setPower(on) {
        this.power = !!on;
        if (this.powerLed) this.powerLed.target = on ? 1 : 0;
        if (!on) {
            this.io?.leds.forEach((l) => { l.target = 0; });
            const d = this.io?.display;
            if (d) d.segTarget.fill(0);
            if (this.io) this.io.buzzer.on = false;
        }
    }

    setRunning(on) {
        this.running = !!on;
        this.controls.autoRotate = false;
    }

    resetVisual() {
        if (!this.io) return;
        this.io.keys.forEach((k) => { k.pressed = false; });
        this.io.dip.forEach((l) => { l.on = false; });
        this.io.reset.pressed = false;
        this.io.leds.forEach((l) => { l.target = 0; });
        this.io.display.segActive.fill(0);
        this.io.display.digitOn = [1, 1, 1, 1];
        this.io.display.segTarget.fill(0);
        this.io.buzzer.on = false;
        this._hideHighlight();
    }

    // -------------------------------------------------------- interaction ----
    pressKey(i, down) {
        const key = this.io?.keys[i];
        if (key) key.pressed = !!down;
    }

    setDip(i, on) {
        const lever = this.io?.dip[i];
        if (lever) lever.on = !!on;
    }

    pressReset(down) {
        if (this.io) this.io.reset.pressed = !!down;
    }

    togglePower() {
        this.setPower(!this.power);
    }

    // ------------------------------------------------------------- camera ----
    setPreset(name) {
        const p = PRESETS[name];
        if (!p) return;
        this.tweenCamera({ position: p.pos, target: p.target, up: p.up, duration: 750 });
    }

    tweenCamera({ position, target, up, duration = 700 } = {}) {
        this._tween = {
            t0: performance.now(),
            duration,
            fromPos: this.camera.position.clone(),
            toPos: new THREE.Vector3(...(position || this.camera.position.toArray())),
            fromTarget: this.controls.target.clone(),
            toTarget: new THREE.Vector3(...(target || this.controls.target.toArray())),
            fromUp: this.camera.up.clone(),
            toUp: new THREE.Vector3(...(up || this.camera.up.toArray())),
        };
    }

    fit() {
        const box = new THREE.Box3().setFromObject(this.boardGroup || this.scene);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const fov = (this.camera.fov * Math.PI) / 180;
        const dist = (sphere.radius / Math.sin(fov / 2)) * 1.06;
        const dir = this.camera.position.clone().sub(this.controls.target).normalize();
        this.tweenCamera({
            position: sphere.center.clone().add(dir.multiplyScalar(dist)).toArray(),
            target: sphere.center.toArray(),
            duration: 600,
        });
    }

    zoomIn() { this._dolly(0.78); }
    zoomOut() { this._dolly(1.28); }

    _dolly(factor) {
        const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
        const len = offset.length();
        offset.setLength(Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, len)));
        this.camera.position.copy(this.controls.target).add(offset);
        this.controls.update();
    }

    // ------------------------------------------------------------ focus ----
    focusComponent(id) {
        const anchor = this.anchors.find((a) => a.id === id);
        if (!anchor) return false;
        const pos = new THREE.Vector3();
        anchor.object.getWorldPosition(pos);
        const dist = Math.max(26, (anchor.radius || 10) * 3.4);
        const dir = this.camera.position.clone().sub(pos).normalize();
        if (dir.lengthSq() < 0.5) dir.set(0.6, 0.7, -0.4).normalize();
        this.tweenCamera({
            position: pos.clone().add(dir.multiplyScalar(dist)).toArray(),
            target: pos.toArray(),
            duration: 650,
        });
        // pulse ring
        if (this._pulse) {
            this.scene.remove(this._pulse.mesh);
            disposeObject(this._pulse.mesh);
            this._pulse = null;
        }
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(anchor.radius * 0.7, anchor.radius * 0.85, 40),
            new THREE.MeshBasicMaterial({ color: 0x66d9ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(pos).y += 0.4;
        this.scene.add(ring);
        this._pulse = { mesh: ring, t0: performance.now() };
        return true;
    }

    highlightPin(pinId) {
        const key = String(pinId || "").toUpperCase().startsWith("PIN_")
            ? String(pinId).toUpperCase()
            : String(pinId || "").toUpperCase();
        const point = this._probeMap?.get(key) || this._probeMap?.get(String(pinId));
        if (!point) return false;
        if (!this._highlight) {
            const mat = new THREE.SpriteMaterial({
                map: glowTexture(), color: new THREE.Color(0.4, 1.6, 2.6),
                transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
            });
            this._highlight = new THREE.Sprite(mat);
            this._highlight.scale.set(6, 6, 1);
            this.scene.add(this._highlight);
        }
        this._highlight.visible = true;
        this._highlight.position.copy(point.position);
        return true;
    }

    _hideHighlight() {
        if (this._highlight) this._highlight.visible = false;
    }

    probePoints() {
        return (this._probePoints || []).map((p) => ({
            pinId: p.pinId,
            componentId: p.componentId,
            label: p.label,
            position: p.position.clone(),
        }));
    }

    // ------------------------------------------------------------- quality ----
    setQuality(q) {
        this.quality = q;
        this._applyPixelRatio();
        this.renderer.shadowMap.enabled = q !== "performance";
        this.lights.key.castShadow = q !== "performance";
        this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
        this.renderer.shadowMap.needsUpdate = true;
        if (q === "high") this._ensureComposer();
        else if (this.composer) {
            disposeObject(this.composer);
            this.composer = null;
        }
        this._resize();
    }

    setTheme(theme) {
        this.theme = theme;
        applyTheme(this.scene, this.lights, theme);
    }

    _ensureComposer() {
        if (this.composer) return;
        const size = new THREE.Vector2();
        this.renderer.getSize(size);
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        if (this.quality === "high") {
            // Selective bloom: HDR emissives (lit LEDs / 7-seg segments, boosted
            // to luminance ≈ 5+) cross the threshold 4.0 while lit metals sit
            // below it. SSAO was evaluated and produced a black frame at this
            // millimetre scene scale, so it stays disabled.
            const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.45, 0.3, 4.0);
            this.composer.addPass(bloom);
        }
        this.composer.addPass(new OutputPass());
    }

    // --------------------------------------------------------------- dev ----
    enablePhotoOverlay(url, { opacity = 0.55, x = 0, y = 0, scale = 1 } = {}) {
        if (this._photo) {
            this.scene.remove(this._photo.mesh);
            disposeObject(this._photo.mesh);
            this._photo = null;
        }
        const mat = new THREE.MeshBasicMaterial({
            transparent: true, opacity, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PCB_OUTLINE.w * scale, PCB_OUTLINE.d * scale), mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, 55, y);
        mesh.renderOrder = 20;
        mesh.visible = false;
        this.scene.add(mesh);
        this._photo = { mesh, mat, config: { opacity, x, y, scale } };
        new THREE.TextureLoader().load(
            url,
            (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                mat.map = tex;
                mat.needsUpdate = true;
                mesh.visible = true;
            },
            undefined,
            () => console.info("[Board3D] photo overlay URL failed to load:", url),
        );
        return this;
    }

    setPhotoOpacity(v) {
        if (this._photo) {
            this._photo.mat.opacity = v;
            this._photo.config.opacity = v;
        }
    }

    setDeterministic(seed = 1) {
        this.deterministic = true;
        this.rng = mulberry32(seed);
        this.controls.autoRotate = false;
        // refreeze dust
        const pos = this.dust.geometry.getAttribute("position");
        for (let i = 0; i < pos.count; i += 1) {
            pos.setXYZ(i, (this.rng() - 0.5) * 200, 4 + this.rng() * 46, (this.rng() - 0.5) * 160);
        }
        pos.needsUpdate = true;
        if (this._tween) this._tween.duration = 0; // snap instead of animate
    }

    // --------------------------------------------------------------- stats ----
    stats() {
        const info = this.renderer.info;
        let memoryMB = null;
        if (typeof performance !== "undefined" && performance.memory) {
            memoryMB = performance.memory.usedJSHeapSize / 1048576;
        }
        return {
            fps: Math.round(this._fps.value),
            drawCalls: info.render.calls,
            triangles: info.render.triangles,
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            memoryMB: memoryMB === null ? null : Math.round(memoryMB * 10) / 10,
        };
    }

    // ----------------------------------------------------------- main loop ----
    _loop = () => {
        if (this._disposed) return;
        this._raf = requestAnimationFrame(this._loop);
        const now = performance.now();
        // 60 fps while a simulation runs, a camera tween/pulse animates or
        // the user interacted recently; 24 fps when idle; 6 fps after 20 s
        // fully idle (desktop sessions stay open for hours — a static board
        // is visually identical at 6 fps and costs ~0.2% CPU).
        const idleMs = now - this._lastActive;
        const cap = (this.running || this._tween || this._pulse || idleMs < 5000) ? 60
            : (idleMs < 20000 ? 24 : 6);
        if (now - this._lastRender < 1000 / cap) return;
        this._lastRender = now;
        this.renderer.info.reset();
        const dt = Math.min(0.05, (now - (this._lastFrame || now)) / 1000);
        this._lastFrame = now;

        // fps (rolling, sampled twice a second)
        this._fps.frames += 1;
        if (now - this._fps.last >= 500) {
            this._fps.value = (this._fps.frames * 1000) / (now - this._fps.last);
            this._fps.frames = 0;
            this._fps.last = now;
        }

        // camera tween
        if (this._tween) {
            const tw = this._tween;
            const t = tw.duration <= 0 ? 1 : Math.min(1, (now - tw.t0) / tw.duration);
            const e = easeInOut(t);
            this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
            this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
            this.camera.up.lerpVectors(tw.fromUp, tw.toUp, e).normalize();
            if (t >= 1) this._tween = null;
        }

        // pulse ring fade
        if (this._pulse) {
            const t = (now - this._pulse.t0) / 1200;
            if (t >= 1) {
                this.scene.remove(this._pulse.mesh);
                disposeObject(this._pulse.mesh);
                this._pulse = null;
            } else {
                this._pulse.mesh.material.opacity = 0.9 * (1 - t);
                this._pulse.mesh.scale.setScalar(1 + t * 0.6);
            }
        }

        this._updateIO(now, dt);

        // dust drift
        if (!this.deterministic && this.running) {
            const pos = this.dust.geometry.getAttribute("position");
            for (let i = 0; i < pos.count; i += 1) {
                let y = pos.getY(i) + dt * 1.4;
                if (y > 52) y = 4;
                pos.setY(i, y);
            }
            pos.needsUpdate = true;
        }

        this.controls.update();
        if (this.composer && this.quality === "high") this.composer.render();
        else this.renderer.render(this.scene, this.camera);
    };

    _updateIO(now, dt) {
        const io = this.io;
        if (!io) return;
        const k = 1 - Math.exp(-dt / 0.045);

        // LED persistence + glow (halos share one Points cloud; per-vertex HDR colour)
        const glowCol = io.glowPoints.geometry.getAttribute("color");
        io.leds.forEach((led, i) => {
            const target = this.power && this.running ? led.target : 0;
            led.level += (target - led.level) * (1 - Math.exp(-dt / 0.06));
            led.material.emissiveIntensity = led.level * 2.6;
            glowCol.setXYZ(i, 2.4 * led.level, 0.32 * led.level, 0.1 * led.level);
        });
        glowCol.needsUpdate = true;
        if (this.powerLed) {
            const target = this.power ? 1 : 0;
            this.powerLed.level += (target - this.powerLed.level) * k;
            this.powerLed.material.emissiveIntensity = this.powerLed.level * 2.4;
            this.powerLed.glowMaterial.opacity = this.powerLed.level * 0.8;
        }

        // 7-seg multiplexing: exact per-cycle gating, short persistence glow
        const d = io.display;
        const scratch = this._segColor || (this._segColor = new THREE.Color());
        for (let i = 0; i < 32; i += 1) {
            const target = this.power && this.running ? d.segTarget[i] : 0;
            d.segCurrent[i] += (target - d.segCurrent[i]) * k;
            const c = d.segCurrent[i];
            const inst = d.segInst;
            scratch.setRGB(
                DARK_COLOR.r + (LIT_COLOR.r - DARK_COLOR.r) * c,
                DARK_COLOR.g + (LIT_COLOR.g - DARK_COLOR.g) * c,
                DARK_COLOR.b + (LIT_COLOR.b - DARK_COLOR.b) * c,
            );
            inst.setColorAt(i, scratch);
        }
        if (d.segInst.instanceColor) d.segInst.instanceColor.needsUpdate = true;

        // key caps
        for (const key of io.keys) {
            const targetY = key.pressed ? key.pressY : key.baseY;
            key.cap.position.y += (targetY - key.cap.position.y) * (1 - Math.exp(-dt / 0.03));
        }
        // reset key
        {
            const r = io.reset;
            const targetY = r.pressed ? r.pressY : r.baseY;
            r.cap.position.y += (targetY - r.cap.position.y) * (1 - Math.exp(-dt / 0.03));
        }
        // DIP levers
        for (const lever of io.dip) {
            const targetY = lever.on ? lever.baseY + 1.1 : lever.baseY;
            lever.lever.position.y += (targetY - lever.lever.position.y) * (1 - Math.exp(-dt / 0.05));
            lever.lever.rotation.x += ((lever.on ? -0.5 : 0) - lever.lever.rotation.x) * (1 - Math.exp(-dt / 0.05));
        }
        // power switch cap
        {
            const ps = io.powerSwitch;
            const targetY = ps.on ? ps.baseY : ps.baseY - 2.6;
            ps.cap.position.y += (targetY - ps.cap.position.y) * (1 - Math.exp(-dt / 0.06));
        }
        // buzzer shiver
        {
            const bz = io.buzzer;
            if (bz.on && this.power && this.running && !this.deterministic) {
                bz.phase += dt * 60;
                bz.body.position.y = bz.baseY + Math.sin(bz.phase) * 0.05;
            } else {
                bz.body.position.y += (bz.baseY - bz.body.position.y) * k;
            }
        }
    }

    // ------------------------------------------------------------- dispose ----
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        this._resizeObserver?.disconnect();
        this.renderer.domElement.removeEventListener("dblclick", this._onDblClick);
        this.controls.dispose();
        if (this.boardGroup) {
            this.scene.remove(this.boardGroup);
            disposeObject(this.boardGroup);
        }
        disposeObject(this.scene);
        if (this.composer) disposeObject(this.composer);
        this.renderer.dispose();
        this.renderer.domElement.remove();
        if (this.container) delete this.container.dataset.ready;
    }
}
