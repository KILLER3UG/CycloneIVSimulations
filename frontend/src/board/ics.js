// ics.js — the non-FPGA integrated circuits at real package scale, each with a
// canvas top-marking carrying the right part number:
//   U6  HY57V641620 SDRAM (TSOP-II 54)          U4  SP3232/MAX3232E (SOIC-16)
//   U7  EPCS16 config flash (SOIC-16)           U8  AT24C08 EEPROM (SOIC-8)
//   U9  LM75A temp sensor (SOIC-8)              U1-U3  AMS1117 (SOT-223) ×3
//   Q1-Q5 S8550 (SOT-23) digit/buzzer drivers

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeAll } from "./util.js";
import { LAYOUT, BOARD_TOP, worldX, worldZ } from "./layout.js";
import { chipMarkTexture } from "./util.js";

const markCache = new Map();
function marking(lines) {
    const key = lines.join("|");
    if (!markCache.has(key)) markCache.set(key, chipMarkTexture(lines.map((t) => ({ text: t, size: 15, dy: 0.2 })), 128));
    return markCache.get(key);
}

function topPlane(w, d, tex, y) {
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.05 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    return mesh;
}

function addPins(group, mats, { count, pitch, axis, at, span, size = [0.5, 0.14, 1.3] }) {
    // two rows of gull-wing-ish flat leads on the long sides
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const n = count * 2;
    const inst = new THREE.InstancedMesh(geo, mats.gold, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    const pts = [];
    let k = 0;
    for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < count; i += 1) {
            const t = (i - (count - 1) / 2) * pitch;
            const off = (span / 2 - size[2] / 2) * side;
            if (axis === "x") pos.set(at[0] + t, BOARD_TOP + 0.07, at[1] + off);
            else pos.set(at[0] + off, BOARD_TOP + 0.07, at[1] + t);
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), axis === "x" ? (side < 0 ? Math.PI : 0) : (side < 0 ? Math.PI / 2 : -Math.PI / 2));
            m.compose(pos, q, scl);
            inst.setMatrixAt(k, m);
            pts.push({ x: pos.x, y: BOARD_TOP + 0.1, z: pos.z, n: (side < 0 ? 1 : count + 1) + i });
            k += 1;
        }
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    return pts;
}

function soic(mats, def, { pinsPerSide, mark, pinSpan, bodyW }) {
    const group = new THREE.Group();
    group.name = def.id;
    const [w, d] = def.size; // w = length along pins, d = span across leads
    const [cx, cy] = def.pos;
    const at = [worldX(cx), worldZ(cy)];
    const body = new THREE.Mesh(
        new RoundedBoxGeometry(w, 1.5, bodyW, 1, 0.25),
        mats.chipBlack,
    );
    body.position.set(at[0], BOARD_TOP + 0.85, at[1]);
    body.castShadow = true;
    body.userData = { componentId: def.id, kind: "ic", pinId: null, polarity: null, label: `${def.id} ${mark[0]}` };
    group.add(body);
    const markMesh = topPlane(w - 0.8, bodyW - 0.6, marking(mark), BOARD_TOP + 1.62);
    markMesh.position.x = at[0];
    markMesh.position.z = at[1];
    group.add(markMesh);
    const pinPts = addPins(group, mats, {
        count: pinsPerSide, pitch: 1.27, axis: "x", at, span: d,
        size: [0.6, 0.14, 1.5],
    });
    const probePoints = pinPts.map((p) => ({
        pinId: null, componentId: def.id,
        position: new THREE.Vector3(p.x, p.y, p.z),
        label: `${def.id}.${p.n}`,
    }));
    return { group, probePoints, anchor: { id: def.id, object: body, radius: Math.max(w, d) * 0.9 } };
}

function tsop54(mats, def) {
    const group = new THREE.Group();
    group.name = def.id;
    const [w, d] = def.size; // 22.2 × 11.8
    const [cx, cy] = def.pos;
    const at = [worldX(cx), worldZ(cy)];
    const body = new THREE.Mesh(
        new RoundedBoxGeometry(w, 1.1, d - 2.2, 1, 0.2),
        mats.chipBlack,
    );
    body.position.set(at[0], BOARD_TOP + 0.66, at[1]);
    body.castShadow = true;
    body.userData = { componentId: "U6", kind: "ic", pinId: null, polarity: null, label: "U6 HY57V641620 SDRAM" };
    group.add(body);
    const markMesh = topPlane(w - 1.2, d - 3.0, marking(["HY57V641620", "HYNIX 6W15", "KOREA"]), BOARD_TOP + 1.24);
    markMesh.position.set(at[0], BOARD_TOP + 1.24, at[1]);
    group.add(markMesh);
    const pinPts = addPins(group, mats, {
        count: 27, pitch: 0.76, axis: "x", at, span: d,
        size: [0.42, 0.12, 1.3],
    });
    const probePoints = pinPts.map((p) => ({
        pinId: null, componentId: "U6",
        position: new THREE.Vector3(p.x, p.y, p.z),
        label: `U6.${p.n}`,
    }));
    return { group, probePoints, anchor: { id: "U6", object: body, radius: 15 } };
}

function sot223(mats, def) {
    const group = new THREE.Group();
    group.name = def.id;
    const [w, d] = def.size; // 6.5 × 7
    const [cx, cy] = def.pos;
    const x = worldX(cx), z = worldZ(cy);
    const body = new THREE.Mesh(
        new RoundedBoxGeometry(w, 1.8, d - 1.4, 1, 0.2),
        mats.chipBlack,
    );
    body.position.set(x, BOARD_TOP + 1.0, z);
    body.castShadow = true;
    body.userData = { componentId: def.id, kind: "regulator", pinId: null, polarity: null, label: `${def.id} ${def.marking}` };
    group.add(body);
    const markMesh = topPlane(w - 0.8, d - 2.2, marking([def.marking]), BOARD_TOP + 1.92);
    markMesh.position.set(x, BOARD_TOP + 1.92, z);
    group.add(markMesh);
    // 3 leads south + tab north, merged into one gold mesh
    const parts = [];
    for (let i = -1; i <= 1; i += 1) {
        const lead = new THREE.BoxGeometry(0.65, 0.16, 2.0);
        lead.translate(i * 2.3, 0, (d - 1.4) / 2 + 0.8);
        parts.push(lead);
    }
    const tab = new THREE.BoxGeometry(3.6, 0.16, 1.6);
    tab.translate(0, 0, -(d - 1.4) / 2 - 0.6);
    parts.push(tab);
    const leads = new THREE.Mesh(mergeAll(parts), mats.gold);
    leads.position.set(x, BOARD_TOP + 0.08, z);
    group.add(leads);
    const probePoints = [-1, 0, 1].map((i) => ({
        pinId: null, componentId: def.id,
        position: new THREE.Vector3(x + i * 2.3, BOARD_TOP + 0.1, z + (d - 1.4) / 2 + 1),
        label: `${def.id}.${i + 2}`,
    }));
    return { group, probePoints, anchor: { id: def.id, object: body, radius: 6 } };
}

export function buildICs(mats) {
    const group = new THREE.Group();
    group.name = "ics";
    const probePoints = [];
    const anchors = [];
    const pickables = [];

    const U = (id) => LAYOUT.find((r) => r.id === id);

    for (const id of ["U1", "U2", "U3"]) {
        const r = sot223(mats, U(id));
        group.add(r.group); probePoints.push(...r.probePoints); anchors.push(r.anchor); pickables.push(r.anchor.object);
    }
    for (const id of ["U4", "U7"]) {
        const r = soic(mats, U(id), { pinsPerSide: 8, mark: [U(id).marking, U(id).fn], pinSpan: U(id).size[1], bodyW: U(id).size[1] - 2.1 });
        group.add(r.group); probePoints.push(...r.probePoints); anchors.push(r.anchor); pickables.push(r.anchor.object);
    }
    for (const id of ["U8", "U9"]) {
        const r = soic(mats, U(id), { pinsPerSide: 4, mark: [U(id).marking], pinSpan: U(id).size[0], bodyW: U(id).size[1] - 2.1 });
        // SOIC-8: leads on the long (7.5 mm) sides → swap axes
        r.group.children.forEach((c) => c);
        group.add(r.group); probePoints.push(...r.probePoints); anchors.push(r.anchor); pickables.push(r.anchor.object);
    }
    const u6 = tsop54(mats, U("U6"));
    group.add(u6.group); probePoints.push(...u6.probePoints); anchors.push(u6.anchor); pickables.push(u6.anchor.object);

    // Q1–Q5 S8550 (SOT-23): Q1–Q4 digit drivers at their cluster position,
    // Q5 near the buzzer (ASSUMED). One InstancedMesh per part type.
    const qCluster = LAYOUT.find((r) => r.id === "Q1_4");
    const qSpots = [];
    for (let i = 0; i < 4; i += 1) {
        qSpots.push([worldX(qCluster.pos[0] + (i - 1.5) * 3.0), worldZ(qCluster.pos[1])]);
    }
    qSpots.push([worldX(85), worldZ(76)]);

    // TO-92 cans: round black bodies (photo shows cylindrical 8550s, not SOT-23)
    const qBodyGeo = new THREE.CylinderGeometry(1.9, 1.9, 2.2, 14);
    const qMarkGeo = new THREE.PlaneGeometry(2.3, 1.9);
    const qLeadParts = [];
    for (let i = -1; i <= 1; i += 1) {
        const lead = new THREE.BoxGeometry(0.36, 0.1, 0.9);
        lead.translate(i * 1.05, 0, 1.5);
        qLeadParts.push(lead);
    }
    const qLeadGeo = mergeAll(qLeadParts);
    const qBodies = new THREE.InstancedMesh(qBodyGeo, mats.chipBlack, qSpots.length);
    const qMarks = new THREE.InstancedMesh(qMarkGeo, new THREE.MeshStandardMaterial({ map: marking(["8550"]), roughness: 0.42, metalness: 0.05 }), qSpots.length);
    const qLeads = new THREE.InstancedMesh(qLeadGeo, mats.gold, qSpots.length);
    qBodies.castShadow = true;
    const qm = new THREE.Matrix4();
    const qId = new THREE.Quaternion();
    const qOne = new THREE.Vector3(1, 1, 1);
    qSpots.forEach(([x, z], i) => {
        qm.compose(new THREE.Vector3(x, BOARD_TOP + 1.1, z), qId, qOne);
        qBodies.setMatrixAt(i, qm);
        qm.compose(new THREE.Vector3(x, BOARD_TOP + 2.21, z), qId, qOne);
        qMarks.setMatrixAt(i, qm);
        qm.compose(new THREE.Vector3(x, BOARD_TOP + 0.05, z), qId, qOne);
        qLeads.setMatrixAt(i, qm);
    });
    qBodies.instanceMatrix.needsUpdate = true;
    qMarks.instanceMatrix.needsUpdate = true;
    qLeads.instanceMatrix.needsUpdate = true;
    qBodies.userData = { componentId: "Q1_4", kind: "ic", pinId: null, polarity: null, label: "Q1–Q5 8550 drivers" };
    group.add(qBodies, qMarks, qLeads);
    pickables.push(qBodies);
    const qAnchor = new THREE.Object3D();
    qAnchor.position.set(worldX(qCluster.pos[0]), BOARD_TOP, worldZ(qCluster.pos[1]));
    group.add(qAnchor);
    anchors.push({ id: "Q1_4", object: qAnchor, radius: 8 });

    // X1 50 MHz active oscillator — silver can, "50.000" laser mark
    {
        const x1 = U("X1");
        const [cx1, cy1] = x1.pos;
        const x = worldX(cx1), z = worldZ(cy1);
        const can = new THREE.Mesh(
            new RoundedBoxGeometry(x1.size[0], 4.2, x1.size[1], 1, 0.5),
            mats.silver,
        );
        can.position.set(x, BOARD_TOP + 2.1, z);
        can.castShadow = true;
        can.userData = { componentId: "X1", kind: "oscillator", pinId: null, polarity: null, label: "X1 50.000 MHz" };
        group.add(can);
        const markMesh = topPlane(x1.size[0] - 1.4, x1.size[1] - 1.4, marking(["50.000"]), BOARD_TOP + 4.22);
        markMesh.position.set(x, BOARD_TOP + 4.22, z);
        group.add(markMesh);
        const pinGeo = new THREE.BoxGeometry(0.5, 0.14, 1.2);
        for (const [dx, dz] of [[-3.5, -2.2], [3.5, -2.2], [-3.5, 2.2], [3.5, 2.2]]) {
            const pin = new THREE.Mesh(pinGeo, mats.gold);
            pin.position.set(x + dx, BOARD_TOP + 0.07, z + dz);
            group.add(pin);
        }
        pickables.push(can);
        anchors.push({ id: "X1", object: can, radius: 8 });
    }

    return { group, probePoints, anchors, pickables };
}
