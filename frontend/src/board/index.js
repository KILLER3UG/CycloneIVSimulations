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

import { PCB_OUTLINE, LAYOUT, BOARD_TOP, buildPinIndex, SEG_GLYPHS, buildDynamicBoardModel } from "./layout.js";
import { brightness, ghostOverlay, isInstantaneousScan, normalizePov } from "./displayModel.js";
import { createMaterials, setupEnvironment, setupLights, applyTheme, applyPcbColor } from "./materials.js";
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
        // running = a capture is actively streaming; programmed = a design
        // was loaded (Run). Outputs hold their state while programmed, like
        // a real board keeps running its configuration; an unprogrammed
        // board is inert (keys/DIP still move — they are physical switches).
        this.running = false;
        this.programmed = false;
        this.deterministic = false;
        this.rng = mulberry32(0xc1c10);

        this._mounted = false;
        this._disposed = false;
        this._fps = { frames: 0, last: performance.now(), value: 0 };
        this._tween = null;
        this._pulse = null;
        this._buzzerRing = null;
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
        // A3 display model: time-weighted duty per (tube, segment) and the
        // measured full-scan refresh rate. Everything is derived from
        // simulated nanoseconds — never from frame counts.
        this._dutyLit = new Float64Array(32);
        this._dutyTotal = 0;
        this._lastCycleTime = null;
        this._lastCycleDt = 0;
        this._scanHz = 0;
        // A3 ghosting: faint bleed on a tube when segments change on the same
        // edge as its digit select (no dead-time blanking). Values are 0–0.25.
        this._ghost = new Float32Array(32);

        this._initRenderer();
        this._initScene();
        this._initControls();
    }

    // ------------------------------------------------------------- setup ----
    _initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: this.quality !== "performance", alpha: false });
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        // Studio Monochrome: the clear colour matches scene.background so a
        // resized canvas never flashes a stale grey/blue frame.
        this.renderer.setClearColor(0x0a0a0b, 1);
        this._detectGpu();
        // A software rasterizer draws every frame on the CPU, spread across
        // cores — shadow maps and a high pixel ratio multiply that cost and
        // peg the laptop. Drop them there; a real GPU keeps the full path.
        this.renderer.shadowMap.enabled = !this.gpuIsSoftware && this.quality !== "performance";
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // The board is static: render the shadow map once per build/quality
        // change instead of every frame (halves steady-state draw calls).
        this.renderer.shadowMap.autoUpdate = false;
        // accumulate draw calls across the whole frame (incl. composer passes)
        this.renderer.info.autoReset = false;
        this._applyPixelRatio();
    }

    _detectGpu() {
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

    _applyPixelRatio() {
        const dpr = typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1;
        // Hardware: native resolution capped at 2 for razor-sharp silkscreen.
        // A software rasterizer draws every fragment on the CPU, so stay at 1
        // to keep the frame cost usable (tests read state, not pixels).
        const cap = this.gpuIsSoftware ? 1 : 2;
        this.renderer.setPixelRatio(Math.min(dpr, cap));
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
        // Studio Monochrome: zero fog, always. Any fog puts a haze between the
        // camera and the board and washes out the razor-sharp silkscreen.
        this.scene.fog = null;
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

    /** A minimal FPGA package for profiles that do not use the canonical board. */
    _buildDynamicFpga(model) {
        const group = new THREE.Group();
        group.name = "fpga";
        const [px, pz] = model.fpga.pos;
        const x = px - model.pcb.w / 2;
        const z = pz - model.pcb.d / 2;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(model.fpga.size[0], 1.8, model.fpga.size[1]),
            this.mats.chipBlack,
        );
        body.position.set(x, BOARD_TOP + 0.9, z);
        body.castShadow = true;
        body.userData = { componentId: "U5", kind: "fpga", pinId: null, polarity: null, label: model.name };
        group.add(body);
        return {
            group,
            probePoints: [],
            anchor: { id: "U5", object: body, radius: 14 },
        };
    }

    _buildBoard() {
        if (this.boardGroup) {
            this.scene.remove(this.boardGroup);
            disposeObject(this.boardGroup);
        }
        this.pinIndex = this.pinIndex || buildPinIndex(null);
        const segBitMap = this.profile?.board?.displays?.segBitMap;
        const model = buildDynamicBoardModel(this.profile);
        this._boardModel = model;
        const dynamic = !model.isDefault;
        applyPcbColor(this.mats, this.profile);
        this.boardGroup = new THREE.Group();
        this.pickables = [];
        this.anchors = [];
        this._probePoints = [];
        this._buzzerRing = null;

        const pcb = buildPCB(this.mats, {
            profile: this.profile,
            model: dynamic ? model : null,
        });
        const fpga = dynamic
            ? this._buildDynamicFpga(model)
            : buildFPGA(this.mats);
        // The canonical 58-part geometry only exists on the RZ-EasyFPGA board.
        const parts = dynamic
            ? []
            : [buildICs(this.mats), buildPassives(this.mats), buildConnectors(this.mats)];
        const headers = dynamic
            ? { group: new THREE.Group(), pickables: [], anchors: [], probePoints: [] }
            : buildHeaders(this.mats, this.pinIndex.headerLayouts);
        this.io = buildIO(this.mats, {
            pinIndex: this.pinIndex.index,
            segBitMap: segBitMap && Object.keys(segBitMap).length ? segBitMap : undefined,
            ledMeta: this.profile?.board?.leds || null,
            profile: this.profile,
            model: dynamic ? model : null,
        });

        for (const part of [pcb.group, fpga.group, ...parts.map((p) => p.group), headers.group, this.io.group]) {
            this.boardGroup.add(part);
        }
        this.pickables.push(
            fpga.anchor.object,
            ...parts.flatMap((p) => p.pickables || []),
            ...headers.pickables, ...this.io.pickables,
        );
        this.anchors.push(
            fpga.anchor,
            ...parts.flatMap((p) => p.anchors || []),
            ...headers.anchors, ...this.io.anchors,
        );
        this._probePoints.push(
            ...fpga.probePoints,
            ...parts.flatMap((p) => p.probePoints || []),
            ...headers.probePoints, ...this.io.probePoints,
        );
        this.powerLed = dynamic ? null : (parts.find((p) => p.powerLed)?.powerLed || null);
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
        // IO state (LED levels, segment persistence, key caps) evolves on a
        // cheap 10 Hz timer, decoupled from the GPU render rate. Under software
        // rendering the pixels refresh at ~1 fps, but the state the UI/tests
        // read stays fresh — and a static board costs almost no CPU.
        this._ioLast = performance.now();
        this._ioTimer = setInterval(() => {
            const now = performance.now();
            const dt = Math.min(0.1, (now - this._ioLast) / 1000);
            this._ioLast = now;
            this._updateIO(now, dt);
        }, 100);
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
        this.rebuildBoard(profile);
    }

    /**
     * Atomically replace the board scene for a newly selected/imported board:
     * disposes the old group, rebuilds PCB + I/O from the new profile, resets
     * volatile state and re-fits the camera. Safe before mount() as well.
     */
    rebuildBoard(profile) {
        this.profile = profile || null;
        this.pinIndex = buildPinIndex(this.profile);
        this.programmed = false;
        this._buzzerRing = null;
        this._resetDuty();
        if (this._mounted && !this._disposed) {
            this._buildBoard();
            this.resetVisual();
            this.fit();
            this.renderer.shadowMap.needsUpdate = true;
        }
        return this;
    }

    setDesign(boardMap) {
        if (!boardMap) return;
        Object.assign(this.design, boardMap);
        this.programmed = true;
    }

    // ---------------------------------------------------------- live values ----
    // Synchronous LED paint: called from applyBoardImage / setLedTarget so the
    // mesh matches state on the SAME JS turn (no wait for the 10 Hz IO timer).
    _paintLed(i, level) {
        const led = this.io?.leds?.[i];
        if (!led) return;
        const v = Math.min(1, Math.max(0, Number(level) || 0));
        led.level = v;
        if (led.material) {
            if (led.material.emissive?.setHex) led.material.emissive.setHex(0xff2818);
            led.material.emissiveIntensity = v * 2.6;
            if (led.material.color?.setRGB) led.material.color.setRGB(1, 1 - v * 0.28, 1 - v * 0.28);
        }
        const glowCol = this.io?.glowPoints?.geometry?.getAttribute?.("color");
        if (glowCol && i < glowCol.count) {
            glowCol.setXYZ(i, 2.4 * v, 0.32 * v, 0.1 * v);
            glowCol.needsUpdate = true;
        }
    }

    /** Repaint the whole 7-seg instance buffer from segCurrent (POV included). */
    _paintDisplay() {
        const d = this.io?.display;
        const inst = d?.segInst;
        if (!d || !inst) return;
        const live = this.power && this.programmed;
        const scratch = this._segColor || (this._segColor = new THREE.Color());
        for (let i = 0; i < d.segCurrent.length; i += 1) {
            const duty = d.segCurrent[i];
            let c = brightness(duty, this._ghost[i], live);
            // A 1-of-4 mux gives 0.25 duty. Without a gamma boost those POV
            // digits look almost black against the charcoal housing; lift
            // them to studio-red luminance while keeping 0 exactly dark.
            if (duty > 0 && duty <= 0.35) {
                c = Math.max(c, Math.pow(Math.min(1, duty / 0.35), 0.42) * 1.7);
            }
            scratch.setRGB(
                DARK_COLOR.r + (LIT_COLOR.r - DARK_COLOR.r) * c,
                DARK_COLOR.g + (LIT_COLOR.g - DARK_COLOR.g) * c,
                DARK_COLOR.b + (LIT_COLOR.b - DARK_COLOR.b) * c,
            );
            inst.setColorAt(i, scratch);
        }
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    }

    /** Buzzer visual state; immediate=true paints the pulse ring this turn. */
    _setBuzzerVisual(on, immediate = false) {
        const bz = this.io?.buzzer;
        if (!bz) return;
        bz.on = Boolean(on);
        if (bz.on && this.power) this._ensureBuzzerRing();
        const ring = this._buzzerRing;
        if (!ring) return;
        const active = bz.on && this.power;
        if (immediate) {
            ring.material.opacity = active ? 0.65 : 0;
            ring.scale.setScalar(active ? 1.1 : 1);
            ring.visible = active;
        }
    }

    setLedTarget(i, on) {
        const val = on ? 1 : 0;
        const led = this.io?.leds?.[i];
        if (led) {
            led.target = val;
            this._paintLed(i, val);
        }
    }

    _recomputeDisplayTargets() {
        const d = this.io?.display;
        if (!d) return;
        for (let dig = 0; dig < 4; dig += 1) {
            for (let bit = 0; bit < 8; bit += 1) {
                const i = dig * 8 + bit;
                // Instantaneous scan phase. The rendered image is the
                // time-weighted duty (segHold) computed in _updateIO, not this
                // gate — a 25%-duty tube must read 25% bright, not 100%.
                d.segTarget[i] = d.digitOn[dig] && d.segActive[bit] ? 1 : 0;
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
                this._displayDirty = true;
                break;
            case "digit":
                this.io.display.digitOn[entry.elementIndex] = active ? 1 : 0;
                this._displayDirty = true;
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
        // Time-weighted duty accumulation (simulated ns, not wall time).
        const t = Number(time);
        let dt = 0;
        if (Number.isFinite(t)) {
            if (this._lastCycleTime !== null && t > this._lastCycleTime) {
                dt = t - this._lastCycleTime;
                this._dutyTotal += dt;
            }
            this._lastCycleTime = t;
        }
        this._lastCycleDt = dt;
        // Digit and segment pins are routed one at a time; recompute the
        // multiplexed target only ONCE after all pins are applied. Recomputing
        // mid-cycle would light transient (tube,segment) pairs from a half-updated
        // state (new segments + previous tube) and pollute the POV hold.
        this._displayDirty = false;

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
            this._displayDirty = true;
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
        if (this._displayDirty) this._recomputeDisplayTargets();
        if (dt > 0) {
            const d = this.io.display;
            for (let i = 0; i < 32; i += 1) {
                if (d.segTarget[i]) this._dutyLit[i] += dt;
            }
        }
        if (values.power !== undefined) this.setPower(!!values.power);
    }

    // Paint a compact board image (live input-change refresh). The backend
    // integrates the multiplexed display over the whole capture and returns
    // the **duty-cycle** POV image (plus scan rate and ghost samples) and the
    // final LED/buzzer levels, so a switch flip repaints the board from a few
    // hundred bytes instead of replaying tens of thousands of per-cycle samples.
    applyBoardImage(image) {
        if (!image || !this.io) return;
        const d = this.io.display;
        const pov = image.pov || [];
        const bits = image.povBits || [];
        this._scanHz = Number(image.scanHz) || 0;
        this._ghost = ghostOverlay(image.ghosts);
        // Normalized duty (≤1) so _updateIO can use the same lit/total ratio
        // as the live cycle path without a second divide.
        this._dutyTotal = 1;
        const duty = normalizePov(pov, bits);
        for (let i = 0; i < 32; i += 1) {
            this._dutyLit[i] = duty[i];
            // segHold is the rendered persistence-of-vision image; segCurrent is
            // snapped to it so the integrated image shows immediately. segTarget
            // is left as the instantaneous scan phase (the slow-scan check reads
            // it) — the POV never lives there.
            d.segHold[i] = duty[i];
            d.segCurrent[i] = duty[i];
        }
        // The POV already encodes which segments are lit per tube; keep every
        // tube enabled so nothing gates the image, and do NOT recompute targets
        // from digitOn/segActive (that would collapse it to one scan phase).
        if (Array.isArray(image.digits)) {
            for (let i = 0; i < 4; i += 1) d.digitOn[i] = image.digits[i] ? 1 : 0;
        }
        const leds = image.leds || [];
        for (let i = 0; i < (this.io.leds?.length || 0); i += 1) {
            this.setLedTarget(i, Boolean(leds[i]));
        }
        if (typeof image.buzzer === "number" || typeof image.buzzer === "boolean") {
            this._setBuzzerVisual(!!image.buzzer, true);
        }
        // Paint the display segments on this turn too — a live input flip must
        // be visible immediately, not one 10 Hz IO tick later.
        this._paintDisplay();
    }

    // ------------------------------------------------------------ state ----
    setPower(on) {
        this.power = !!on;
        if (this.powerLed) this.powerLed.target = on ? 1 : 0;
        if (!on) {
            // Volatile JTAG configuration is lost on power-off (board_spec
            // §2: .sof is volatile) — the board comes back unprogrammed.
            this.programmed = false;
            (this.io?.leds || []).forEach((l, i) => {
                l.target = 0;
                this._paintLed(i, 0);
            });
            const d = this.io?.display;
            if (d) {
                d.segTarget.fill(0);
                d.segHold.fill(0);
                d.segCurrent.fill(0);
            }
            this._resetDuty();
            this._setBuzzerVisual(false, true);
            this._paintDisplay();
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
        this.io.leds.forEach((l, i) => { l.target = 0; this._paintLed(i, 0); });
        this.io.display.segActive.fill(0);
        this.io.display.digitOn = [1, 1, 1, 1];
        this.io.display.segTarget.fill(0);
        this.io.display.segHold.fill(0);
        this.io.display.segCurrent.fill(0);
        this._resetDuty();
        this._setBuzzerVisual(false, true);
        this._paintDisplay();
        this._hideHighlight();
    }

    // Clear only the 7-seg persistence image so a live refresh rebuilds it
    // from the new cycles (leaves the key/DIP/LED visuals untouched).
    resetDisplayHold() {
        const d = this.io?.display;
        if (!d) return;
        d.segActive.fill(0);
        d.digitOn = [1, 1, 1, 1];
        d.segTarget.fill(0);
        d.segHold.fill(0);
        this._resetDuty();
    }

    _resetDuty() {
        this._dutyLit.fill(0);
        this._dutyTotal = 0;
        this._lastCycleTime = null;
        this._lastCycleDt = 0;
        this._ghost.fill(0);
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
        const shadows = !this.gpuIsSoftware && q !== "performance";
        this.renderer.shadowMap.enabled = shadows;
        this.lights.key.castShadow = shadows;
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
        // Frame-rate tiers. A real GPU renders cheaply, so it keeps the smooth
        // 60/24/6 ladder. A SOFTWARE rasterizer (headless tests, or hardware
        // acceleration disabled) draws every frame on the CPU — 60 fps there
        // saturates a core, starves the editor/init microtasks and makes the
        // laptop unusable, so it is capped hard (a static board is visually
        // identical at 1–2 fps). `animating` = a capture streams or the camera
        // tweens; otherwise the board only needs occasional redraws.
        const animating = this.running || this._tween || this._pulse;
        const sw = this.gpuIsSoftware;
        // SwiftShader spreads ONE frame across many CPU cores, so even a modest
        // fps keeps several cores busy continuously. Tests read state on the
        // main thread (not pixels), so software rendering drops to ~1–2 fps —
        // the board still updates, but the cores idle between frames.
        const cap = animating ? (sw ? 2 : 60)
            : idleMs < 3000 ? (sw ? 2 : 60)
            : idleMs < 20000 ? (sw ? 1 : 24)
            : (sw ? 1 : 6);
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

        // dust drift removed — Studio Monochrome keeps the void perfectly clean

        this.controls.update();
        if (this.composer && this.quality === "high") this.composer.render();
        else this.renderer.render(this.scene, this.camera);
    };

    _updateIO(now, dt) {
        const io = this.io;
        if (!io) return;
        const k = 1 - Math.exp(-dt / 0.045);
        const live = this.power && this.programmed;

        // LED persistence + glow (halos share one Points cloud; per-vertex HDR colour)
        io.leds.forEach((led, i) => {
            const target = live ? led.target : 0;
            led.level += (target - led.level) * (1 - Math.exp(-dt / 0.06));
            this._paintLed(i, led.level);
        });
        if (this.powerLed) {
            const target = this.power ? 1 : 0;
            this.powerLed.level += (target - this.powerLed.level) * k;
            this.powerLed.material.emissiveIntensity = this.powerLed.level * 2.4;
            this.powerLed.glowMaterial.opacity = this.powerLed.level * 0.8;
        }

        // 7-seg multiplexing (A3): the rendered image is the **time-weighted
        // duty cycle** (lit ns / total ns) from the simulated capture, not a
        // frame count or a binary "ever lit".
        //   * scan >= 60 Hz  -> persistence of vision: every tube integrates
        //     into a steady image at its duty brightness (25% for a 1-of-4 mux).
        //   * scan < 60 Hz   -> no integration: show the instantaneous digit
        //     state so the display visibly steps/flickers tube by tube.
        const d = io.display;
        const instantaneous = isInstantaneousScan(this._scanHz);
        for (let i = 0; i < 32; i += 1) {
            if (instantaneous) {
                const target = live ? d.segTarget[i] : 0;
                d.segCurrent[i] += (target - d.segCurrent[i]) * (1 - Math.exp(-dt / 0.03));
            } else {
                const duty = this._dutyTotal > 0
                    ? Math.min(1, this._dutyLit[i] / this._dutyTotal)
                    : d.segHold[i];
                d.segHold[i] = duty;
                const target = live ? duty : 0;
                d.segCurrent[i] += (target - d.segCurrent[i]) * k;
            }
        }
        // Single paint pass with the studio-red POV gamma boost.
        this._paintDisplay();

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
        // buzzer shiver + pulse ring (A3/B4: visible + headless-testable)
        {
            const bz = io.buzzer;
            if (bz.on && live) this._ensureBuzzerRing();
            if (bz.on && live && !this.deterministic) {
                bz.phase += dt * 60;
                bz.body.position.y = bz.baseY + Math.sin(bz.phase) * 0.05;
            } else {
                bz.body.position.y += (bz.baseY - bz.body.position.y) * k;
            }
            const ring = this._buzzerRing;
            if (ring) {
                const on = bz.on && live;
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.012);
                ring.material.opacity += ((on ? 0.30 + 0.35 * pulse : 0) - ring.material.opacity) * (1 - Math.exp(-dt / 0.05));
                ring.scale.setScalar(1 + (on ? 0.10 * pulse : 0));
                ring.visible = ring.material.opacity > 0.01;
            }
        }
    }

    _ensureBuzzerRing() {
        if (this._buzzerRing || !this.io?.buzzer || !this.boardGroup) return;
        const p = this.io.buzzer.body.position;
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(8.2, 9.6, 40),
            new THREE.MeshBasicMaterial({
                color: 0x66ccff, transparent: true, opacity: 0,
                side: THREE.DoubleSide, depthWrite: false,
            }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.x, p.y + 4.9, p.z);
        ring.visible = false;
        ring.renderOrder = 4;
        this.boardGroup.add(ring);
        this._buzzerRing = ring;
    }

    // ------------------------------------------------------------- dispose ----
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        clearInterval(this._ioTimer);
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
