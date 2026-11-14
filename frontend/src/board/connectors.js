// connectors.js — DC jack, USB-B, DB9 RS232, blue VGA DB15, PS/2 mini-DIN,
// boxed JTAG/AS 2×5 headers, IR receiver, 20-pin LCD socket and the blue
// contrast trimmer. Edge connectors overhang the PCB edge like the photos.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeAll } from "./util.js";
import { LAYOUT, BOARD_TOP, worldX, worldZ } from "./layout.js";

const def = (id) => LAYOUT.find((r) => r.id === id);
const at2 = (id) => {
    const [x, y] = def(id).pos;
    return [worldX(x), worldZ(y)];
};

export function buildConnectors(mats) {
    const group = new THREE.Group();
    group.name = "connectors";
    const pickables = [];
    const anchors = [];

    const box = (w, h, d, mat, x, y, z, r = 0) => {
        const mesh = new THREE.Mesh(
            r > 0 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d),
            mat,
        );
        mesh.position.set(x, y, z);
        mesh.castShadow = Math.max(w, h, d) > 9;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };
    const tag = (mesh, id, kind, label) => {
        mesh.userData = { componentId: id, kind, pinId: null, polarity: null, label };
        pickables.push(mesh);
        const p = mesh.geometry.parameters || {};
        anchors.push({ id, object: mesh, radius: Math.max(p.width || p.radius || 12, 12) });
        return mesh;
    };

    // ---- J1 DC jack ----------------------------------------------------------
    {
        const [x, z] = at2("J1");
        const body = box(11, 10.5, 11.8, mats.plasticBlack, x, BOARD_TOP + 5.25, z, 0.8);
        tag(body, "J1", "dc-jack", "J1 DC 5V jack");
        const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 3.5, 20), mats.brass);
        sleeve.rotation.z = Math.PI / 2;
        sleeve.position.set(x - 5.5 - 1.2, BOARD_TOP + 6.2, z);
        sleeve.castShadow = true;
        group.add(sleeve);
    }

    // ---- USB1 USB-B (power only) ---------------------------------------------
    {
        const [x, z] = at2("USB1");
        const shell = box(15, 10.5, 16.3, mats.silver, x, BOARD_TOP + 5.25, z, 0.6);
        tag(shell, "USB1", "usb-b", "USB-B power");
        const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.5, 1.6), mats.gold, 4);
        const m = new THREE.Matrix4();
        for (let i = 0; i < 4; i += 1) {
            m.setPosition(x - 1.9 + i * 1.27, BOARD_TOP + 1.2, z + 6.5);
            pins.setMatrixAt(i, m);
        }
        pins.instanceMatrix.needsUpdate = true;
        group.add(pins);
    }

    // ---- PS2 mini-DIN 6 --------------------------------------------------------
    {
        const [x, z] = at2("PS2");
        const shield = box(17.6, 11, 19.1, mats.silver, x, BOARD_TOP + 5.5, z, 1.2);
        tag(shield, "PS2", "ps2", "PS/2 mini-DIN");
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 7, 24), mats.steel);
        barrel.rotation.z = Math.PI / 2;
        barrel.position.set(x + 8.8 + 2.5, BOARD_TOP + 6.4, z);
        barrel.castShadow = true;
        group.add(barrel);
    }

    // ---- DB9 RS232 ---------------------------------------------------------------
    {
        const [x, z] = at2("DB9");
        const hood = box(25, 13, 33, mats.plasticBlack, x, BOARD_TOP + 6.5, z, 3);
        tag(hood, "DB9", "db9", "DB9 RS232 (TX=7 RX=8)");
        const shell = box(4, 10, 26, mats.silver, x + 11.5, BOARD_TOP + 6.2, z, 0.8);
        const pins = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.45, 3.2, 10), mats.gold, 9);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        let k = 0;
        for (let row = 0; row < 2; row += 1) {
            const n = row === 0 ? 5 : 4;
            for (let i = 0; i < n; i += 1) {
                m.compose(
                    new THREE.Vector3(x + 14.4, BOARD_TOP + (row === 0 ? 9.4 : 4.6), z + (i - (n - 1) / 2) * 2.77),
                    q, new THREE.Vector3(1, 1, 1),
                );
                pins.setMatrixAt(k++, m);
            }
        }
        pins.instanceMatrix.needsUpdate = true;
        group.add(pins);
        // two jack-post hex nuts on the face (photo shows the threaded posts)
        const nuts = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.5, 1.5, 2.2, 6), mats.silver, 2);
        for (const [i, dz] of [-12.5, 12.5].entries()) {
            m.compose(new THREE.Vector3(x + 12.4, BOARD_TOP + 10.6, z + dz), q, new THREE.Vector3(1, 1, 1));
            nuts.setMatrixAt(i, m);
        }
        nuts.instanceMatrix.needsUpdate = true;
        group.add(nuts);
    }

    // ---- VGA DB15 (blue hood) ------------------------------------------------------
    {
        const [x, z] = at2("VGA");
        // hood ≈ 24 mm into the board, 26 mm face — vendor photo proportions
        const hood = box(24, 13.5, 26, mats.blue, x, BOARD_TOP + 6.75, z, 3);
        tag(hood, "VGA", "vga", "VGA DB15 (8 colours)");
        const shell = box(5, 11.4, 30, mats.silver, x + 11.5, BOARD_TOP + 6.6, z, 1);
        const pins = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, 3, 10), mats.gold, 15);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        let k = 0;
        for (let row = 0; row < 3; row += 1) {
            const n = row === 1 ? 7 : 4;
            for (let i = 0; i < n; i += 1) {
                m.compose(
                    new THREE.Vector3(x + 14.6, BOARD_TOP + 4.2 + row * 3.2, z + (i - (n - 1) / 2) * 2.77),
                    q, new THREE.Vector3(1, 1, 1),
                );
                pins.setMatrixAt(k++, m);
            }
        }
        pins.instanceMatrix.needsUpdate = true;
        group.add(pins);
        const nuts = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 6), mats.silver, 2);
        for (const [i, dz] of [-11.5, 11.5].entries()) {
            m.compose(new THREE.Vector3(x + 13.6, BOARD_TOP + 11.3, z + dz), q, new THREE.Vector3(1, 1, 1));
            nuts.setMatrixAt(i, m);
        }
        nuts.instanceMatrix.needsUpdate = true;
        group.add(nuts);
    }

    // ---- JTAG / AS boxed 2×5 headers -------------------------------------------------
    for (const id of ["JTAG", "AS"]) {
        const d = def(id);
        const [x, z] = at2(id);
        // body + cavity + key notch merged into one black mesh
        const bodyGeo = new RoundedBoxGeometry(10.2, 9.5, 25.4, 1, 0.5);
        const cavity = new THREE.BoxGeometry(6.6, 1.5, 21);
        cavity.translate(0, 4.15, 0);
        const notch = new THREE.BoxGeometry(1.4, 2.2, 1.4);
        notch.translate(-4.6, 3.45, -11);
        const merged = mergeAll([bodyGeo, cavity, notch]);
        const body = new THREE.Mesh(merged, mats.plasticBlack);
        body.position.set(x, BOARD_TOP + 4.75, z);
        body.castShadow = true;
        body.receiveShadow = true;
        body.userData = { componentId: id, kind: "boxed-header", pinId: null, polarity: null, label: `${id} config header` };
        group.add(body);
        tag(body, id, "boxed-header", `${id} config header`);
        const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 5.5, 0.64), mats.gold, 10);
        const m = new THREE.Matrix4();
        let k = 0;
        for (let col = 0; col < 2; col += 1) {
            for (let rw = 0; rw < 5; rw += 1) {
                m.setPosition(
                    x + (col - 0.5) * 2.54,
                    BOARD_TOP + 7.6,
                    z + (rw - 2) * 2.54,
                );
                pins.setMatrixAt(k++, m);
            }
        }
        pins.instanceMatrix.needsUpdate = true;
        group.add(pins);
    }

    // ---- U10 IR receiver (photo: full metal shield can) -----------------------------
    {
        const [x, z] = at2("U10");
        const body = box(10, 7.5, 5, mats.silver, x, BOARD_TOP + 3.75, z, 0.6);
        tag(body, "U10", "ir", "U10 IR receiver");
        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(2.4, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshPhysicalMaterial({ color: 0x3a4048, roughness: 0.3, metalness: 0.7, clearcoat: 0.6 }),
        );
        dome.position.set(x - 1.5, BOARD_TOP + 7.4, z);
        group.add(dome);
        const pinParts = [];
        for (let i = -1; i <= 1; i += 1) {
            const p = new THREE.BoxGeometry(0.5, 0.12, 1.4);
            p.translate(2.5 + i * 1.6, 0, 0);
            pinParts.push(p);
        }
        const pins = new THREE.Mesh(mergeAll(pinParts), mats.gold);
        pins.position.set(x, BOARD_TOP + 0.06, z);
        group.add(pins);
    }

    // ---- LCD1 20-pin socket --------------------------------------------------------------
    {
        const [x, z] = at2("LCD1");
        const d = def("LCD1");
        // base + two side rails merged into one black mesh
        const baseGeo = new THREE.BoxGeometry(d.size[0], 2.2, d.size[1]);
        const railNorth = new THREE.BoxGeometry(d.size[0], 4.2, 1.3);
        railNorth.translate(0, 2.1, -(d.size[1] / 2 - 0.65));
        const railSouth = new THREE.BoxGeometry(d.size[0], 4.2, 1.3);
        railSouth.translate(0, 2.1, d.size[1] / 2 - 0.65);
        const merged = mergeAll([baseGeo, railNorth, railSouth]);
        const base = new THREE.Mesh(merged, mats.plasticBlack);
        base.position.set(x, BOARD_TOP + 1.1, z);
        base.castShadow = true;
        base.receiveShadow = true;
        group.add(base);
        tag(base, "LCD1", "lcd-socket", "LCD1 1602/12864 socket");
        const slots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 1.4, 3.4), mats.plasticBlack, 20);
        const m = new THREE.Matrix4();
        for (let i = 0; i < 20; i += 1) {
            m.setPosition(x - d.size[0] / 2 + 1.27 + i * 2.54, BOARD_TOP + 2.0, z);
            slots.setMatrixAt(i, m);
        }
        slots.instanceMatrix.needsUpdate = true;
        group.add(slots);
        // gold socket contacts inside the channel (visible from the south, photo)
        const contacts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.5, 1.2), mats.gold, 20);
        for (let i = 0; i < 20; i += 1) {
            m.setPosition(x - d.size[0] / 2 + 1.27 + i * 2.54, BOARD_TOP + 2.4, z + 1.1);
            contacts.setMatrixAt(i, m);
        }
        contacts.instanceMatrix.needsUpdate = true;
        group.add(contacts);
        // pin-1 keying notch at the west end of the socket
        const notch = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 1.6), mats.plasticBlack);
        notch.position.set(x - d.size[0] / 2 + 0.8, BOARD_TOP + 2.2, z + d.size[1] / 2 - 0.9);
        group.add(notch);
    }

    // ---- RW contrast trimmer -----------------------------------------------------------
    {
        const [x, z] = at2("RW");
        const body = box(8.7, 6, 12.1, mats.blue, x, BOARD_TOP + 3, z, 0.4);
        tag(body, "RW", "trimmer", "RW 10k contrast trimmer");
        const screw = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 1.6, 14), mats.brass);
        screw.position.set(x, BOARD_TOP + 6.7, z);
        group.add(screw);
    }

    return { group, pickables, anchors };
}
