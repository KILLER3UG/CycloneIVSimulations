// lcd3d.js — 3D HD44780 1602 character LCD with a live 5×8 dot-matrix
// CanvasTexture. The glass sits on the LCD1 socket of the A2.2 and renders
// the DDRAM contents (plus the cursor) exactly like the real module.
import * as THREE from "three";
import { BOARD_TOP } from "./layout.js";

// Standard HD44780 5×8 font, rows top→bottom, bit4 = leftmost column.
// Indexed by char code (32..126); custom chars (0..7) come from CGRAM.
const FONT5x8 = {
    " ": [0, 0, 0, 0, 0, 0, 0, 0], "!": [4, 4, 4, 4, 4, 0, 4, 0], '"': [10, 10, 10, 0, 0, 0, 0, 0],
    "#": [10, 10, 31, 10, 31, 10, 10, 0], $: [4, 30, 5, 14, 20, 15, 4, 0], "%": [24, 25, 2, 4, 8, 19, 19, 0],
    "&": [12, 18, 18, 12, 21, 18, 13, 0], "'": [4, 4, 8, 0, 0, 0, 0, 0], "(": [2, 4, 8, 8, 8, 4, 2, 0],
    ")": [8, 4, 2, 2, 2, 4, 8, 0], "*": [0, 4, 21, 14, 21, 4, 0, 0], "+": [0, 4, 4, 31, 4, 4, 0, 0],
    ",": [0, 0, 0, 0, 12, 4, 8, 0], "-": [0, 0, 0, 31, 0, 0, 0, 0], ".": [0, 0, 0, 0, 12, 12, 0, 0],
    "/": [1, 1, 2, 4, 8, 16, 16, 0], "0": [14, 17, 19, 21, 25, 17, 14, 0], "1": [4, 12, 4, 4, 4, 4, 14, 0],
    "2": [14, 17, 1, 2, 4, 8, 31, 0], "3": [31, 2, 4, 2, 1, 17, 14, 0], "4": [2, 6, 10, 18, 31, 2, 2, 0],
    "5": [31, 16, 30, 1, 1, 17, 14, 0], "6": [6, 8, 16, 30, 17, 17, 14, 0], "7": [31, 1, 2, 4, 8, 8, 8, 0],
    "8": [14, 17, 17, 14, 17, 17, 14, 0], "9": [14, 17, 17, 15, 1, 2, 12, 0], ":": [0, 12, 12, 0, 12, 12, 0, 0],
    ";": [0, 12, 12, 0, 12, 4, 8, 0], "<": [2, 4, 8, 16, 8, 4, 2, 0], "=": [0, 0, 31, 0, 31, 0, 0, 0],
    ">": [8, 4, 2, 1, 2, 4, 8, 0], "?": [14, 17, 1, 2, 4, 0, 4, 0], "@": [14, 17, 1, 13, 21, 21, 14, 0],
    A: [14, 17, 17, 31, 17, 17, 17, 0], B: [30, 17, 17, 30, 17, 17, 30, 0], C: [14, 17, 16, 16, 16, 17, 14, 0],
    D: [28, 18, 17, 17, 17, 18, 28, 0], E: [31, 16, 16, 30, 16, 16, 31, 0], F: [31, 16, 16, 30, 16, 16, 16, 0],
    G: [14, 17, 16, 23, 17, 17, 15, 0], H: [17, 17, 17, 31, 17, 17, 17, 0], I: [14, 4, 4, 4, 4, 4, 14, 0],
    J: [7, 2, 2, 2, 2, 18, 12, 0], K: [17, 18, 20, 24, 20, 18, 17, 0], L: [16, 16, 16, 16, 16, 16, 31, 0],
    M: [17, 27, 21, 21, 17, 17, 17, 0], N: [17, 25, 21, 19, 17, 17, 17, 0], O: [14, 17, 17, 17, 17, 17, 14, 0],
    P: [30, 17, 17, 30, 16, 16, 16, 0], Q: [14, 17, 17, 17, 21, 18, 13, 0], R: [30, 17, 17, 30, 20, 18, 17, 0],
    S: [15, 16, 16, 14, 1, 1, 30, 0], T: [31, 4, 4, 4, 4, 4, 4, 0], U: [17, 17, 17, 17, 17, 17, 14, 0],
    V: [17, 17, 17, 17, 10, 10, 4, 0], W: [17, 17, 17, 21, 21, 27, 17, 0], X: [17, 10, 10, 4, 10, 10, 17, 0],
    Y: [17, 10, 10, 4, 4, 4, 4, 0], Z: [31, 1, 2, 4, 8, 16, 31, 0], "[": [14, 8, 8, 8, 8, 8, 14, 0],
    "\\": [16, 16, 8, 4, 2, 1, 1, 0], "]": [14, 2, 2, 2, 2, 2, 14, 0], "^": [4, 10, 17, 0, 0, 0, 0, 0],
    _: [0, 0, 0, 0, 0, 0, 31, 0], "`": [8, 4, 2, 0, 0, 0, 0, 0], a: [0, 0, 14, 1, 15, 17, 15, 0],
    b: [16, 16, 30, 17, 17, 17, 30, 0], c: [0, 0, 15, 16, 16, 16, 15, 0], d: [1, 1, 15, 17, 17, 17, 15, 0],
    e: [0, 0, 14, 17, 31, 16, 14, 0], f: [2, 4, 15, 4, 4, 4, 4, 0], g: [0, 0, 15, 17, 17, 15, 1, 14],
    h: [16, 16, 30, 17, 17, 17, 17, 0], i: [4, 0, 12, 4, 4, 4, 14, 0], j: [2, 0, 6, 2, 2, 2, 18, 12],
    k: [16, 16, 18, 20, 24, 20, 18, 0], l: [12, 4, 4, 4, 4, 4, 14, 0], m: [0, 0, 26, 21, 21, 21, 21, 0],
    n: [0, 0, 30, 17, 17, 17, 17, 0], o: [0, 0, 14, 17, 17, 17, 14, 0], p: [0, 0, 30, 17, 17, 30, 16, 16],
    q: [0, 0, 15, 17, 17, 15, 1, 1], r: [0, 0, 23, 18, 16, 16, 16, 0], s: [0, 0, 15, 16, 14, 1, 30, 0],
    t: [8, 8, 30, 8, 8, 8, 6, 0], u: [0, 0, 17, 17, 17, 19, 13, 0], v: [0, 0, 17, 17, 10, 10, 4, 0],
    w: [0, 0, 17, 21, 21, 27, 17, 0], x: [0, 0, 17, 10, 4, 10, 17, 0], y: [0, 0, 17, 17, 17, 15, 1, 14],
    z: [0, 0, 31, 2, 4, 8, 31, 0], "{": [6, 2, 2, 4, 2, 2, 6, 0], "|": [4, 4, 4, 4, 4, 4, 4, 0],
    "}": [12, 8, 8, 4, 8, 8, 12, 0], "~": [0, 0, 8, 21, 2, 0, 0, 0],
};

/** Glyph rows for one character code (CGRAM 0..7 use the 64-byte table). */
export function glyphRows(code, cgram) {
    if (code < 8 && Array.isArray(cgram) && cgram.length >= (code + 1) * 8) {
        const rows = [];
        for (let r = 0; r < 8; r += 1) rows.push(cgram[code * 8 + r] & 0x1f);
        return rows;
    }
    return FONT5x8[String.fromCharCode(code)] || FONT5x8["?"] || [0, 0, 0, 0, 0, 0, 4, 0];
}

/**
 * Build the 1602 module: green PCB + bezel + glass with a live CanvasTexture
 * of 16×2 5×8 dot-matrix characters. `pos` = {x, z} socket centre; the glass
 * is sized to the socket footprint.
 */
export function createLcd3d(mats, pos, size = { w: 52, d: 12 }) {
    const group = new THREE.Group();
    const canvas = document.createElement("canvas");
    canvas.width = 16 * 24 + 16;
    canvas.height = 2 * 40 + 12;
    const ctx = canvas.getContext("2d");
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;

    const pcb = new THREE.Mesh(
        new THREE.BoxGeometry(size.w, 1.6, size.d),
        new THREE.MeshStandardMaterial({ color: 0x14501f, roughness: 0.6, metalness: 0.05 }),
    );
    pcb.position.set(pos.x, BOARD_TOP + 4.9, pos.z);
    pcb.castShadow = true;
    group.add(pcb);

    const glassMat = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(size.w - 4, size.d - 3.2), glassMat);
    glass.rotation.x = -Math.PI / 2;
    glass.position.set(pos.x, BOARD_TOP + 5.75, pos.z);
    group.add(glass);

    const bezel = new THREE.Mesh(
        new THREE.BoxGeometry(size.w + 1.2, 1.2, size.d + 1.2),
        new THREE.MeshStandardMaterial({ color: 0x1b2733, roughness: 0.5, metalness: 0.1 }),
    );
    bezel.position.set(pos.x, BOARD_TOP + 5.3, pos.z);
    group.add(bezel);

    let lastKey = "";
    function update(state) {
        const lines = (state && state.lines) || ["", ""];
        const cgram = (state && state.cgram) || [];
        const cursor = Number(state && state.cursor) || 0;
        const key = `${lines[0]}|${lines[1]}|${cursor}`;
        if (key === lastKey) return;
        lastKey = key;
        ctx.fillStyle = "#1a2f1a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const drawChar = (code, cx, cy) => {
            const rows = glyphRows(code, cgram);
            for (let r = 0; r < 8; r += 1) {
                for (let c = 0; c < 5; c += 1) {
                    if (rows[r] & (1 << (4 - c))) {
                        ctx.fillStyle = "#0d3b13";
                        ctx.fillRect(cx + c * 4 + 1, cy + r * 4 + 1, 3, 3);
                    }
                }
            }
        };
        for (let col = 0; col < 16; col += 1) {
            drawChar(lines[0]?.charCodeAt(col) ?? 32, 6 + col * 24, 8);
            drawChar(lines[1]?.charCodeAt(col) ?? 32, 6 + col * 24, 48);
        }
        if (cursor >= 0 && cursor < 32) {
            const col = cursor % 16;
            const row = Math.floor(cursor / 16) % 2;
            ctx.strokeStyle = "rgba(120,255,140,0.85)";
            ctx.strokeRect(5 + col * 24, 7 + row * 40, 22, 36);
        }
        texture.needsUpdate = true;
    }

    update({ lines: ["", ""], cursor: -1, cgram: [] });
    return { group, update, texture };
}
