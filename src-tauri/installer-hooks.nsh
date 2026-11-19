; Tauri includes this file after its stock running-app macro. Check the exact
; installed image and let Viewsical finish saving state and closing its helpers.
!macroundef CheckIfAppIsRunning
!include WinMessages.nsh

; Probe with write access and OPEN_EXISTING. This checks the current Windows
; image lock without writing bytes or relying on a previous process snapshot.
!macro ViewsicalWaitForClose executablePath intervalCount
  StrCpy $4 ${intervalCount}
  ${Do}
    System::Call 'kernel32::CreateFileW(w "${executablePath}", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .r0 ?e'
    Pop $1
    ${If} $0 P<> -1
      System::Call 'kernel32::CloseHandle(p r0)'
      StrCpy $1 0
      ${ExitDo}
    ${EndIf}
    ${If} $1 = 2
    ${OrIf} $1 = 3
      StrCpy $1 0
      ${ExitDo}
    ${EndIf}
    ; Sharing violation, lock violation, or user-mapped file.
    ${If} $1 != 32
    ${AndIf} $1 != 33
    ${AndIf} $1 != 1224
      ${ExitDo}
    ${EndIf}
    StrCpy $1 32
    ${If} $4 = 0
      ${ExitDo}
    ${EndIf}
    Sleep 250
    IntOp $4 $4 - 1
  ${Loop}
!macroend

; Use the normal window-close path so the app can drain its work. A portable
; copy or another program with the same file name must stay running.
!macro ViewsicalRequestClose executablePath productName
  GetFullPathName $R1 "${executablePath}"
  StrCpy $5 0
  ${Do}
    ; Leave the tray, renderer, and Windows message windows for the app to close.
    System::Call 'user32::FindWindowExW(p 0, p r5, p 0, w "${productName}") p .r5'
    ${If} $5 = 0
      ${ExitDo}
    ${EndIf}
    System::Call 'user32::GetWindowThreadProcessId(p r5, *i .r6) i .r9'
    ${If} $9 != 0
      System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r6) p .r7'
      ${If} $7 != 0
        System::Call 'kernel32::QueryFullProcessImageNameW(p r7, i 0, w .r8, *i ${NSIS_MAX_STRLEN}) i .r9'
        ${If} $9 != 0
        ${AndIf} "$8" == "$R1"
          ; The tray-enabled app consumes this marker when handling WM_CLOSE.
          System::Call 'user32::SetPropW(p r5, w "Viewsical.QuitForMaintenance", p 1)'
          System::Call 'user32::PostMessageW(p r5, i ${WM_CLOSE}, p 0, p 0) i .r0'
          ${If} $0 = 0
            System::Call 'user32::RemovePropW(p r5, w "Viewsical.QuitForMaintenance")'
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::CloseHandle(p r7)'
      ${EndIf}
    ${EndIf}
  ${Loop}
!macroend

!macro CheckIfAppIsRunning executablePath productName
  !define checkId ${__LINE__}
  IfFileExists "${executablePath}" 0 viewsical_ready_${checkId}

  ; A user may have just clicked the app's Close button.
  !insertmacro ViewsicalWaitForClose "${executablePath}" 4
  StrCmp $1 0 viewsical_ready_${checkId}
  StrCmp $1 32 0 viewsical_check_failed_${checkId}

  IfSilent viewsical_request_close_${checkId}
  StrCmp $PassiveMode 1 viewsical_request_close_${checkId}
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "Close ${productName} to continue?" IDOK viewsical_request_close_${checkId}
  SetErrorLevel 1
  Abort

  viewsical_request_close_${checkId}:
    DetailPrint "Waiting for ${productName} to finish closing..."
    !insertmacro ViewsicalRequestClose "${executablePath}" "${productName}"

  viewsical_wait_${checkId}:
    ; Hiding the window does not release the executable. Wait for the main
    ; process and any playback process using this installed image to exit.
    !insertmacro ViewsicalWaitForClose "${executablePath}" 48
    StrCmp $1 0 viewsical_ready_${checkId}
    StrCmp $1 32 0 viewsical_check_failed_${checkId}
    IfSilent viewsical_end_locked_${checkId}
    StrCmp $PassiveMode 1 viewsical_end_locked_${checkId}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${productName} is still closing. Quit from its tray icon or end the ${productName} task in Task Manager, then select Retry." IDRETRY viewsical_wait_${checkId}

  viewsical_end_locked_${checkId}:
    SetErrorLevel 1
    Abort "${productName} is still running. Close it and try again."

  viewsical_check_failed_${checkId}:
    SetErrorLevel 1
    Abort "Windows could not open the installed ${productName} executable for maintenance (error $1)."

  viewsical_ready_${checkId}:
  !undef checkId
!macroend

; Clear the retired 0.1.5 Lua renderer from the install directory.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\tools\yt-dlp.exe"
  Delete "$INSTDIR\player\tubedesk_osc.lua"
  RMDir "$INSTDIR\player"
!macroend
