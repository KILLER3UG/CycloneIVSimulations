// debug.js — isolated dev harness for Board3D (served at
// /src/board/debug.html in the Vite dev server). Keeps board verification
// independent of the main app shell. Not part of the production build.

import "../styles.css";
import { Board3D } from "./index.js";

const host = document.getElementById("board-host");
const params = new URLSearchParams(location.search);
const board = new Board3D(host, { quality: params.get("quality") || "balanced", theme: "dark" });
board.mount();
board.setPreset(params.get("preset") || "iso");
window.__cyclone = { board, profile: null };

// muxed up-counter demo (logical values; the real app drives raw pins)
let counter = 0;
let frame = 0;
let last = performance.now();

function raf(now) {
    if (board._disposed) return;
    frame += 1;
    if (now - last > 280) { counter = (counter + 1) % 10000; last = now; }
    const digits = String(counter).padStart(4, "0").split("");
    const mux = frame % 4;
    const chars = digits.map((c, i) => (i === mux ? c : " "));
    board.applyCycle({
        leds: [counter & 1, counter & 2, counter & 4, counter & 8].map(Boolean),
        chars,
        digits: [1, 1, 1, 1],
        buzzer: Math.floor(now / 4000) % 4 === 3 && frame % 30 < 12,
    }, { time: now });
    for (let i = 0; i < 4; i += 1) board.setDip(i, ((counter >> (i + 2)) & 1) === 1);
    requestAnimationFrame(raf);
}
requestAnimationFrame(raf);
