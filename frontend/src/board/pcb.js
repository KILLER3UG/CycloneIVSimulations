// pcb.js — 132 × 104 mm rounded-rect PCB with 4 mounting holes (gold rings)
// and a single silkscreen ATLAS canvas: branding, designators, traces, vias,
// gold pads and baked contact-shadow darkening under every component.

import * as THREE from "three";
import { PCB_OUTLINE, LAYOUT, BOARD_TOP } from "./layout.js";
import { createCanvas, canvasTexture, mulberry32 } from "./util.js";
import { pcbColorCss, applyPcbColor } from "./materials.js";

const S = 14; // canvas pixels per mm
const CW = Math.round(PCB_OUTLINE.w * S);
const CH = Math.round(PCB_OUTLINE.d * S);

// Mounting holes clamped inward (parts.md lists standoffs at the exact corners
// with ±4 mm uncertainty; holes must stay fully inside the board).
export const MOUNT_HOLES = [[5.5, 4.5], [126.5, 4.5], [5.5, 99.5], [126.5, 99.5]];

const GOLD = "rgba(206,168,70,0.95)";
const GOLD_SOFT = "rgba(206,168,70,0.55)";
const SILK = "rgba(233,239,244,0.93)";
const SILK_DIM = "rgba(210,220,228,0.8)";
// the vendor photo prints the branding in warm gold, not white
const SILK_GOLD = "rgba(206,172,96,0.95)";

export function paintSilkscreen(baseColor = "#141619") {
    const canvas = createCanvas(CW, CH);
    const ctx = canvas.getContext("2d");
    const px = (mm) => mm * S;
    const rng = mulberry32(0xa22c8e);

    // ---- base: solder mask colour comes from the active board profile ------
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, CW, CH);
    const shade = ctx.createRadialGradient(CW * 0.42, CH * 0.4, CH * 0.2, CW * 0.5, CH * 0.5, CW * 0.75);
    shade.addColorStop(0, "rgba(34,41,48,0.20)");
    shade.addColorStop(1, "rgba(0,0,0,0.26)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, CW, CH);

    // ---- copper traces (manhattan fan-out from the FPGA) -------------------
    ctx.strokeStyle = "rgba(44,78,60,0.5)";
    ctx.lineWidth = 1.7;
    const fpga = LAYOUT.find((r) => r.id === "U5");
    const [fx, fy] = fpga.pos;
    const via = (x, y) => {
        ctx.fillStyle = GOLD_SOFT;
        ctx.beginPath();
        ctx.arc(px(x), px(y), 1.5, 0, Math.PI * 2);
        ctx.fill();
    };
    for (let i = 0; i < 90; i += 1) {
        const side = i % 4;
        const t = rng();
        let x1, y1;
        if (side === 0) { x1 = fx - 13 - rng() * 20; y1 = fy - 12 + t * 24; }
        else if (side === 1) { x1 = fx + 13 + rng() * 20; y1 = fy - 12 + t * 24; }
        else if (side === 2) { x1 = fx - 13 + t * 26; y1 = fy - 13 - rng() * 18; }
        else { x1 = fx - 13 + t * 26; y1 = fy + 13 + rng() * 18; }
        const horiz = rng() > 0.5;
        const len = 4 + rng() * 14;
        const x2 = horiz ? x1 + (rng() > 0.5 ? len : -len) : x1;
        const y2 = horiz ? y1 : y1 + (rng() > 0.5 ? len : -len);
        ctx.beginPath();
        ctx.moveTo(px(x1), px(y1));
        ctx.lineTo(px(x2), px(y2));
        ctx.stroke();
        if (rng() > 0.5) via(x2, y2);
    }

    // ---- baked contact shadows under every part (cheap AO) -----------------
    ctx.save();
    ctx.filter = "blur(6px)";
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    for (const r of LAYOUT) {
        const positions = r.kind === "standoff" ? r.pos : [r.pos];
        for (const p of positions) {
            const w = Math.max(r.size[0], 3) + 2.4;
            const d = Math.max(r.size[1], 3) + 2.4;
            ctx.beginPath();
            ctx.roundRect(px(p[0] - w / 2), px(p[1] - d / 2), w * S, d * S, 4);
            ctx.fill();
        }
    }
    ctx.restore();

    // ---- gold pads ---------------------------------------------------------
    const pad = (x, y, r = 0.85, color = GOLD) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px(x), px(y), r * S, 0, Math.PI * 2);
        ctx.fill();
    };
    const padRect = (x, y, w, d, color = GOLD) => {
        ctx.fillStyle = color;
        ctx.fillRect(px(x - w / 2), px(y - d / 2), w * S, d * S);
    };

    // headers P1/P2/P3 + JTAG/AS grids
    for (const id of ["P1", "P2", "P3", "JTAG", "AS"]) {
        const r = LAYOUT.find((e) => e.id === id);
        if (!r) continue;
        const { rows, cols, pitch } = r;
        const alongX = r.axis === "x";
        for (let c = 0; c < cols; c += 1) {
            for (let rw = 0; rw < rows; rw += 1) {
                const a = (c - (cols - 1) / 2) * pitch;
                const b = (rw - (rows - 1) / 2) * pitch;
                if (alongX) pad(r.pos[0] + a, r.pos[1] + b, 0.85);
                else pad(r.pos[0] + b, r.pos[1] + a, 0.85);
            }
        }
    }

    // FPGA 144 pads around the 22 mm body
    {
        const half = 11 + 1.6; // body half + lead span
        const n = 36;
        for (let i = 0; i < n; i += 1) {
            const t = (i - (n - 1) / 2) * fpga.leadPitch;
            padRect(fx + t, fy - half, 0.8, 1.7);
            padRect(fx + t, fy + half, 0.8, 1.7);
            padRect(fx - half, fy + t, 1.7, 0.8);
            padRect(fx + half, fy + t, 1.7, 0.8);
        }
    }

    // display 12 pads (6 top, 6 bottom)
    {
        const d = LAYOUT.find((e) => e.id === "DISP1");
        for (let i = 0; i < 6; i += 1) {
            const x = d.pos[0] - 11.25 + i * 4.5;
            pad(x, d.pos[1] - 7, 0.7);
            pad(x, d.pos[1] + 7, 0.7);
        }
    }

    // LCD socket: 20 pads on a 2.54 mm row
    {
        const d = LAYOUT.find((e) => e.id === "LCD1");
        for (let i = 0; i < 20; i += 1) {
            padRect(d.pos[0] - d.size[0] / 2 + 1.27 + i * 2.54, d.pos[1], 1.2, 2.6);
        }
    }

    // tact keys + reset: 4 corner pads each
    for (const id of ["S1", "S2", "S3", "S4", "RESET"]) {
        const r = LAYOUT.find((e) => e.id === id);
        const [w, d] = [6, 6];
        pad(r.pos[0] - w / 2, r.pos[1] - d / 2, 0.6);
        pad(r.pos[0] + w / 2, r.pos[1] - d / 2, 0.6);
        pad(r.pos[0] - w / 2, r.pos[1] + d / 2, 0.6);
        pad(r.pos[0] + w / 2, r.pos[1] + d / 2, 0.6);
    }

    // LEDs + small ICs + passive clusters: simple twin pads
    for (const r of LAYOUT) {
        if (r.kind === "led") {
            padRect(r.pos[0] - 1.6, r.pos[1], 1.1, 1.3);
            padRect(r.pos[0] + 1.6, r.pos[1], 1.1, 1.3);
        } else if (r.kind === "ic" || r.kind === "regulator") {
            const n = r.package === "SOIC-8" ? 4 : r.package === "SOIC-16" ? 8 : 3;
            const span = r.size[1] - 1.6;
            for (let i = 0; i < n; i += 1) {
                const t = n === 3 ? (i - 1) * 2.3 : (i - (n - 1) / 2) * (span / (n - 1));
                padRect(r.pos[0] - r.size[0] / 2 + 0.4, r.pos[1] + t, 1.4, 0.7);
                padRect(r.pos[0] + r.size[0] / 2 - 0.4, r.pos[1] + t, 1.4, 0.7);
            }
        } else if (r.kind === "passives") {
            let n = 0;
            for (const item of r.items) n += item.n;
            for (let i = 0; i < n; i += 1) {
                const x = r.pos[0] + (i - (n - 1) / 2) * 2.4;
                padRect(x - 1, r.pos[1], 0.8, 1.1);
                padRect(x + 1, r.pos[1], 0.8, 1.1);
            }
        }
    }

    // ---- decorative gold edge pads ----------------------------------------
    for (let x = 8; x < PCB_OUTLINE.w - 6; x += 6.5) {
        padRect(x, 1.2, 1.6, 1.0, GOLD_SOFT);
        padRect(x, PCB_OUTLINE.d - 1.2, 1.6, 1.0, GOLD_SOFT);
    }

    // ---- silkscreen --------------------------------------------------------
    // font sizes are expressed at the S=12 baseline and scaled with the canvas
    const FS = S / 12;
    const text = (str, x, y, size = 22, color = SILK, rot = 0, weight = 600, align = "center") => {
        ctx.save();
        ctx.translate(px(x), px(y));
        if (rot) ctx.rotate(rot);
        ctx.fillStyle = color;
        ctx.font = `${weight} ${size * FS}px "Segoe UI", "Microsoft YaHei", Arial, sans-serif`;
        ctx.textAlign = align;
        ctx.textBaseline = "middle";
        ctx.fillText(str, 0, 0);
        ctx.restore();
    };

    // white printed-plate label "RZ-EasyFPGA A2.1" (vendor photo, top-right);
    // the 7-seg overlaps its left end, so right-align the text like the photo
    {
        const lx = px(95), ly = px(3.2), lw = px(27), lh = px(5.4);
        ctx.fillStyle = "rgba(238,240,242,0.95)";
        ctx.beginPath();
        ctx.roundRect(lx, ly, lw, lh, 3);
        ctx.fill();
        ctx.fillStyle = "rgba(16,18,20,0.96)";
        ctx.font = `700 ${19 * FS}px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText("RZ-EasyFPGA  A2.1", lx + lw - 2, ly + lh / 2 + 1);
    }
    text("RZ-EasyFPGA A2.2", 110, 12, 15, SILK_DIM, 0, 600);
    // branding (gold, positions from the top-down photo)
    text("睿智研发-助学", 40, 13, 24, SILK_GOLD);
    text("www.rzrd.net", 40, 18.5, 20, SILK_GOLD);
    // Cyclone IV logo with the four-point star
    ctx.save();
    ctx.translate(px(76.5), px(33));
    ctx.fillStyle = SILK;
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
        const a = (i * Math.PI) / 2;
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(Math.cos(a) * 16, Math.sin(a) * 16, Math.cos(a + Math.PI / 4) * 22, Math.sin(a + Math.PI / 4) * 22);
        ctx.quadraticCurveTo(Math.cos(a + Math.PI / 2) * 16, Math.sin(a + Math.PI / 2) * 16, 0, 0);
    }
    ctx.fill();
    ctx.restore();
    text("Cyclone IV", 84, 33, 46, SILK, 0, 700, "left");

    // designators (board_spec: U1–U10, P1–P3, AS, JTAG, RESET + parts.md)
    const des = (str, x, y, size = 22, color = SILK, rot = 0) => text(str, x, y, size, color, rot);
    des("U5", 38, 46);
    des("P1", 23, 29.5);
    des("P2", 23, 75);
    des("P3", 80, 42);
    des("AS", 5, 54);
    des("JTAG", 5.5, 87);
    des("RESET", 4.5, 83.5, 16);
    des("S1", 93, 84.5, 16); des("S2", 101, 84.5, 16); des("S3", 109, 84.5, 16); des("S4", 117, 84.5, 16);
    // LED row: "LED1" label left of the packed row + digit numbers above
    des("LED1", 68.5, 92.2, 13);
    des("1", 73.5, 86, 13); des("2", 76.7, 86, 13); des("3", 79.9, 86, 13); des("4", 83.1, 86, 13);
    des("SW", 92, 78.5);
    des("SP +", 97, 69);
    des("X1", 23, 71.5); text("50.000", 23, 61.5, 15, SILK_DIM);
    des("RW", 114, 27);
    des("LCD", 61, 7.5);
    des("U1", 17, 26, 18); des("U2", 26, 26, 18); des("U3", 35, 26, 18);
    text("3.3V", 21, 16.5, 14, SILK_DIM); text("1.2V", 30, 16.5, 14, SILK_DIM); text("2.5V", 39, 16.5, 14, SILK_DIM);
    text("5V", 3, 9, 15, SILK_DIM); text("USB供电", 27, 12.5, 15, SILK_DIM);
    des("U4", 112, 50.5, 18); des("U6", 60, 84); des("U7", 22, 59); des("U8", 87, 57); des("U9", 115, 57);
    des("U10", 124, 92.5, 16);
    des("RS232", 130, 59, 16, SILK_DIM);
    des("VGA", 129, 69.5, 18, SILK_DIM);
    des("PS", 132, 26.5, 16, SILK_DIM);
    for (const r of LAYOUT) {
        if (r.kind === "passives") des(r.label.split(" ")[0], r.pos[0], r.pos[1] + 3.4, 13, SILK_DIM);
        if (r.kind === "electrolytic") des(r.id, r.pos[0], r.pos[1] + r.size[1] / 2 + 2.4, 13, SILK_DIM);
    }
    // pin-1 markers
    const tri = (x, y, rot = 0) => {
        ctx.save();
        ctx.translate(px(x), px(y));
        ctx.rotate(rot);
        ctx.fillStyle = SILK;
        ctx.beginPath();
        ctx.moveTo(0, -6); ctx.lineTo(10, 5); ctx.lineTo(-10, 5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    };
    tri(23.2, 33, -Math.PI / 2);
    tri(27.5, 78, -Math.PI / 2);
    tri(75, 44.2, Math.PI);

    // mounting-hole gold rings
    for (const [hx, hy] of MOUNT_HOLES) {
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(px(hx), px(hy), 3.6 * S, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath();
        ctx.arc(px(hx), px(hy), 1.8 * S, 0, Math.PI * 2);
        ctx.fill();
    }

    return canvas;
}

/** Lightweight silkscreen for imported boards (no canonical 58-part atlas). */
export function paintDynamicSilkscreen(model, baseColor = "#141619") {
    const w = model.pcb.w;
    const d = model.pcb.d;
    const cw = Math.round(w * S);
    const ch = Math.round(d * S);
    const canvas = createCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    const px = (mm) => mm * S;
    const rng = mulberry32(0x51de0);

    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, cw, ch);
    const shade = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.1, cw / 2, ch / 2, cw * 0.75);
    shade.addColorStop(0, "rgba(40,48,56,0.16)");
    shade.addColorStop(1, "rgba(0,0,0,0.30)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, cw, ch);

    // deterministic copper fan-out around the FPGA
    ctx.strokeStyle = "rgba(44,78,60,0.5)";
    ctx.lineWidth = 1.6;
    const [fx, fy] = model.fpga.pos;
    for (let i = 0; i < 64; i += 1) {
        const a = rng() * Math.PI * 2;
        const r = 12 + rng() * Math.min(w, d) * 0.35;
        ctx.beginPath();
        ctx.moveTo(px(fx), px(fy));
        ctx.lineTo(px(fx + Math.cos(a) * r), px(fy + Math.sin(a) * r));
        ctx.stroke();
    }

    const label = (text, x, y, size = 18, color = SILK) => {
        ctx.fillStyle = color;
        ctx.font = `600 ${size * (S / 12)}px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, px(x), px(y));
    };

    // component designators from the dynamic model
    for (const led of model.leds) label(`LED${led.index + 1}`, led.pos[0], led.pos[1] + 2.8, 11, SILK_DIM);
    for (const key of model.keys) label(`KEY${key.index + 1}`, key.pos[0], key.pos[1] - 5.8, 12, SILK_DIM);
    if (model.dip.length) label("SW DIP", model.dip[0].pos[0], model.dip[0].pos[1] - 7.5, 13, SILK_DIM);
    if (model.display.count > 0) label("DISP", model.display.pos[0], model.display.pos[1] - 10, 13, SILK_DIM);
    if (model.buzzer.present) label("BUZZER", model.buzzer.pos[0], model.buzzer.pos[1] - 10, 13, SILK_DIM);
    label(model.name, w / 2, 3.5, 17, SILK_GOLD);

    // gold mounting-hole rings
    for (const [hx, hy] of model.mountHoles) {
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 2.1;
        ctx.beginPath();
        ctx.arc(px(hx), px(hy), 3.2 * S, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath();
        ctx.arc(px(hx), px(hy), 1.6 * S, 0, Math.PI * 2);
        ctx.fill();
    }
    return canvas;
}

function roundedRectShape(w, d, r) {
    const shape = new THREE.Shape();
    const x = -w / 2, y = -d / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + d - r);
    shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    shape.lineTo(x + r, y + d);
    shape.quadraticCurveTo(x, y + d, x, y + d - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    return shape;
}

export function buildPCB(mats, { profile = null, model = null } = {}) {
    const group = new THREE.Group();
    group.name = "pcb";

    applyPcbColor(mats, profile);
    const baseColor = model?.pcbColor || pcbColorCss(profile);
    const outline = model?.pcb || PCB_OUTLINE;
    const boardW = Number(outline.w) || PCB_OUTLINE.w;
    const boardD = Number(outline.d) || PCB_OUTLINE.d;
    const thickness = Number(outline.thickness) || PCB_OUTLINE.thickness;
    const cornerRadius = Number(outline.cornerRadius) || PCB_OUTLINE.cornerRadius;

    const silkCanvas = model && !model.isDefault
        ? paintDynamicSilkscreen(model, baseColor)
        : paintSilkscreen(baseColor);
    const silk = canvasTexture(silkCanvas, { anisotropy: 16 });
    silk.offset.set(0.5, 0.5);
    silk.repeat.set(1 / boardW, 1 / boardD);
    silk.wrapS = silk.wrapT = THREE.ClampToEdgeWrapping;

    const topMat = mats.pcbTop.clone();
    topMat.map = silk;
    topMat.color.setHex(0xffffff);

    const shape = roundedRectShape(boardW, boardD, cornerRadius);
    const holes = model?.mountHoles || MOUNT_HOLES;
    for (const [hx, hy] of holes) {
        const hole = new THREE.Path();
        hole.absarc(hx - boardW / 2, boardD / 2 - hy, 1.7, 0, Math.PI * 2, true);
        shape.holes.push(hole);
    }
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: false,
        curveSegments: 24,
    });
    const pcb = new THREE.Mesh(geo, [topMat, mats.pcbSide]);
    pcb.rotation.x = -Math.PI / 2;
    pcb.position.y = 0; // extrude goes +y after rotation; top face at BOARD_TOP
    pcb.castShadow = true;
    pcb.receiveShadow = true;
    pcb.userData = { componentId: "PCB", kind: "pcb" };
    group.add(pcb);

    // gold annular rings + brass M3 standoffs at the corners (instanced)
    const mpPos = model?.mountHoles || (LAYOUT.find((r) => r.id === "MP")?.pos || MOUNT_HOLES);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const corners = mpPos.map(([mx, my]) => {
        const x = clamp(mx, 5.5, boardW - 5.5) - boardW / 2;
        const y = clamp(my, 4.5, boardD - 4.5) - boardD / 2;
        return [x, y];
    });

    const mkInstanced = (geo, mat, placement, { receive = false, cast = false, rotX = 0 } = {}) => {
        const inst = new THREE.InstancedMesh(geo, mat, corners.length);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rotX);
        corners.forEach(([x, y], i) => {
            m.compose(
                new THREE.Vector3(x, placement[0], y),
                q,
                new THREE.Vector3(1, 1, 1),
            );
            inst.setMatrixAt(i, m);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.receiveShadow = receive;
        inst.castShadow = cast;
        group.add(inst);
        return inst;
    };

    mkInstanced(new THREE.RingGeometry(1.9, 4.1, 32), mats.gold, [BOARD_TOP + 0.02], { receive: true, rotX: -Math.PI / 2 });
    const standoffs = mkInstanced(new THREE.CylinderGeometry(4, 4, 11, 24), mats.brass, [BOARD_TOP + 5.5], { cast: true });
    standoffs.userData = { componentId: "MP", kind: "standoff", pinId: null, polarity: null, label: "M3 standoffs" };
    mkInstanced(new THREE.CylinderGeometry(2.6, 2.6, 1.6, 16), mats.steel, [BOARD_TOP + 11.8]);
    mkInstanced(new THREE.BoxGeometry(4.4, 0.7, 0.9), mats.plasticBlack, [BOARD_TOP + 12.6]);

    return { group, silkTexture: silk };
}
