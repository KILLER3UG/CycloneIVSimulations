# STOP 2 — clean-machine verification checklist

Run this in a **clean Windows 10/11 VM or Windows Sandbox** with the network
adapter disabled (or at least without Python/Rust/Node/GHDL installed) and the
built installer from
`src-tauri/target/release/bundle/nsis/Cyclone IV Studio_0.1.0_x64-setup.exe`
(SHA-256 in `docs/evidence/SHA256SUMS.txt`).

The interactive run below was executed on the development machine (silent
install → launch → compile/run → close → upgrade → uninstall) because Windows
Sandbox requires an elevated shell that this session does not have. Every step
is scripted so the same sequence runs unmodified inside a VM.

## Steps

1. **Install offline**
   ```powershell
   & "C:\path\to\Cyclone IV Studio_0.1.0_x64-setup.exe" /S
   ```
   - Expect exit code 0 and `%LOCALAPPDATA%\Cyclone IV Studio\` containing
     `cyclone-iv-studio.exe`, `sidecar\cyclone-backend\` (board, examples,
     ghdl, frontend, licenses) and `uninstall.exe`.
2. **Launch and confirm the 3D board + backend**
   ```powershell
   Start-Process "$env:LOCALAPPDATA\Cyclone IV Studio\cyclone-iv-studio.exe"
   ```
   - `cyclone-backend.exe` must appear in the process list and the backend log
     (`%APPDATA%\CycloneIVStudio\logs\backend.log`) must contain
     `Sidecar listening on 127.0.0.1:<port>`.
   - The window shows the 3D board (QFP, 7-seg, keys, LEDs, buzzer, DIP).
3. **Compile and run the classroom designs** (offline)
   ```powershell
   $sidecar = "$env:LOCALAPPDATA\Cyclone IV Studio\sidecar\cyclone-backend"
   & "$sidecar\cyclone-backend.exe" doctor
   & "$sidecar\cyclone-backend.exe" run "$sidecar\examples\buzz1.vhd" --top buzz1 `
       --duration 3900000 --clock 20 --reset-cycles 0 --cycles 4 --json
   & "$sidecar\cyclone-backend.exe" run "$sidecar\examples\buzz_4tone.vhd" --top buzz_4tone `
       --duration 3900000 --clock 20 --reset-cycles 0 --cycles 4 --json
   ```
   - buzz1 → 800 Hz / 62,500 cycles-per-period / 50 % duty.
   - buzz_4tone → 500 Hz on KEY1 (800/1000/1600 Hz on the other keys) and a
     0.5 s release note (`cnt_delay` = 25,000,000 cycles).
   - In the UI this is heard through the Web Audio buzzer and seen on the
     7-segment persistence display.
4. **Verilog without Icarus**
   ```powershell
   'module blink_v(input wire clk, output reg [3:0] led); reg [31:0] cnt;
    always @(posedge clk) begin cnt <= cnt + 1; led <= cnt[31:28]; end
   endmodule' | Set-Content "$env:TEMP\blink.v"
   & "$sidecar\cyclone-backend.exe" run "$env:TEMP\blink.v" --top blink_v `
       --duration 200 --clock 20 --cycles 6 --json
   ```
   - Must succeed: Verilog is translated in-process and simulated by the
     bundled GHDL (no Icarus installed).
5. **Close the app and check the process list**
   ```powershell
   taskkill /IM cyclone-iv-studio.exe
   Start-Sleep 6
   tasklist | findstr /i "cyclone ghdl"
   ```
   - Expect **no** `cyclone-iv-studio.exe`, `cyclone-backend.exe` or `ghdl.exe`
     left (Tauri kills the sidecar via a KILL_ON_JOB_CLOSE job object; the
     NSIS hooks also taskkill on upgrade/uninstall).
6. **Upgrade over the existing install**
   - Re-run the same installer `/S`. User data
     (`%APPDATA%\CycloneIVStudio\projects`, logs, pin assignments) must
     survive and the app must still launch.
7. **Uninstall**
   ```powershell
   & "$env:LOCALAPPDATA\Cyclone IV Studio\uninstall.exe" /S
   ```
   - Expect `%LOCALAPPDATA%\Cyclone IV Studio` to be removed completely
     (POSTUNINSTALL hook removes the bundled sidecar resources) and no
     processes left.

## Result on this machine (2026-11-17)

| Step | Result |
| --- | --- |
| 1 install (silent) | PASS — installed to `%LOCALAPPDATA%\Cyclone IV Studio` |
| 2 launch + backend | PASS — `Sidecar listening on 127.0.0.1:59688`, `/api/board` OK |
| 3 buzz1 / buzz_4tone | PASS — 800 Hz and 500 Hz decoded from the installed sidecar |
| 4 Verilog | PASS — `blink_v` compiled+simulated by the bundled GHDL |
| 5 close | PASS — no `cyclone`/`ghdl` processes remain |
| 6 upgrade | PASS — user project marker survived, app reinstalled |
| 7 uninstall | PASS after the POSTUNINSTALL hook fix — directory fully removed, no processes |

Screenshots: `stop2-app-running.png` (app running with the live backend).
