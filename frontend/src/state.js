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

export function createStore() {
    const state = {
        // ui
        theme: "light",
        power: true,
        status: "idle", // idle | compiling | programming | running | paused | error
        statusDetail: "",
        leftOpen: true,
        rightOpen: true,
        bottomOpen: true,

        // backend data
        backendOk: null, // null = unknown, true/false
        ghdlVersion: "",
        profile: null, // GET /api/board → { board, device }
        deviceKey: "ep4ce6",
        device: null,
        examples: [],

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
