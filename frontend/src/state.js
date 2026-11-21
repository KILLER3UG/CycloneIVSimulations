// state.js — central application state + a minimal event bus.
//
// One plain observable store; UI components read `state` and re-render from
// bus events emitted by main.js. Kept dependency-free on purpose.

export const DEFAULT_SOURCE = `-- Cyclone IV Studio — type VHDL here or load an example.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        led   : out std_logic_vector(3 downto 0)
    );
end entity;

architecture rtl of counter is
    signal count : unsigned(3 downto 0) := (others => '0');
begin
    process (clk, reset)
    begin
        if reset = '0' then
            count <= (others => '0');
        elsif rising_edge(clk) then
            count <= count + 1;
        end if;
    end process;

    led <= std_logic_vector(count);
end architecture rtl;
`;

// The most recently created store. Lets resizeBoardInputs(profile) update the
// live application state without every caller having to pass it explicitly.
let activeState = null;

export function createStore() {
    const state = {
        // ui
        theme: "dark",
        power: true,
        status: "idle", // idle | compiling | programming | running | paused | error
        statusDetail: "",
        leftOpen: true,
        rightOpen: true,
        bottomOpen: true,

        // backend data
        appVersion: "0.1.6",
        backendOk: null, // null = unknown, true/false
        ghdlVersion: "",
        profile: null, // GET /api/board → { board, device }
        deviceKey: "ep4ce6",
        device: null,
        examples: [],

        // multi-board SDK / zero-delay stimulus play
        stimulusMap: null, // verbatim sim_ready.stimulusMap (never stripped)
        activeBoardId: "rz-easyfpga-a2.2",
        boardsList: [],
        keyState: [false, false, false, false],
        dipState: [false, false, false, false],
        releaseTimer: null,
        releaseDeadlineMs: 0,
        clockPeriodNs: 20,

        // project files
        files: [{ name: "counter.vhd", content: DEFAULT_SOURCE }],
        activeFile: 0,

        // compile / run
        entity: null, // { name, ports: [{name, direction, type, width}] }
        compileResult: null,
        problems: [], // [{severity, message, file, line, column}]
        pinCheck: { unknown: [], blocked: false, override: true },
        topEntity: "",

        // live session
        session: null, // SimSession
        running: false,
        paused: false,
        refreshing: false, // live input-change refresh (no recompile)
        programmed: false, // first successful run happened
        signals: [], // [{name, width, direction}]
        cycles: [], // [{cycle, time, values}]
        totalCycles: 0,
        cursorCycle: 0,
        simTimeNs: 0,
        liveValues: {},
        simStats: { cyclesPerSecond: 0, targetSpeed: 50000000, realSpeed: 0, engineLoad: null },
        updateLoad: 0,
        fps: 0,
        drawCalls: 0,

        // peripherals
        uart: { bytes: [], baud: null, frames: 0 },
        vga: null,
        lcd: null,
        buzzer: null,

        // probe chips (waveform tab)
        probes: [], // [{pinId, label}]
    };

    activeState = state;
    const listeners = new Map();
    return {
        state,
        on(event, cb) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(cb);
            return () => listeners.get(event).delete(cb);
        },
        emit(event, payload) {
            const set = listeners.get(event);
            if (set) for (const cb of Array.from(set)) cb(payload, state);
        },
        set(patch) { Object.assign(state, patch); },
    };
}

/** The store created most recently (the application store in normal use). */
export function getActiveState() { return activeState; }

/**
 * Resize the live input mirrors for a newly selected board. Counts come from
 * the profile (never hard-coded pins); every slot is reset to a clean boolean
 * false so switching boards cannot leak a previously held key.
 */
export function resizeBoardInputs(profile, targetState = activeState) {
    const board = (profile && (profile.board || profile)) || {};
    const keyCount = Math.max(0, Number(board.buttons?.count || board.buttons?.pins?.length || 4) || 4);
    const dipCount = Math.max(0, Number(board.switches?.count || board.switches?.pins?.length || 4) || 4);
    const keyState = Array.from({ length: keyCount }, () => false);
    const dipState = Array.from({ length: dipCount }, () => false);
    if (targetState && typeof targetState === "object") {
        targetState.keyState = keyState;
        targetState.dipState = dipState;
    }
    return { keyState, dipState };
}
