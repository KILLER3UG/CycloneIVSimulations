// interactions.js — pointer interactions on the 3D board: press-and-hold keys,
// DIP toggles, RESET press, power switch, hover tooltips and probe-point
// picking. Uses Board3D's public pickables/camera/renderer — nothing here
// edits the board module.

import * as THREE from "three";

export function createInteractions(board, host, h) {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const dom = board.renderer.domElement;
    let pressed = null; // {type, index}
    let downAt = null;

    function pick(event) {
        const rect = dom.getBoundingClientRect();
        ndc.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, board.camera);
        const targets = board.pickables || [];
        if (!targets.length) return null;
        const hits = raycaster.intersectObjects(targets, false);
        return hits.length ? hits[0] : null;
    }

    function nearestProbe(point, maxDist = 6) {
        let best = null;
        let bestD = maxDist * maxDist;
        for (const p of board.probePoints?.() || []) {
            const d = p.position.distanceToSquared
                ? p.position.distanceToSquared(point)
                : p.position.distanceTo(point) ** 2;
            if (d < bestD) { bestD = d; best = p; }
        }
        return best;
    }

    function handlePress(hit) {
        const ud = hit.object.userData || {};
        if (ud.kind === "button" && /^S[1-4]$/.test(ud.componentId || "")) {
            const index = Number(ud.componentId.slice(1)) - 1;
            board.pressKey(index, true);
            h.onKeyPress?.(index, true);
            pressed = { type: "key", index };
            return true;
        }
        if (ud.kind === "reset") {
            board.pressReset(true);
            h.onResetPress?.(true);
            pressed = { type: "reset" };
            return true;
        }
        return false;
    }

    dom.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        downAt = { x: e.clientX, y: e.clientY };
        const hit = pick(e);
        if (hit) handlePress(hit);
    });

    window.addEventListener("pointerup", () => {
        if (pressed?.type === "key") {
            board.pressKey(pressed.index, false);
            h.onKeyPress?.(pressed.index, false);
        }
        if (pressed?.type === "reset") {
            board.pressReset(false);
            h.onResetPress?.(false);
        }
        pressed = null;
    });

    dom.addEventListener("click", (e) => {
        // only treat as a click when the pointer barely moved (not an orbit drag)
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
        const hit = pick(e);
        if (!hit) return;
        const ud = hit.object.userData || {};
        if (ud.kind === "power-switch") {
            h.onPowerToggle?.();
            return;
        }
        if (ud.kind === "switch" && Number.isInteger(ud.elementIndex)) {
            h.onDipToggle?.(ud.elementIndex);
            return;
        }
        // probe-point picking (header pins, display pins, …)
        const probe = nearestProbe(hit.point);
        if (probe?.pinId) h.onProbe?.({ pinId: probe.pinId, label: probe.label || probe.pinId, componentId: probe.componentId });
    });

    // ------------------------------------------------------------ tooltip --
    const tip = document.createElement("div");
    tip.className = "board-tooltip hidden";
    tip.setAttribute("role", "tooltip");
    host.appendChild(tip);

    dom.addEventListener("pointermove", (e) => {
        const hit = pick(e);
        if (!hit) { tip.classList.add("hidden"); dom.style.cursor = "grab"; return; }
        const ud = hit.object.userData || {};
        if (!ud.componentId && !ud.label) { tip.classList.add("hidden"); return; }
        const probe = nearestProbe(hit.point, 5);
        const pinId = ud.pinId || probe?.pinId || null;
        const value = pinId ? h.getPinValue?.(pinId) : undefined;
        const rows = [
            `<div class="bt-title">${ud.label || ud.componentId}</div>`,
            ud.componentId ? `<div><span>Component</span><b>${ud.componentId}</b></div>` : "",
            pinId ? `<div><span>Pin</span><b>${pinId}</b></div>` : "",
            ud.polarity ? `<div><span>Polarity</span><b>${ud.polarity}</b></div>` : "",
            ud.kind ? `<div><span>Kind</span><b>${ud.kind}</b></div>` : "",
            value !== undefined && value !== null ? `<div><span>Value</span><b>${value}</b></div>` : "",
            probe?.pinId && !ud.pinId ? `<div><span>Net</span><b>${probe.pinId}</b></div>` : "",
        ].filter(Boolean).join("");
        tip.innerHTML = rows;
        const rect = host.getBoundingClientRect();
        let x = e.clientX - rect.left + 14;
        let y = e.clientY - rect.top + 14;
        x = Math.min(x, rect.width - 190);
        y = Math.min(y, rect.height - 90);
        tip.style.left = x + "px";
        tip.style.top = y + "px";
        tip.classList.remove("hidden");
        dom.style.cursor = /button|reset|switch/.test(ud.kind || "") ? "pointer" : "grab";
    }, { passive: true });

    dom.addEventListener("pointerleave", () => tip.classList.add("hidden"));

    return { tooltip: tip };
}
