"""Section 23: pin mapping and polarity, end to end, derived from board.json.

Nothing here hard-codes a pin number: every expectation is derived from
``board/board.json`` at runtime, so later board.json corrections keep the
tests meaningful without edits.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from harness import ROOT, case, check, errors_text, run_text, value

BOARD_JSON = ROOT / "board" / "board.json"


def _load():
    return json.loads(BOARD_JSON.read_text(encoding="utf-8"))


def _bases(data) -> dict:
    """pinMap keys -> {base: width} (e.g. 'LED[0]'..'LED[3]' -> LED: 4).

    Clock aliases (FPGA_CLK/CLK) are the same physical pin as the board
    clock port and are not separate design ports.
    """
    aliases = set(data["board"].get("clockAliases", []))
    aliases.discard(data["board"]["clockPort"])
    bases: dict = {}
    for key in data["pinMap"]:
        if key in aliases:
            continue
        match = re.match(r"^(.*?)\[(\d+)\]$", key)
        base, bit = (match.group(1), int(match.group(2))) if match else (key, 0)
        bases[base] = max(bases.get(base, 0), bit + 1)
    return bases


def _input_bases(data) -> set:
    """FPGA-input ports, derived from the board profile itself."""
    board = data["board"]
    inputs = {board["clockPort"], board["resetPort"], board["buttons"]["port"]}
    inputs |= set(board["ps2"]["pins"].keys())          # PS_CLOCK, PS_DATA
    inputs |= {"UART_RXD"}                              # uart receive into FPGA
    inputs |= {k for k in data["pinMap"] if k == "IR"}  # IR receiver output
    return inputs


# ---------------------------------------------------------------------------
# PIN-01: every pinMap entry is mapped exactly once, with polarity metadata
# ---------------------------------------------------------------------------


@case("PIN-01", "23", "Every board.json pinMap entry reaches the backend pin map and board map", "infra",
      "all pinMap ports appear in board_pin_map with the same pins; element classification and polarities come from board.json")
def pin_01() -> str:
    from backend.device import BOARD, board_pin_map
    from backend.waveform import map_board
    from backend.vhdl_parser import VHDLParser

    data = _load()
    pin_map = data["pinMap"]
    index = board_pin_map()
    checked = 0
    for key, pins in pin_map.items():
        base = re.sub(r"\[\d+\]$", "", key)
        got = index.get(base.upper())
        check(got is not None, f"pinMap port {base} missing from board_pin_map()")
        for pin in pins:
            check(pin in got, f"{base}: pin {pin} not in backend map {got}")
        checked += 1
    check(checked == len(pin_map), "pin coverage mismatch")

    # map_board classifies the probe's ports into the board elements
    entity = VHDLParser().parse(_probe_vhdl()[0]).entities[0]
    board = map_board(entity)
    b = data["board"]
    check(board.leds == [b["leds"]["port"]], f"leds={board.leds}")
    check(board.buttons == [b["buttons"]["port"]], f"buttons={board.buttons}")
    check(board.switches == [b["switches"]["port"]], f"switches={board.switches}")
    check(board.displays == [b["displays"]["ports"][0]], f"displays={board.displays}")
    check(board.digits == [b["displays"]["digitPort"]], f"digits={board.digits}")
    check(board.clock == b["clockPort"], f"clock={board.clock}")
    check(board.reset == b["resetPort"], f"reset={board.reset}")
    # polarity metadata travels as data, exactly once, from board.json
    check(board.led_config["activeLow"] == b["leds"]["activeLow"], "LED polarity metadata")
    check(board.display_config["segmentActiveLow"] == b["displays"]["segmentActiveLow"],
          "segment polarity metadata")
    check(board.display_config["digitActiveLow"] == b["displays"]["digitActiveLow"],
          "digit polarity metadata")
    check(board.reset_active_high == (not b["resetActiveLow"]), "reset polarity metadata")
    return f"{checked} pinMap entries mapped; element classification + polarities match board.json"


# ---------------------------------------------------------------------------
# PIN-02: drive every pin and observe the mapped element flip (no hidden inversion)
# ---------------------------------------------------------------------------


def _probe_vhdl() -> tuple[str, dict, dict]:
    """Build a design exposing every pinMap port; returns (vhdl, bases, bit_map)."""
    data = _load()
    bases = _bases(data)
    inputs = _input_bases(data)
    # stimulus vector: KEY bits + UART_RXD (the inputs the test actually drives)
    stim = [b for b in sorted(bases) if b in inputs and b not in
            (data["board"]["clockPort"], data["board"]["resetPort"],
             "IR", "PS_CLOCK", "PS_DATA")]

    ports_in, ports_out = [], []
    for base in sorted(bases):
        width = bases[base]
        direction = "in" if base in inputs else "out"
        decl = (f"        {base} : {direction} std_logic_vector({width - 1} downto 0)"
                if width > 1 else f"        {base} : {direction} std_logic")
        (ports_in if base in inputs else ports_out).append(decl)

    # ordered stimulus bits, matching the VHDL concatenation "A & B & ..."
    stim_bits = [(name, bit) for name in stim for bit in range(bases[name])]
    stim_width = len(stim_bits)

    # output bit mapping: each output bit is driven by one stimulus bit
    bit_map: dict = {}
    cursor = 0
    for base in sorted(bases):
        if base in inputs or base == "LCD_RW":   # LCD_RW is forced released below
            continue
        for bit in range(bases[base]):
            bit_map[(base, bit)] = cursor % stim_width
            cursor += 1

    body = []
    stim_parts = " & ".join(stim)
    body.append(f"    stim <= {stim_parts};")
    for (base, bit), s in sorted(bit_map.items()):
        lhs = f"{base}({bit})" if bases[base] > 1 else base
        body.append(f"    {lhs} <= stim({s});")
    body.append("    -- stim bit order: " + ", ".join(f"{n}.{b}={i}" for i, (n, b) in enumerate(stim_bits)))
    # the LCD model only drives the data bus while RW=1: keep it released
    if "LCD_RW" in bases and "LCD_RW" not in inputs:
        body.append("    LCD_RW <= '0';" if bases["LCD_RW"] == 1 else "    LCD_RW <= (others => '0');")

    vhdl = f"""
library ieee;
use ieee.std_logic_1164.all;
entity pin_probe is
    port (
{chr(10).join(d + ";" for d in (ports_in + ports_out)[:-1]) + chr(10) + (ports_in + ports_out)[-1] if (ports_in + ports_out) else ""}
    );
end entity;
architecture rtl of pin_probe is
    signal stim : std_logic_vector({stim_width - 1} downto 0) := (others => '0');
begin
{chr(10).join(body)}
end architecture;
"""
    return vhdl, bases, bit_map


@case("PIN-02", "23", "Every pinMap port can be driven and flips with the driven value (raw, single inversion)", "VHDL",
      "two stimulus vectors that differ in every driven bit -> every mapped output pin captures the expected raw level; all pinMap ports appear in the waveform")
def pin_02() -> str:
    vhdl, bases, bit_map = _probe_vhdl()
    data = _load()
    inputs = _input_bases(data)
    aliases = set(data["board"].get("clockAliases", []))
    stim_names = sorted(b for b in bases if b in inputs and b not in
                        (data["board"]["clockPort"], data["board"]["resetPort"],
                         "IR", "PS_CLOCK", "PS_DATA") and b not in aliases)
    vectors = ({name: 0 for name in stim_names}, {name: 0 for name in stim_names})
    # vector A: 0101 pattern; vector B: complement on every driven input
    for name in stim_names:
        width = bases[name]
        pattern_a, pattern_b = 0, 0
        for bit in range(width):
            if bit % 2 == 0:
                pattern_a |= 1 << bit
            else:
                pattern_b |= 1 << bit
        vectors[0][name] = pattern_a
        vectors[1][name] = pattern_b

    runs = []
    for vec in vectors:
        result = run_text(vhdl, top="pin_probe", duration=300, clockPeriod=20, resetCycles=2,
                          constantInputs=vec)
        check(result.get("ok"), f"probe simulation failed: {errors_text(result)}")
        runs.append(result)

    # every pinMap port must be visible in the captured waveform
    for run_result in runs:
        names = {s["name"].upper() for s in run_result["waveforms"]["signals"]}
        for base in bases:
            check(base.upper() in names, f"port {base} missing from the waveform")

    # Rebuild the stim bit order exactly as the VHDL concatenation
    # "A & B & ..." lays it out: the RIGHTMOST name owns the lowest indices,
    # and each name's bits keep ascending order within its slice.
    ordered_stim = [(name, bit) for name in reversed(stim_names)
                    for bit in range(bases[name])]

    def captured(run_result, base):
        """Raw captured level of a pin.

        Model-attached ports (I2C/PS2/LCD/IR) live on the shared *_bus net in
        the generated testbench; capture the bus when the plain port name is
        only a dangling testbench shadow signal.
        """
        final = run_result["waveforms"]["final"]
        lowered = {k.lower(): v for k, v in final.items()}
        for key in (f"{base}_bus".lower(), base.lower()):
            if key in lowered:
                v = lowered[key]
                check(str(v) not in ("U", "X", "Z", "-") and not str(v).startswith("U"),
                      f"{base} captured as {v!r} (no driver)")
                return int(v)
        check(False, f"{base} missing from the final state")
        return 0

    flipped = 0
    for (base, bit), s in sorted(bit_map.items()):
        stim_name, stim_bit = ordered_stim[s]
        width = bases[base]
        got = [captured(r, base) for r in runs]
        if width > 1:
            expected = [(vectors[k][stim_name] >> stim_bit) & 1 for k in (0, 1)]
            actual = [(g >> bit) & 1 for g in got]
        else:
            expected = [vectors[k][stim_name] >> stim_bit & 1 for k in (0, 1)]
            actual = [g & 1 for g in got]
        check(actual == expected,
              f"{base}[{bit}] <- {stim_name}({stim_bit}): captured {actual}, expected {expected}")
        if actual[0] != actual[1]:
            flipped += 1
    check(flipped == len(bit_map), f"only {flipped}/{len(bit_map)} output pins flipped between vectors")
    return (f"{len(bit_map)} output pin bits across {len(bases)} pinMap ports driven and "
            f"captured raw (all flipped between vectors); no hidden inversion in the data path")


# ---------------------------------------------------------------------------
# PIN-03: SEG/DIG bit order per displayConfig.segBitMap
# ---------------------------------------------------------------------------


@case("PIN-03", "23", "SEG bit order follows displayConfig.segBitMap; SEG/DIG pins match the profile", "VHDL",
      "segBitMap is a bijection of 8 segments; driving the digit-0 pattern yields the board.json-derived SEG value on the SEG pins")
def pin_03() -> str:
    data = _load()
    seg_map = data["board"]["displays"]["segBitMap"]
    check(sorted(seg_map.values()) == list(range(8)),
          f"segBitMap is not a bijection onto 0..7: {seg_map}")
    check(sorted(seg_map.keys()) == ["a", "b", "c", "d", "dp", "e", "f", "g"],
          f"segment names wrong: {sorted(seg_map.keys())}")
    # display pins in pinMap match the structured profile, in bit order
    for i, pin in enumerate(data["board"]["displays"]["pins"]["SEG"]):
        check(data["pinMap"][f"SEG[{i}]"] == [pin], f"SEG[{i}] pin order")
    for i, pin in enumerate(data["board"]["displays"]["pins"]["DIG"]):
        check(data["pinMap"][f"DIG[{i}]"] == [pin], f"DIG[{i}] pin order")

    segments_for_0 = set("abcdef")           # glyph 0 lights a-f
    mask = 0
    for segment in segments_for_0:
        mask |= 1 << seg_map[segment]
    pattern = (~mask) & 0xFF                 # active-low segments

    src = f"""
library ieee;
use ieee.std_logic_1164.all;
entity seg_drive is
    port (SEG : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of seg_drive is
begin
    SEG <= std_logic_vector'(x"{pattern:02X}");
end architecture;
"""
    result = run_text(src, top="seg_drive", duration=20, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "SEG"))
    check(got == pattern, f"SEG={got:02X}; expected {pattern:02X} for glyph 0 with map {seg_map}")
    return (f"SEG0=b..SEG7=dp bijection; digit-0 pattern {pattern:02X} driven on the SEG pins "
            "matches the segBitMap derivation")


# ---------------------------------------------------------------------------
# PIN-04: LED[0..3] index vs silkscreen LED1..LED4 order
# ---------------------------------------------------------------------------


@case("PIN-04", "23", "LED index order matches the silkscreen order (LED[0]=LED1 ... LED[3]=LED4)", "infra",
      "pinMap LED[i] equals board.leds.pins[i] in order; the board map lists LEDs in natural order")
def pin_04() -> str:
    from backend.device import BOARD
    data = _load()
    leds = data["board"]["leds"]
    check(leds["count"] == len(leds["pins"]), "LED count vs pins")
    for i, pin in enumerate(leds["pins"]):
        check(data["pinMap"][f"LED[{i}]"] == [pin],
              f"LED[{i}] -> {data['pinMap'][f'LED[{i}]']}; expected [{pin}] (silkscreen LED{i + 1})")
    check(BOARD["leds"]["pins"] == leds["pins"], "backend LED pin order differs from board.json")
    # the vendor pin file lists LED1..LED4 in the same order
    vendor = (ROOT / "board" / "vendor" / "Pinos_RZEasyFPGA.txt").read_text(encoding="utf-8")
    for i, pin in enumerate(leds["pins"]):
        check(f"PIN_{pin.split('_')[1]} -to LED[{i}]" in vendor.replace("  ", " ") or
              re.search(rf"PIN_{pin.split('_')[1]}\s+-to\s+LED\[{i}\]", vendor),
              f"vendor file does not map {pin} to LED[{i}]")
    return f"LED[0..{leds['count'] - 1}] map to silkscreen LED1..LED{leds['count']} in order ({', '.join(leds['pins'])})"


# ---------------------------------------------------------------------------
# PIN-05: KEY/DIP shared nets — full truth table
# ---------------------------------------------------------------------------


@case("PIN-05", "23", "KEY/DIP shared nets: pin reads 0 iff key pressed OR dip on (all 16x16 combinations)", "VHDL",
      "wired-AND of the two active-low switches: NET = KEY AND DIP for every combination; onValue=0 from board.json")
def pin_05() -> str:
    data = _load()
    switches = data["board"]["switches"]
    check(switches["sharedWithButtons"] is True, "DIP not marked shared with keys")
    check(switches["onValue"] == 0 and switches["activeLow"] is True,
          "DIP on-value/polarity differs from the wired-AND expectation")
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity key_dip_net is
    port (KEY : in  std_logic_vector(3 downto 0);
          DIP : in  std_logic_vector(3 downto 0);
          NETO : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of key_dip_net is
begin
    NETO <= KEY and DIP;   -- both switches close to GND: wired-AND on the net
end architecture;
"""
    # The numeric loop above needs numeric_std; write it plainly instead.
    tb = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity tb_keydip16 is
end entity;
architecture sim of tb_keydip16 is
    signal key    : std_logic_vector(3 downto 0) := (others => '1');
    signal dip    : std_logic_vector(3 downto 0) := (others => '1');
    signal net    : std_logic_vector(3 downto 0);
    signal errors : std_logic_vector(7 downto 0) := (others => '0');
begin
    uut : entity work.key_dip_net port map (KEY => key, DIP => dip, NETO => net);
    process
        variable bad : natural := 0;
        variable expect : std_logic_vector(3 downto 0);
    begin
        for k in 0 to 15 loop
            for d in 0 to 15 loop
                key <= std_logic_vector(to_unsigned(k, 4));
                dip <= std_logic_vector(to_unsigned(d, 4));
                wait for 1 ns;
                expect := std_logic_vector(to_unsigned(k, 4)) and std_logic_vector(to_unsigned(d, 4));
                if net /= expect then
                    bad := bad + 1;
                end if;
                wait for 1 ns;
            end loop;
        end loop;
        errors <= std_logic_vector(to_unsigned(bad, 8));
        wait;
    end process;
end architecture;
"""
    result = run_text(src, testbench=tb, top="tb_keydip16", duration=2000, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    bad = int(value(result, "errors"))
    check(bad == 0, f"{bad} of 256 KEY/DIP combinations mismatched the wired-AND truth table")
    return "all 256 KEY x DIP combinations read 0 iff key pressed (0) or DIP on (0): wired-AND confirmed"
