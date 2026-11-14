// fpga.js — Altera Cyclone IV EP4CE6E22C8N, EQFP-144 at real scale:
// 22 × 22 mm epoxy body, 144 instanced gull-wing leads at 0.5 mm pitch,
// pin-1 dot, canvas laser-mark texture, decoupling caps, probe points.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeAll } from "./util.js";
import { LAYOUT, BOARD_TOP, worldX, worldZ } from "./layout.js";
import { chipMarkTexture, mulberry32 } from "./util.js";

export const EQFP_PINS = 144;
export const EQFP_PER_SIDE = 36;
export const EQFP_PITCH = 0.5;
export const EQFP_BODY = 22;
export const EQFP_LEAD_SPAN = 12.9; // body half (11) + gull-wing extension

/** EQFP-144 package pin number → (side, indexAlongSide). Pin 1 = NW corner. */
export function eqfpPinSide(pin) {
    const i = pin - 1;
    if (i < 36) return { side: "W", index: i };            // 1..36 west, N→S
    if (i < 72) return { side: "S", index: i - 36 };       // 37..72 south, W→E
    if (i < 108) return { side: "E", index: i - 72 };      // 73..108 east, S→N
    return { side: "N", index: i - 108 };                  // 109..144 north, E→W
}

/** Local offset (dx, dz) of a package pin relative to the body centre. */
export function eqfpPinOffset(pin) {
    const { side, index } = eqfpPinSide(pin);
    const t = (index - (EQFP_PER_SIDE - 1) / 2) * EQFP_PITCH;
    if (side === "W") return { dx: -EQFP_LEAD_SPAN, dz: t };
    if (side === "S") return { dx: t, dz: EQFP_LEAD_SPAN };
    if (side === "E") return { dx: EQFP_LEAD_SPAN, dz: -t };
    return { dx: -t, dz: -EQFP_LEAD_SPAN };
}

function leadGeometry() {
    const a = new THREE.BoxGeometry(1.6, 0.13, 0.34);
    a.translate(11.7, 0.52, 0);
    const b = new THREE.BoxGeometry(1.15, 0.11, 0.3);
    b.rotateZ(-0.62);
    b.translate(12.6, 0.3, 0);
    const c = new THREE.BoxGeometry(0.55, 0.12, 0.34);
    c.translate(13.1, 0.09, 0);
    return mergeAll([a, b, c]);
}

export function buildFPGA(mats, seed = 1234) {
    const group = new THREE.Group();
    group.name = "fpga";
    const def = LAYOUT.find((r) => r.id === "U5");
    const [cx, cy] = def.pos;
    const baseX = worldX(cx);
    const baseZ = worldZ(cy);
    const rng = mulberry32(seed);

    // ---- laser-mark canvas (top, includes the etched pin-1 dot) -------------
    // photo: the EQFP epoxy is dark grey, lighter than the PCB
    const markTex = chipMarkTexture([
        { text: "ALTERA", size: 13, weight: 700, dy: 0.12 },
        { text: "Cyclone IV", size: 17, weight: 700, italic: true, dy: 0.16 },
        { text: "EP4CE6E22C8N", size: 11, dy: 0.14 },
        { text: "L624 A2.2", size: 8, color: "rgba(200,210,220,0.55)", dy: 0.12 },
    ], 256, "#2c3036", { dot: true });
    markTex.rotation = 0;

    // ---- body ---------------------------------------------------------------
    const body = new THREE.Mesh(
        new RoundedBoxGeometry(EQFP_BODY, 1.15, EQFP_BODY, 2, 0.35),
        mats.chipBlack,
    );
    body.position.set(baseX, BOARD_TOP + 0.16, baseZ);
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData = { componentId: "U5", kind: "fpga", pinId: null, polarity: null, label: "U5 Cyclone IV" };
    group.add(body);

    const mark = new THREE.Mesh(
        new THREE.PlaneGeometry(EQFP_BODY - 0.5, EQFP_BODY - 0.5),
        new THREE.MeshStandardMaterial({ map: markTex, roughness: 0.4, metalness: 0.05 }),
    );
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(baseX, BOARD_TOP + 0.745, baseZ);
    group.add(mark);

    // ---- 144 gull-wing leads ------------------------------------------------
    const leadGeo = leadGeometry();
    const leads = new THREE.InstancedMesh(leadGeo, mats.gold, EQFP_PINS);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    const probePoints = [];
    for (let pin = 1; pin <= EQFP_PINS; pin += 1) {
        const { dx, dz } = eqfpPinOffset(pin);
        const side = eqfpPinSide(pin).side;
        const rot = side === "W" ? Math.PI / 2 : side === "S" ? Math.PI : side === "E" ? -Math.PI / 2 : 0;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
        pos.set(baseX + dx, BOARD_TOP, baseZ + dz);
        m.compose(pos, q, scl);
        leads.setMatrixAt(pin - 1, m);
        probePoints.push({
            pinId: `PIN_${pin}`,
            componentId: "U5",
            position: new THREE.Vector3(baseX + dx * 0.96, BOARD_TOP + 0.1, baseZ + dz * 0.96),
            label: `U5 pin ${pin}`,
        });
    }
    leads.instanceMatrix.needsUpdate = true;
    group.add(leads);

    // ---- decoupling caps ring (ASSUMED, deterministic) ----------------------
    const capGeo = new THREE.BoxGeometry(1.6, 0.55, 0.8);
    const caps = new THREE.InstancedMesh(capGeo, mats.capacitor, 14);
    caps.receiveShadow = true;
    for (let i = 0; i < 14; i += 1) {
        const a = (i / 14) * Math.PI * 2 + rng() * 0.2;
        const r = 14.6 + rng() * 1.6;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() > 0.5 ? Math.PI / 2 : 0);
        pos.set(baseX + Math.cos(a) * r, BOARD_TOP + 0.28, baseZ + Math.sin(a) * r * 0.82);
        m.compose(pos, q, scl);
        caps.setMatrixAt(i, m);
    }
    caps.instanceMatrix.needsUpdate = true;
    group.add(caps);

    return {
        group,
        probePoints,
        anchor: { id: "U5", object: body, radius: 16 },
    };
}
