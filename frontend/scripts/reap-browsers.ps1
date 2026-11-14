# reap-browsers.ps1 — kill ONLY browser processes that did not exist before
# the harness script started. The harness captures the pre-existing
# chrome/msedge PID list and passes it via -BeforePids "id,id,..."; every
# browser process whose PID is NOT in that list was spawned by the harness
# (including relaunch roots whose command line lost the marker flags) and is
# killed. The user's own Chrome/Edge windows always pre-date the run and are
# never touched.
param(
    [string]$BeforePids = ""
)
$before = @{}
foreach ($id in ($BeforePids -split "," | Where-Object { $_ })) {
    $before[$id] = $true
}
Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
    Where-Object { -not $before.ContainsKey([string]$_.ProcessId) } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
