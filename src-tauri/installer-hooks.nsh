; The former renderer lived beside the executable in 0.1.5. Tauri upgrades
; retain files omitted from the new resource list, so retire this exact
; application-owned file. Never recurse or touch the separate app-data folder.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\player\tubedesk_osc.lua"
  RMDir "$INSTDIR\player"
!macroend
