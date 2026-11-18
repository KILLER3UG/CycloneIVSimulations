// util.js — small shared helpers for the board builders (canvas textures,
// deterministic RNG, geometry conveniences). No three.js scene logic here.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** mulberry32 — tiny deterministic PRNG for screenshot-stable builds. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createCanvas(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
}

// Silkscreen, laser chip markings and text labels are viewed at grazing angles
// on a tilted board: 16x anisotropic filtering keeps them razor sharp.
export function canvasTexture(canvas, { srgb = true, anisotropy = 16 } = {}) {
    const tex = new THREE.CanvasTexture(canvas);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Chip top-marking texture: white/grey laser-style text on black epoxy.
 * lines: array of {text, size, weight?, italic?, color?, dy?}
 * opts.dot: draw an etched pin-1 dot at the bottom-left.
 */
export function chipMarkTexture(lines, size = 256, bg = "#0b0c0f", opts = {}) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    // faint epoxy speckle
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    for (let i = 0; i < 140; i += 1) {
        ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
    }
    if (opts.dot) {
        ctx.fillStyle = "rgba(0,0,0,0.9)";
        ctx.beginPath();
        ctx.arc(size * 0.16, size * 0.84, size * 0.045, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const total = lines.reduce((a, l) => a + (l.dy || 0.14), 0);
    let y = size * (0.5 - total / 2.4);
    for (const line of lines) {
        const px = (line.size / 100) * size;
        ctx.font = `${line.italic ? "italic " : ""}${line.weight || 600} ${px}px "Segoe UI", Arial, sans-serif`;
        ctx.fillStyle = line.color || "rgba(226,232,238,0.9)";
        ctx.fillText(line.text, size / 2, y);
        y += (line.dy || 0.14) * size;
    }
    return canvasTexture(canvas);
}

/** Radial glow sprite texture (white core → transparent). */
export function glowTexture() {
    const size = 128;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.14)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return canvasTexture(canvas, { srgb: true, anisotropy: 2 });
}

/** Simple text label texture on transparent background. */
export function labelTexture(text, {
    font = '600 42px "Segoe UI", Arial, sans-serif',
    color = "rgba(235,240,245,0.95)",
    pad = 12,
} = {}) {
    const measure = createCanvas(8, 8).getContext("2d");
    measure.font = font;
    const w = Math.ceil(measure.measureText(text).width) + pad * 2;
    const h = 64 + pad * 2;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2);
    return { texture: canvasTexture(canvas, { anisotropy: 16 }), aspect: w / h };
}

/** mergeGeometries wrapper that normalizes indexed/non-indexed inputs. */
export function mergeAll(geometries) {
    const flat = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
    return mergeGeometries(flat);
}

export function disposeObject(root) {
    root.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
        for (const m of mats) {
            for (const key of Object.keys(m)) {
                const v = m[key];
                if (v && v.isTexture) v.dispose();
            }
            m.dispose();
        }
    });
}
