// headers.js — P1 (19×2), P2 (22×2), P3 (10×2) yellow 2.54 mm headers with
// instanced gold pins. Per-pin labels are rendered onto canvas label planes
// from the profile's headerLayouts (built by layout.buildPinIndex) — never
// hard-coded. Unknown slots stay unlabelled.

import * as THREE from "three";
import { LAYOUT, BOARD_TOP, worldX, worldZ } from "./layout.js";
import { createCanvas, canvasTexture } from "./util.js";

const PXMM = 12;
const RAIL_COLOR = { GND: "#9fb0bd", "3V3": "#ff9d5c", "5V": "#ff5c5c" };

function labelCanvas(header, sideEntries, lengthMm) {
    const w = Math.ceil(lengthMm * PXMM);
    const h = 110;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const n = sideEntries.length;
    sideEntries.forEach((e, i) => {
        if (!e || !e.label) return;
        const x = (i + 0.5) * (w / n);
        ctx.save();
        ctx.translate(x, h / 2);
        ctx.fillStyle = e.rail ? (RAIL_COLOR[e.rail] || "#fff") : "rgba(238,244,248,0.95)";
        ctx.font = `600 26px "Segoe UI", "Microsoft YaHei", Arial, sans-serif`;
        const label = String(e.label).replace(/\[|\]/g, "");
        // rotate long labels to fit vertically-ish (still readable from south)
        if (label.length > 4) {
            ctx.rotate(-Math.PI / 2);
            ctx.font = `600 22px "Segoe UI", "Microsoft YaHei", Arial, sans-serif`;
        }
        ctx.fillText(label, 0, 0);
        ctx.restore();
    });
    return canvasTexture(canvas, { anisotropy: 6 });
}

export function buildHeaders(mats, headerLayouts = {}) {
    const group = new THREE.Group();
    group.name = "headers";
    const pickables = [];
    const anchors = [];
    const probePoints = [];

    for (const def of LAYOUT.filter((r) => r.kind === "header")) {
        const { id, rows, cols, pitch, axis, size } = def;
        const layout = headerLayouts[id] || null;
        const alongX = axis === "x";
        const lengthMm = alongX ? size[0] : size[1];
        const [cx, cy] = def.pos;
        const hx = worldX(cx);
        const hz = worldZ(cy);

        const base = new THREE.Mesh(
            new THREE.BoxGeometry(alongX ? lengthMm : size[0], 2.6, alongX ? size[1] : lengthMm),
            mats.headerYellow,
        );
        base.position.set(hx, BOARD_TOP + 1.3, hz);
        base.castShadow = true;
        base.receiveShadow = true;
        base.userData = { componentId: id, kind: "header", pinId: null, polarity: null, label: `${id} header ${cols}×${rows}` };
        group.add(base);
        pickables.push(base);
        anchors.push({ id, object: base, radius: lengthMm * 0.7 });

        // dark slot channel between the two pin rows (photo: black insert in
        // the yellow shroud so the individual pins read)
        const slot = new THREE.Mesh(
            new THREE.BoxGeometry(alongX ? lengthMm - 1.2 : 1.7, 0.6, alongX ? 1.7 : lengthMm - 1.2),
            mats.darkEpoxy,
        );
        slot.position.set(hx, BOARD_TOP + 2.55, hz);
        group.add(slot);

        // gold pins (short protrusion above the shroud, darker gold like the photo)
        const total = rows * cols;
        const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 4.8, 0.64), mats.goldDark, total);
        const m = new THREE.Matrix4();
        const positions = [];
        let k = 0;
        for (let col = 0; col < cols; col += 1) {
            for (let rw = 0; rw < rows; rw += 1) {
                const along = (rw - (rows - 1) / 2) * pitch;
                const across = (col - (cols - 1) / 2) * pitch;
                const px = alongX ? hx + across : hx + along;
                const pz = alongX ? hz + along : hz + across;
                m.setPosition(px, BOARD_TOP + 2.6 + 2.4, pz);
                pins.setMatrixAt(k, m);
                positions.push({ x: px, z: pz, col, row: rw });
                k += 1;
            }
        }
        pins.instanceMatrix.needsUpdate = true;
        group.add(pins);

        // probe points: slot order = col-major (col 0 first) matching layout.js
        if (layout) {
            layout.entries.forEach((e, slot) => {
                const col = slot < rows ? 0 : 1;
                const rw = slot % rows;
                const p = positions.find((q) => q.col === col && q.row === rw) || positions[slot];
                if (!p) return;
                probePoints.push({
                    pinId: e.pinId || null,
                    componentId: id,
                    position: new THREE.Vector3(p.x, BOARD_TOP + 7.6, p.z),
                    label: e.label || (e.rail ? e.rail : null) || `${id}.${slot + 1}`,
                    rail: e.rail || null,
                });
            });
        } else {
            positions.forEach((p, i) => {
                probePoints.push({
                    pinId: null,
                    componentId: id,
                    position: new THREE.Vector3(p.x, BOARD_TOP + 7.6, p.z),
                    label: `${id}.${i + 1}`,
                });
            });
        }

        // label planes (canvas atlas), one per side
        if (layout) {
            const colA = layout.entries.slice(0, rows);
            const colB = layout.entries.slice(rows, rows * 2);
            const sides = alongX
                ? [[colA, -1], [colB, 1]]
                : [[colA, -1], [colB, 1]];
            for (const [entries, sideSign] of sides) {
                if (!entries.some((e) => e && e.label)) continue;
                const tex = labelCanvas(def, entries, lengthMm);
                const plane = new THREE.Mesh(
                    new THREE.PlaneGeometry(lengthMm, 9.2),
                    new THREE.MeshBasicMaterial({
                        map: tex, transparent: true, depthWrite: false, toneMapped: false,
                        side: THREE.DoubleSide,
                    }),
                );
                const holder = new THREE.Group();
                if (!alongX) holder.rotation.y = -Math.PI / 2;
                plane.rotation.x = -Math.PI / 2;
                const off = (alongX ? size[1] : size[0]) / 2 + 2.4;
                plane.position.set(0, 0.05, sideSign * off);
                holder.add(plane);
                holder.position.set(hx, BOARD_TOP + 0.06, hz);
                // rotate the label text 180° so it reads from the south edge
                plane.rotation.z = sideSign > 0 ? Math.PI : 0;
                group.add(holder);
            }
        }
    }

    return { group, pickables, anchors, probePoints };
}
