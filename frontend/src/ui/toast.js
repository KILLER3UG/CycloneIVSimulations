// toast.js — transient notifications + the keyboard cheat-sheet dialog.

let host = null;

function ensureHost() {
    if (!host) {
        host = document.createElement("div");
        host.className = "toast-host";
        host.setAttribute("aria-live", "polite");
        document.body.appendChild(host);
    }
    return host;
}

export function toast(message, { kind = "info", timeout = 3200, action = null } = {}) {
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    el.setAttribute("role", "status");
    const msgSpan = document.createElement("span");
    msgSpan.textContent = message;
    el.appendChild(msgSpan);
    const dismiss = () => {
        el.classList.remove("show");
        setTimeout(() => el.remove(), 260);
    };
    if (action?.label) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "toast-action";
        btn.textContent = action.label;
        btn.addEventListener("click", () => {
            action.onClick?.();
            dismiss();
        });
        el.appendChild(btn);
    }
    ensureHost().appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const timer = setTimeout(dismiss, timeout);
    el.addEventListener("click", () => clearTimeout(timer), { once: true });
}

export function dialog({ title, body, actions = [], wide = false }) {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
        <div class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="modal-head">
                <span>${title}</span>
                <button class="icon-btn modal-close" type="button" aria-label="Close dialog">${"&#215;"}</button>
            </div>
            <div class="modal-body"></div>
            <div class="modal-actions"></div>
        </div>`;
    const bodyEl = wrap.querySelector(".modal-body");
    if (typeof body === "string") bodyEl.innerHTML = body;
    else bodyEl.appendChild(body);
    const actionsEl = wrap.querySelector(".modal-actions");
    const close = () => wrap.remove();
    for (const a of actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `btn ${a.kind || ""}`;
        btn.textContent = a.label;
        btn.addEventListener("click", () => { a.onClick?.(); if (a.closes !== false) close(); });
        actionsEl.appendChild(btn);
    }
    if (!actions.length) actionsEl.remove();
    wrap.querySelector(".modal-close").addEventListener("click", close);
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    return close;
}

export function cheatSheet() {
    const rows = [
        ["Ctrl+Enter", "Compile & load onto virtual board"],
        ["Esc", "Stop the running simulation"],
        ["\u2190 / \u2192", "Step \u22121 / +1 cycle (while paused)"],
        ["+ / \u2212", "Zoom the 3D board in / out"],
        ["F", "Fit the board in the view"],
        ["1 / 2 / 3 / 4", "Camera: top / front / 45\u00b0 / ports"],
        ["P", "Toggle board power"],
        ["T", "Toggle light / dark theme"],
        ["Ctrl+B", "Toggle left sidebar"],
        ["Ctrl+\\", "Toggle right sidebar"],
        ["Ctrl+Alt+B", "Toggle bottom panel"],
    ];
    const table = document.createElement("table");
    table.className = "cheat-table";
    table.innerHTML = rows
        .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${v}</td></tr>`)
        .join("");
    dialog({ title: "Keyboard shortcuts", body: table, actions: [{ label: "Got it", kind: "primary" }] });
}
