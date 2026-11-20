; NSIS installer/uninstaller hooks for Cyclone IV Studio.
;
; Ensures no orphaned cyclone-backend.exe (or its ghdl.exe children) survives
; an upgrade or uninstall, which would lock files and break removal.
; The Tauri shell already kills the sidecar via a Windows Job Object on
; normal exit and crash; these hooks cover the installer running while a
; previous instance is still up.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running Cyclone IV Studio instance..."
  nsExec::Exec 'taskkill /F /IM cyclone-iv-studio.exe /T'
  nsExec::Exec 'taskkill /F /IM cyclone-backend.exe /T'
  nsExec::Exec 'taskkill /F /IM ghdl.exe /T'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; After an updater-driven (silent) install the running app has been closed,
  ; so the JavaScript relaunch() call never fires — bring the new version
  ; back up here. A manual interactive install already auto-launches via the
  ; Tauri template, so only relaunch in silent mode.
  IfSilent 0 +4
    DetailPrint "Relaunching Cyclone IV Studio after update..."
    Sleep 800
    Exec '"$INSTDIR\cyclone-iv-studio.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any running Cyclone IV Studio backend..."
  nsExec::Exec 'taskkill /F /IM cyclone-backend.exe /T'
  nsExec::Exec 'taskkill /F /IM ghdl.exe /T'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The uninstaller manifest does not remove the bundled sidecar resources
  ; (board/models/examples/ghdl/frontend). Remove the whole app directory so
  ; no residual files block a later reinstall.
  RMDir /r "$INSTDIR"
!macroend
