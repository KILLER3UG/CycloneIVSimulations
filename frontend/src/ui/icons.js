// icons.js — inline SVG icon set (feather-style, stroke = currentColor).

const I = (paths, viewBox = "0 0 24 24", fill = "none") =>
    `<svg class="icon" viewBox="${viewBox}" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
    power: I('<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v8"/>'),
    play: I('<polygon points="6 3 21 12 6 21 6 3" fill="currentColor" stroke="none"/>'),
    pause: I('<rect x="5" y="4" width="5" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="5" height="16" fill="currentColor" stroke="none"/>'),
    stop: I('<rect x="5" y="5" width="14" height="14" fill="currentColor" stroke="none"/>'),
    reset: I('<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2-9.4L1 10"/>'),
    update: I('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10"/><path d="M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>'),
    step: I('<polygon points="4 3 15 12 4 21 4 3" fill="currentColor" stroke="none"/><line x1="19" y1="4" x2="19" y2="20"/>'),
    zoomIn: I('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'),
    zoomOut: I('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/><line x1="8" y1="11" x2="14" y2="11"/>'),
    fit: I('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    top: I('<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="10" y1="10" x2="10" y2="20"/>'),
    front: I('<rect x="3" y="6" width="18" height="12" rx="1.5"/><line x1="3" y1="12" x2="21" y2="12"/>'),
    iso: I('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>'),
    ports: I('<rect x="2" y="7" width="20" height="10" rx="2"/><line x1="6" y1="7" x2="6" y2="4"/><line x1="10" y1="7" x2="10" y2="4"/><line x1="14" y1="7" x2="14" y2="4"/><line x1="18" y1="7" x2="18" y2="4"/>'),
    sun: I('<circle cx="12" cy="12" r="4.4"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>'),
    moon: I('<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8z"/>'),
    help: I('<circle cx="12" cy="12" r="9.2"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.3-2.8 3.9"/><line x1="12" y1="17.4" x2="12" y2="17.5"/>'),
    menu: I('<line x1="3.5" y1="6.5" x2="20.5" y2="6.5"/><line x1="3.5" y1="12" x2="20.5" y2="12"/><line x1="3.5" y1="17.5" x2="20.5" y2="17.5"/>'),
    upload: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 9 12 4 17 9"/><line x1="12" y1="4" x2="12" y2="16"/>'),
    download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    file: I('<path d="M13.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.5L13.5 2z"/><polyline points="13.5 2 13.5 8.5 20 8.5"/>'),
    folder: I('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    trash: I('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
    pencil: I('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
    plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    zip: I('<path d="M6 2h12v20H6z"/><path d="M6 2v5h12V2"/><rect x="9" y="10" width="6" height="6" rx="0.5"/><line x1="12" y1="16" x2="12" y2="21"/>'),
    chip: I('<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="0.5"/><line x1="9" y1="2.5" x2="9" y2="6"/><line x1="15" y1="2.5" x2="15" y2="6"/><line x1="9" y1="18" x2="9" y2="21.5"/><line x1="15" y1="18" x2="15" y2="21.5"/><line x1="2.5" y1="9" x2="6" y2="9"/><line x1="2.5" y1="15" x2="6" y2="15"/><line x1="18" y1="9" x2="21.5" y2="9"/><line x1="18" y1="15" x2="21.5" y2="15"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>'),
    chevron: I('<polyline points="9 5 16 12 9 19"/>'),
    x: I('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
    check: I('<polyline points="20 6 9 17 4 12"/>'),
    alert: I('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12" y2="17.1"/>'),
    info: I('<circle cx="12" cy="12" r="9.2"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12" y2="7.6"/>'),
    terminal: I('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    activity: I('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
    volume: I('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
    mute: I('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
    monitor: I('<rect x="2.5" y="4" width="19" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
    lcd: I('<rect x="3" y="5" width="18" height="14" rx="1.5"/><rect x="6" y="8" width="12" height="8" rx="0.5"/><line x1="9" y1="11" x2="9" y2="11.1"/><line x1="12" y1="11" x2="12" y2="11.1"/><line x1="15" y1="11" x2="15" y2="11.1"/>'),
    plug: I('<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8z"/><line x1="12" y1="17" x2="12" y2="22"/>'),
    ram: I('<rect x="4" y="7" width="16" height="10" rx="1.5"/><line x1="8" y1="7" x2="8" y2="17"/><line x1="12" y1="7" x2="12" y2="17"/><line x1="16" y1="7" x2="16" y2="17"/>'),
    cable: I('<path d="M4 20c4 0 4-4 8-4s4 4 8 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="20" r="1.6"/>'),
    toggle: I('<rect x="2.5" y="7" width="19" height="10" rx="5"/><circle cx="16.5" cy="12" r="2.6"/>'),
    slider: I('<line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="9" cy="8" r="2.2"/><circle cx="15" cy="16" r="2.2"/>'),
    globe: I('<circle cx="12" cy="12" r="9.2"/><line x1="2.8" y1="12" x2="21.2" y2="12"/><path d="M12 2.8a14.5 14.5 0 0 1 0 18.4 14.5 14.5 0 0 1 0-18.4z"/>'),
};

export function icon(name) {
    return icons[name] || icons.info;
}
