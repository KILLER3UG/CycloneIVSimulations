// io.js — the interactive board elements: self-locking power switch, RESET
// key, 4 tact keys, red 4-pos DIP, 4 LEDs with lenses + glow sprites, the
// 3461BS-style 4-digit 7-segment display (8 individually-emissive segments
// per digit, one InstancedMesh) and the buzzer.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { PCB_OUTLINE, LAYOUT, BOARD_TOP, SEG_BIT_MAP_FALLBACK } from "./layout.js";
import { createCanvas, canvasTexture, glowTexture } from "./util.js";

// Segment geometry only — the bit map itself comes from board.json via
// layout.js (SEG_BIT_MAP_FALLBACK is the single exported fallback).
const SEG_OFFSETS = {
    a: [0, -4.4, "h"], b: [2.4, -2.2, "v"], c: [2.4, 2.2, "v"], d: [0, 4.4, "h"],
    e: [-2.4, 2.2, "v"], f: [-2.4, -2.2, "v"], g: [0, 0, "h"], dp: [3.7, 5.6, "dp"],
};
// real 0.36" digits lean the segment ring like an italic numeral (top to the
// right): shear x by −k·z, tilt the vertical bars by the same angle
const DIGIT_SLEW = 0.14;
// HDR studio-red → feeds bloom. Built directly in the linear working space:
// the red channel is pushed far past the key-lit whites' luminance so the
// bloom high-pass separates the tubes/silkscreen cleanly, while g/b stay at
// the shipped studio-red hue (0xff2b2b) instead of washing out to salmon.
export const LIT_COLOR = new THREE.Color().setRGB(13.0, 0.126, 0.126);
// unlit segments read as a recessed near-black diffuser on the charcoal housing
export const DARK_COLOR = new THREE.Color(0x18191c);

export function buildIO(mats, {
    pinIndex, segBitMap = SEG_BIT_MAP_FALLBACK, ledMeta = null, seed = 42,
    profile = null, model = null,
} = {}) {
    const group = new THREE.Group();
    group.name = "io";
    const pickables = [];
    const anchors = [];
    const probePoints = [];
    const pinOf = (pinId) => (pinIndex ? pinIndex.get(pinId) : null);
    // Imported boards describe their own footprints; the canonical board keeps
    // the hand-measured 58-part LAYOUT unchanged.
    const dyn = model && !model.isDefault ? model : null;
    const countOf = (node, fallback) => {
        const v = Number(node?.count ?? (Array.isArray(node?.pins) ? node.pins.length : undefined) ?? fallback);
        return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
    };
    const board = (profile && (profile.board || profile)) || {};
    const keyCount = dyn ? dyn.keys.length : 4;
    const dipCount = dyn ? (dyn.dip[0]?.positions ?? 0) : 4;
    const ledCount = dyn ? dyn.leds.length : countOf(board.leds, 4);
    const defOf = (canonicalId, dynamicDef) => (dyn ? dynamicDef : LAYOUT.find((r) => r.id === canonicalId));

    const bW = dyn ? dyn.pcb.w : PCB_OUTLINE.w;
    const bD = dyn ? dyn.pcb.d : PCB_OUTLINE.d;
    const wx = (cx) => cx - bW / 2;
    const wz = (cy) => cy - bD / 2;

    // ------------------------------------------------------------- power switch
    const powerSwitch = (() => {
        const canonical = LAYOUT.find((r) => r.id === "SW1");
        const pos = dyn?.powerPos || canonical.pos;
        const size = dyn ? [9, 6] : canonical.size;
        const [cx, cy] = pos;
        const x = wx(cx), z = wz(cy);
        const body = new THREE.Mesh(
            new RoundedBoxGeometry(size[0], 6.5, size[1], 1, 0.5), mats.silver);
        body.position.set(x, BOARD_TOP + 3.25, z);
        body.castShadow = true;
        body.userData = { componentId: "SW1", kind: "power-switch", pinId: null, polarity: null, label: "SW1 power (self-locking)" };
        group.add(body);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 5.2, 20), mats.red);
        cap.position.set(x, BOARD_TOP + 8.2, z + 1.2);
        cap.castShadow = true;
        cap.userData = { componentId: "SW1", kind: "power-switch", pinId: null, polarity: null, label: "Power" };
        group.add(cap);
        pickables.push(cap, body);
        return { cap, body, on: true, baseY: cap.position.y };
    })();

    // ----------------------------------------------------------------- keys
    // Photo: square silver metal shell + round near-black actuator cap.
    const mkKey = (def, userData) => {
        const [cx, cy] = def.pos;
        const x = wx(cx), z = wz(cy);
        const base = new THREE.Mesh(new RoundedBoxGeometry(7.2, 3.2, 7.2, 1, 0.5), mats.silver);
        base.position.set(x, BOARD_TOP + 1.6, z);
        base.castShadow = true;
        base.userData = { ...userData };
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.15, 2.35, 2.8, 18), mats.keyCap);
        cap.position.set(x, BOARD_TOP + 4.4, z);
        cap.castShadow = true;
        cap.userData = { ...userData };
        group.add(base, cap);
        pickables.push(cap);
        return { base, cap, pressed: false, baseY: cap.position.y, pressY: cap.position.y - 1.1 };
    };

    const keys = [];
    for (let i = 0; i < keyCount; i += 1) {
        const def = defOf(`S${i + 1}`, dyn ? dyn.keys[i] : null);
        if (!def || !Array.isArray(def.pos)) continue;
        const entry = pinOf(`KEY[${i}]`);
        const el = mkKey(def, {
            componentId: `S${i + 1}`, kind: "button", pinId: entry ? entry.pinId : `KEY[${i}]`,
            polarity: entry ? entry.polarity : "active-low", label: `KEY${i + 1} (S${i + 1})`,
        });
        keys.push(el);
        anchors.push({ id: `S${i + 1}`, object: el.base, radius: 6 });
        probePoints.push({
            pinId: entry ? entry.pinId : null, componentId: `S${i + 1}`,
            position: new THREE.Vector3(el.cap.position.x, el.cap.position.y + 1.6, el.cap.position.z),
            label: `KEY${i + 1}`,
        });
    }

    const canonicalReset = LAYOUT.find((r) => r.id === "RESET");
    const resetDef = dyn ? { pos: dyn.resetPos, size: [7, 8.7] } : canonicalReset;
    const resetEntry = pinOf("FPGA_RST");
    const reset = mkKey(resetDef, {
        componentId: "RESET", kind: "reset", pinId: resetEntry ? resetEntry.pinId : "FPGA_RST",
        polarity: "active-low", label: "RESET (active low)",
    });
    anchors.push({ id: "RESET", object: reset.base, radius: 6 });
    probePoints.push({
        pinId: resetEntry ? resetEntry.pinId : "FPGA_RST", componentId: "RESET",
        position: new THREE.Vector3(reset.cap.position.x, reset.cap.position.y + 1.6, reset.cap.position.z),
        label: "RESET",
    });

    // --------------------------------------------------------------- DIP switch
    const dip = (() => {
        if (dipCount <= 0) return [];
        const def = defOf("SW2", dyn?.dip?.[0]) || LAYOUT.find((r) => r.id === "SW2");
        if (!def || !Array.isArray(def.pos)) return [];
        const [cx, cy] = def.pos;
        const x = wx(cx), z = wz(cy);
        const body = new THREE.Mesh(new RoundedBoxGeometry(def.size[0], 6.8, def.size[1], 1, 0.5), mats.red);
        body.position.set(x, BOARD_TOP + 3.4, z);
        body.castShadow = true;
        body.userData = { componentId: "SW2", kind: "dip", pinId: null, polarity: null, label: "SW2 DIP 4-pos" };
        group.add(body);
        // "ON DIP" + channel numbers, printed white on the red body (photo)
        const markCanvas = createCanvas(256, 224);
        const mctx = markCanvas.getContext("2d");
        mctx.fillStyle = "rgba(240,242,244,0.95)";
        mctx.textAlign = "center";
        mctx.textBaseline = "middle";
        mctx.font = '700 40px "Segoe UI", Arial, sans-serif';
        mctx.fillText("ON", 78, 38);
        mctx.fillText("DIP", 178, 38);
        mctx.font = '600 34px "Segoe UI", Arial, sans-serif';
        const spacing = Math.min(57, 228 / Math.max(1, dipCount));
        for (let i = 0; i < dipCount; i += 1) mctx.fillText(String(i + 1), 42 + i * spacing, 196);
        const mark = new THREE.Mesh(
            new THREE.PlaneGeometry(def.size[0] - 1.4, def.size[1] - 1.4),
            new THREE.MeshBasicMaterial({ map: canvasTexture(markCanvas), transparent: true, toneMapped: false }),
        );
        mark.rotation.x = -Math.PI / 2;
        mark.position.set(x, BOARD_TOP + 6.82, z);
        group.add(mark);
        const levers = [];
        const leverStep = def.size[0] > 0 ? (def.size[0] - 4.2) / Math.max(1, dipCount - 1) : 2.8;
        for (let i = 0; i < dipCount; i += 1) {
            const entry = pinOf(`KEY[${i}]`);
            const lever = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.7, 3.2), mats.plasticWhite);
            lever.position.set(x - (def.size[0] / 2 - 2.1) + i * leverStep, BOARD_TOP + 7.4, z);
            lever.castShadow = true;
            lever.userData = {
                componentId: "SW2", kind: "switch", elementIndex: i,
                pinId: entry ? entry.pinId : `KEY[${i}]`,
                polarity: entry ? entry.polarity : "active-low", label: `DIP${i + 1}`,
            };
            group.add(lever);
            pickables.push(lever);
            levers.push({ lever, on: false, baseY: lever.position.y });
            probePoints.push({
                pinId: entry ? entry.pinId : null, componentId: "SW2",
                position: new THREE.Vector3(lever.position.x, lever.position.y + 1, lever.position.z),
                label: `DIP${i + 1}`,
            });
        }
        anchors.push({ id: "SW2", object: body, radius: 9 });
        return levers;
    })();

    // ------------------------------------------------------------------- LEDs
    // Lenses are individual meshes; the four glow halos share ONE Points object
    // (per-vertex HDR colour carries each LED's level — 1 draw call total).
    const leds = [];
    const glowPos = new Float32Array(ledCount * 3);
    const glowCol = new Float32Array(ledCount * 3);
    for (let i = 0; i < ledCount; i += 1) {
        const def = defOf(`LED${i + 1}`, dyn?.leds?.[i]);
        if (!def || !Array.isArray(def.pos)) continue;
        const [cx, cy] = def.pos;
        const x = wx(cx), z = wz(cy);
        const entry = pinOf(`LED[${i}]`);
        // Dual naming: LED[i] is the FPGA net on this pin, the physical diode
        // is D1..D4 and the silkscreen/net name runs the opposite way.
        const diode = ledMeta?.diodes?.[i];
        const net = ledMeta?.nets?.[i];
        const dual = diode && net ? ` / ${diode} (net ${net})` : "";
        const material = mats.ledLens.clone();
        material.emissive.setHex(0xff1e1e);
        material.emissiveIntensity = 0;
        const lens = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.85, 1.6), material);
        lens.position.set(x, BOARD_TOP + 0.45, z);
        lens.userData = {
            componentId: `LED${i + 1}`, kind: "led", elementIndex: i,
            pinId: entry ? entry.pinId : `LED[${i}]`,
            polarity: entry ? entry.polarity : "active-low", label: `LED${i + 1}${dual}`,
        };
        group.add(lens);
        glowPos[i * 3] = x;
        glowPos[i * 3 + 1] = BOARD_TOP + 1.7;
        glowPos[i * 3 + 2] = z;
        pickables.push(lens);
        leds.push({ lens, material, level: 0, target: 0 });
        probePoints.push({
            pinId: entry ? entry.pinId : null, componentId: `LED${i + 1}`,
            position: new THREE.Vector3(x, BOARD_TOP + 1.4, z),
            label: `LED${i + 1}${dual}`,
        });
    }
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPos, 3));
    glowGeo.setAttribute("color", new THREE.BufferAttribute(glowCol, 3).setUsage(THREE.DynamicDrawUsage));
    const glowPoints = new THREE.Points(glowGeo, new THREE.PointsMaterial({
        map: glowTexture(), size: 9, sizeAttenuation: true, vertexColors: true,
        transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glowPoints.renderOrder = 5;
    group.add(glowPoints);

    // --------------------------------------------------------- 7-seg display
    // Profiles may declare zero displays (e.g. the Terasic DE0-Nano has no
    // on-board tube): the mesh stays for API compatibility but is hidden.
    const displayPresent = !(dyn && Number(dyn.display?.count ?? 4) === 0);
    const display = (() => {
        const canonical = LAYOUT.find((r) => r.id === "DISP1");
        const def = dyn?.display || canonical;
        const [cx, cy] = Array.isArray(def?.pos) ? def.pos : canonical.pos;
        const x = wx(cx), z = wz(cy);
        const body = new THREE.Mesh(new RoundedBoxGeometry(30, 8, 16, 1, 0.6), mats.darkEpoxy);
        body.position.set(x, BOARD_TOP + 4, z);
        body.castShadow = true;
        body.visible = displayPresent;
        body.userData = { componentId: "DISP1", kind: "display", pinId: null, polarity: null, label: "DISP1 4-digit 7-seg" };
        group.add(body);

        const bitToName = Object.fromEntries(Object.entries(segBitMap).map(([n, b]) => [b, n]));
        const segGeo = new THREE.BoxGeometry(4.3, 0.16, 0.95);
        const segInst = new THREE.InstancedMesh(segGeo, mats.segmentBase, 32);
        segInst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(32 * 3), 3);
        segInst.instanceColor.setUsage(THREE.DynamicDrawUsage);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const pos = new THREE.Vector3();
        const scl = new THREE.Vector3(1, 1, 1);
        const segWorld = [];
        for (let d = 0; d < 4; d += 1) {
            // Hardware digit order (schematic trace, Diagrama sheet
            // "Display 7-Segmentos"): DIG[3]=DIG4→Q1→D1 = LEFTMOST tube;
            // DIG[0]=DIG1→Q4→D4 = RIGHTMOST tube. The digit index runs
            // right-to-left on the physical module.
            const digitX = 10.5 - d * 7;
            for (let bit = 0; bit < 8; bit += 1) {
                const name = bitToName[bit] || "g";
                const [ox, oz, kind] = SEG_OFFSETS[name] || SEG_OFFSETS.g;
                // italic shear: top (north, −z) leans right, verticals tilt by −SLEW
                const sx = ox - DIGIT_SLEW * oz;
                const sz = oz;
                const rot = kind === "v" ? Math.PI / 2 - DIGIT_SLEW : 0;
                q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
                const s = kind === "dp" ? new THREE.Vector3(0.5, 1, 0.55) : new THREE.Vector3(1, 1, 1);
                pos.set(x + digitX + sx, BOARD_TOP + 8.14, z + sz);
                m.compose(pos, q, s);
                segInst.setMatrixAt(d * 8 + bit, m);
                segInst.setColorAt(d * 8 + bit, DARK_COLOR);
                if (d === 0) {
                    segWorld.push({
                        bit, name,
                        position: new THREE.Vector3(x + digitX + sx, BOARD_TOP + 8.3, z + sz),
                    });
                }
            }
        }
        segInst.instanceMatrix.needsUpdate = true;
        segInst.instanceColor.needsUpdate = true;
        segInst.visible = displayPresent;
        group.add(segInst);

        // metal side tabs (vendor photo shows nickel tabs at both ends)
        for (const side of [-1, 1]) {
            const tab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 4.6), mats.steel);
            tab.position.set(x + side * 15.8, BOARD_TOP + 4.2, z);
            tab.castShadow = true;
            tab.visible = displayPresent;
            group.add(tab);
        }

        // 12 package pins (6 north, 6 south)
        const pinGeo = new THREE.BoxGeometry(0.6, 0.16, 1.8);
        const pins = new THREE.InstancedMesh(pinGeo, mats.gold, 12);
        let k = 0;
        for (let side = -1; side <= 1; side += 2) {
            for (let i = 0; i < 6; i += 1) {
                m.setPosition(x - 11.25 + i * 4.5, BOARD_TOP + 0.08, z + side * 7.6);
                pins.setMatrixAt(k++, m);
            }
        }
        pins.instanceMatrix.needsUpdate = true;
        pins.visible = displayPresent;
        group.add(pins);

        anchors.push({ id: "DISP1", object: body, radius: 17 });
        pickables.push(body);

        segWorld.forEach((s) => {
            const entry = pinOf(`SEG[${s.bit}]`);
            probePoints.push({
                pinId: entry ? entry.pinId : `SEG[${s.bit}]`, componentId: "DISP1",
                position: s.position, label: `SEG${s.bit} (${s.name})`,
            });
        });
        for (let d = 0; d < 4; d += 1) {
            const entry = pinOf(`DIG[${d}]`);
            probePoints.push({
                pinId: entry ? entry.pinId : `DIG[${d}]`, componentId: "DISP1",
                position: new THREE.Vector3(x + 10.5 - d * 7, BOARD_TOP + 8.4, z),
                label: `DIG${d + 1}`,
            });
        }

        return {
            segInst,
            segCurrent: new Float32Array(32),
            segTarget: new Float32Array(32),
            segHold: new Float32Array(32),
            segActive: new Uint8Array(8),
            digitOn: [1, 1, 1, 1],
            bitToName,
            present: displayPresent,
        };
    })();

    // ----------------------------------------------------------------- buzzer
    const buzzer = (() => {
        const canonical = LAYOUT.find((r) => r.id === "SP1");
        const def = dyn?.buzzer || canonical;
        const [cx, cy] = Array.isArray(def?.pos) ? def.pos : canonical.pos;
        const x = wx(cx), z = wz(cy);
        const entry = pinOf("FPGA_BUZZER");
        const body = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 7.5, 9, 28), mats.plasticBlack);
        body.position.set(x, BOARD_TOP + 4.5, z);
        body.castShadow = true;
        body.userData = {
            componentId: "SP1", kind: "buzzer",
            pinId: entry ? entry.pinId : "FPGA_BUZZER",
            polarity: entry ? entry.polarity : "active-low", label: "SP1 buzzer",
        };
        group.add(body);
        const hole = new THREE.Mesh(
            new THREE.CylinderGeometry(1.1, 1.1, 0.3, 12),
            new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.8 }),
        );
        hole.position.set(x, BOARD_TOP + 9.05, z);
        group.add(hole);
        pickables.push(body);
        probePoints.push({
            pinId: entry ? entry.pinId : "FPGA_BUZZER", componentId: "SP1",
            position: new THREE.Vector3(x, BOARD_TOP + 9.4, z), label: "BEEP",
        });
        return { body, on: false, phase: 0, baseY: body.position.y };
    })();

    anchors.push({ id: "SW1", object: powerSwitch.body, radius: 8 });
    probePoints.push({
        pinId: null, componentId: "SW1",
        position: new THREE.Vector3(powerSwitch.cap.position.x, powerSwitch.cap.position.y + 2.4, powerSwitch.cap.position.z),
        label: "POWER",
    });

    return {
        group, pickables, anchors, probePoints,
        leds, glowPoints, keys, dip, reset, powerSwitch, buzzer, display,
    };
}
