; The worker lives in its own process. If it outlives VietNote (an update that quits the app
; abruptly, a crash), it keeps its DLLs open and the installer cannot overwrite them.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM vietnote-worker.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM vietnote-worker.exe'
  Pop $0
  Sleep 500
!macroend
