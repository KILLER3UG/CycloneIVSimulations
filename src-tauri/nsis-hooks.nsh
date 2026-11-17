; NSIS installer/uninstaller hooks for Cyclone IV Studio.
;
; Ensures no orphaned cyclone-backend.exe (or its ghdl.exe children) survives
; an upgrade or uninstall, which would lock files and break removal.
; The Tauri shell already kills the sidecar via a Windows Job Object on
; normal exit and crash; these hooks cover the installer running while a
; previous instance is still up.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping any running Cyclone IV Studio backend..."
  nsExec::Exec 'taskkill /F /IM cyclone-backend.exe /T'
  nsExec::Exec 'taskkill /F /IM ghdl.exe /T'
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping any running Cyclone IV Studio backend..."
  nsExec::Exec 'taskkill /F /IM cyclone-backend.exe /T'
  nsExec::Exec 'taskkill /F /IM ghdl.exe /T'
  Sleep 800
!macroend
