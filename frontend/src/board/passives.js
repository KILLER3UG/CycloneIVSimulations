// passives.js — instanced 0805 resistor/capacitor clusters, tantalum caps and
// the three electrolytic capacitors, all positioned from parts.md clusters.

import * as THREE from "three";
import { LAYOUT, BOARD_TOP, worldX, worldZ } from "./layout.js";
import { mulberry32 } from "./util.js";

export function buildPassives(mats, seed = 77) {
    const group = new THREE.Group();
    group.name = "passives";
    const rng = mulberry32(seed);

    const clusters = LAYOUT.filter((r) => r.kind === "passives");
    let rCount = 0, cCount = 0, tCount = 0, ledCount = 0;
    for (const c of clusters) {
        for (const item of c.items) {
            if (item.t === "R") rCount += item.n;
            else if (item.t === "C") cCount += item.n;
            else if (item.t === "T") tCount += item.n;
            else if (item.t === "LED") ledCount += item.n;
        }
    }

    const rGeo = new THREE.BoxGeometry(2.0, 0.6, 1.25);
    const cGeo = new THREE.BoxGeometry(2.0, 0.6, 1.25);
    const tGeo = new THREE.BoxGeometry(3.2, 1.5, 2.2);
    const rInst = new THREE.InstancedMesh(rGeo, mats.resistor, Math.max(rCount, 1));
    const cInst = new THREE.InstancedMesh(cGeo, mats.capacitor, Math.max(cCount, 1));
    const tInst = new THREE.InstancedMesh(tGeo, mats.tantalum, Math.max(tCount, 1));
    rInst.receiveShadow = cInst.receiveShadow = tInst.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    let ri = 0, ci = 0, ti = 0;

    for (const c of clusters) {
        const total = c.items.reduce((a, it) => a + it.n, 0);
        let k = 0;
        for (const item of c.items) {
            for (let j = 0; j < item.n; j += 1) {
                const rowIdx = Math.floor(k / 5);
                const colIdx = k % 5;
                const perRow = Math.min(5, total - rowIdx * 5);
                const x = c.pos[0] + (colIdx - (perRow - 1) / 2) * 2.7 + (rng() - 0.5) * 0.4;
                const y = c.pos[1] + (rowIdx - 0.5) * 3.4 + (rng() - 0.5) * 0.3;
                const rot = rng() > 0.75 ? Math.PI / 2 : 0;
                q.setFromAxisAngle(up, rot);
                pos.set(worldX(x), BOARD_TOP + 0.3, worldZ(y));
                m.compose(pos, q, scl);
                if (item.t === "R") rInst.setMatrixAt(ri++, m);
                else if (item.t === "C") cInst.setMatrixAt(ci++, m);
                else if (item.t === "T") tInst.setMatrixAt(ti++, m);
                k += 1;
            }
        }
    }
    rInst.count = ri; cInst.count = ci; tInst.count = ti;
    rInst.instanceMatrix.needsUpdate = true;
    cInst.instanceMatrix.needsUpdate = true;
    tInst.instanceMatrix.needsUpdate = true;
    group.add(rInst, cInst, tInst);

    // ---- power-indicator LED D1 (red 0805, emissive only) -------------------
    let powerLed = null;
    const d1Cluster = clusters.find((c) => c.id === "R1_D1");
    if (d1Cluster) {
        const mat = mats.ledLens.clone();
        mat.emissive.setHex(0xff1e1e);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 1.3), mat);
        mesh.position.set(worldX(d1Cluster.pos[0] + 2.4), BOARD_TOP + 0.35, worldZ(d1Cluster.pos[1]));
        mesh.castShadow = true;
        group.add(mesh);
        powerLed = { mesh, material: mat, level: 0 };
    }

    // ---- electrolytic cans ---------------------------------------------------
    for (const def of LAYOUT.filter((r) => r.kind === "electrolytic")) {
        const [cx, cy] = def.pos;
        const can = new THREE.Mesh(
            new THREE.CylinderGeometry(def.dia / 2, def.dia / 2, def.h, 20),
            mats.electrolytic,
        );
        can.position.set(worldX(cx), BOARD_TOP + def.h / 2, worldZ(cy));
        can.castShadow = true;
        can.receiveShadow = true;
        can.userData = { componentId: def.id, kind: "electrolytic", pinId: null, polarity: null, label: def.label };
        group.add(can);
        const top = new THREE.Mesh(
            new THREE.CylinderGeometry(def.dia / 2 - 0.35, def.dia / 2 - 0.35, 0.3, 20),
            mats.silver,
        );
        top.position.set(worldX(cx), BOARD_TOP + def.h + 0.05, worldZ(cy));
        group.add(top);
    }

    return { group, powerLed };
}
