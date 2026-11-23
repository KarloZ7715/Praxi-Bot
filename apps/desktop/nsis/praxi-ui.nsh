; Praxi-Bot branded one-window installer UI.
;
; Included by installer.nsi (a copy of Tauri's NSIS template, see docs/contributing/installer.md).
; Everything the user sees lives here: one dark window (Obsidian palette) with the ghost,
; the product name, a short line, one big button, a progress bar and plain status text.
;
; How it works, in short: the stock wizard window is kept (so /S, /P, /UPDATE, SmartScreen
; behaviour and the WebView2 bootstrapper keep working) but its header, line and buttons are hidden and the
; inner page area is stretched over the whole window. Our own controls are drawn on it with
; the colours from praxi-theme.nsh and the texts from praxi-strings.nsh (both generated).
; Buttons are flat rounded labels, because the stock Windows button cannot be coloured.
; No plug-in beyond what NSIS and Tauri already ship is used.

!include "WinMessages.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "${__FILEDIR__}\praxi-theme.nsh"

!define PX_W 560
!define PX_H 480

Var PxDpi
Var PxDlg
Var PxX
Var PxY
Var PxW
Var PxH
Var PxCW
Var PxCH
Var PxSized
Var PxNsd         ; 1 while an nsDialogs page is being built
Var PxFTitle
Var PxFBody
Var PxFSmall
Var PxFBrand
Var PxFLink
Var PxFBtn
Var PxImg
Var PxCtl
Var PxBtnText
Var PxMode        ; 0 = fresh install, 1 = update, 2 = same version, 3 = newer version already installed
Var PxOldVer
Var PxAllUsers    ; 1 = install for everyone on the PC
Var PxDesktop     ; 1 = add a desktop shortcut
Var PxGo          ; 1 = skip the first page (relaunched with administrator rights)
Var PxAdvOpen
Var PxAdvPanel
Var PxAdvLabel
Var PxPath        ; label showing the chosen folder
Var PxDir         ; the chosen install folder
Var PxBrowse
Var PxRadioMe
Var PxRadioAll
Var PxCheckDesktop
Var PxProg
Var PxStatus
Var PxCheckData
Var PxWarn
Var DeleteAppDataCheckboxState

; ---------------------------------------------------------------------------------------------
; Building blocks (defined twice: installer and, with the "un." prefix, uninstaller)
; ---------------------------------------------------------------------------------------------

; Create a control at design pixels (96 dpi) and leave its handle on the stack.
!macro PxMk un x y w h class style exstyle text font fg bg
  StrCpy $PxX "${x}"
  StrCpy $PxY "${y}"
  StrCpy $PxW "${w}"
  StrCpy $PxH "${h}"
  Push "${class}"
  Push "${text}"
  Push "${style}"
  Push "${exstyle}"
  Push "${font}"
  Push "${fg}"
  Push "${bg}"
  Call ${un}PxMk
!macroend

; Same, and store the handle in a variable.
!macro PxMkTo un var x y w h class style exstyle text font fg bg
  !insertmacro PxMk "${un}" "${x}" "${y}" "${w}" "${h}" "${class}" "${style}" "${exstyle}" "${text}" "${font}" "${fg}" "${bg}"
  Pop ${var}
  ; SetCtlColors only takes colours written out in the script, never variables, so it lives here
  !if "${fg}" != ""
    SetCtlColors ${var} ${fg} ${bg}
  !endif
!macroend

; Common window styles
!define PX_STYLE_LABEL  0x50000000  ; child + visible
!define PX_STYLE_BUTTON 0x50000301  ; child + visible + centred + vertically centred + clickable
!define PX_STYLE_LINK   0x50000100  ; child + visible + clickable
!define PX_STYLE_CHECK  0x50010003  ; child + visible + tabstop + auto checkbox
!define PX_STYLE_RADIO  0x50010009  ; child + visible + tabstop + auto radio button
!define PX_STYLE_PATH   0x50008200  ; child + visible + vertically centred + shortened in the middle when too long
!define PX_STYLE_IMAGE  0x5000000E  ; child + visible + bitmap

!macro PxDefine un

  Function ${un}PxMkFont
    ; stack: underline, weight, pixel size  ->  font handle
    Pop $R2
    Pop $R1
    Pop $R0
    IntOp $R0 $R0 * $PxDpi
    IntOp $R0 $R0 / 96
    System::Call 'gdi32::CreateFontW(i -$R0, i 0, i 0, i 0, i $R1, i 0, i $R2, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI") p .r0'
    Push $0
  FunctionEnd

  Function ${un}PxMk
    Pop $R1 ; background colour (set by the macro: SetCtlColors cannot take variables)
    Pop $R2 ; text colour (same)
    Pop $R3 ; font
    Pop $R4 ; extended style
    Pop $R5 ; style
    Pop $R6 ; text
    Pop $R7 ; window class
    IntOp $PxX $PxX * $PxDpi
    IntOp $PxX $PxX / 96
    IntOp $PxY $PxY * $PxDpi
    IntOp $PxY $PxY / 96
    IntOp $PxW $PxW * $PxDpi
    IntOp $PxW $PxW / 96
    IntOp $PxH $PxH * $PxDpi
    IntOp $PxH $PxH / 96
    ${If} $PxNsd = 1
      ; on an nsDialogs page: create through the plug-in so that clicks reach ${NSD_OnClick}
      nsDialogs::CreateControl /NOUNLOAD "$R7" $R5 $R4 $PxX $PxY $PxW $PxH "$R6"
      Pop $9
    ${Else}
      ; on the stock progress page: a plain child window
      System::Call 'user32::CreateWindowExW(i $R4, w "$R7", w "$R6", i $R5, i $PxX, i $PxY, i $PxW, i $PxH, p $PxDlg, p 0, p 0, p 0) p .r9'
    ${EndIf}
    ${If} $R3 != 0
      SendMessage $9 ${WM_SETFONT} $R3 1
    ${EndIf}
    ${If} $R7 == "BUTTON"
    ${OrIf} $R7 == "EDIT"
      ; the stock visual style would ignore our colours
      System::Call 'uxtheme::SetWindowTheme(p r9, w "", w "")'
    ${EndIf}
    Push $9
  FunctionEnd

  ; Hide the stock wizard chrome, size and colour the window, create the fonts. Call from every page.
  Function ${un}PxChrome
    ${If} $PxDpi == ""
    ${OrIf} $PxDpi == 0
      System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r0'
      ${If} $0 < 96
        StrCpy $0 96
      ${EndIf}
      StrCpy $PxDpi $0
    ${EndIf}

    ; hide everything except the inner page dialogs (header, line, branding, Back/Next/Cancel)
    StrCpy $1 0
    ${Do}
      FindWindow $2 "" "" $HWNDPARENT $1
      ${If} $2 == 0
        ${ExitDo}
      ${EndIf}
      System::Call 'user32::GetClassNameW(p r2, w .r3, i 64)'
      ${If} $3 != "#32770"
        ShowWindow $2 ${SW_HIDE}
      ${EndIf}
      StrCpy $1 $2
    ${Loop}

    ${If} $PxSized != 1
      StrCpy $PxSized 1
      ; fonts
      Push 26
      Push 600
      Push 0
      Call ${un}PxMkFont
      Pop $PxFTitle
      Push 22
      Push 700
      Push 0
      Call ${un}PxMkFont
      Pop $PxFBrand
      Push 14
      Push 400
      Push 0
      Call ${un}PxMkFont
      Pop $PxFBody
      Push 12
      Push 400
      Push 0
      Call ${un}PxMkFont
      Pop $PxFSmall
      Push 13
      Push 400
      Push 1
      Call ${un}PxMkFont
      Pop $PxFLink
      Push 14
      Push 600
      Push 0
      Call ${un}PxMkFont
      Pop $PxFBtn

      ; window: outer size = wanted client size + current frame, centred where it already is
      System::Alloc 16
      Pop $4
      System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r4)'
      System::Call '*$4(i .r5, i .r6, i .r7, i .r8)'
      System::Call 'user32::GetClientRect(p $HWNDPARENT, p r4)'
      System::Call '*$4(i, i, i .r9, i .r0)'
      System::Free $4
      IntOp $1 $7 - $5
      IntOp $1 $1 - $9
      IntOp $2 $8 - $6
      IntOp $2 $2 - $0
      IntOp $PxCW ${PX_W} * $PxDpi
      IntOp $PxCW $PxCW / 96
      IntOp $PxCH ${PX_H} * $PxDpi
      IntOp $PxCH $PxCH / 96
      IntOp $3 $PxCW + $1
      IntOp $4 $PxCH + $2
      IntOp $5 $5 + $7
      IntOp $5 $5 / 2
      IntOp $6 $6 + $8
      IntOp $6 $6 / 2
      IntOp $7 $3 / 2
      IntOp $5 $5 - $7
      IntOp $7 $4 / 2
      IntOp $6 $6 - $7
      ${If} $5 < 0
        StrCpy $5 0
      ${EndIf}
      ${If} $6 < 0
        StrCpy $6 0
      ${EndIf}
      System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r5, i r6, i r3, i r4, i 0x14)'

      ; dark title bar to match (Windows 11; ignored on older Windows)
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${PX_BG_BGR}, i 4)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${PX_BG_BGR}, i 4)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${PX_TEXT_BGR}, i 4)'
    ${EndIf}

    ; the page area covers the whole window
    GetDlgItem $0 $HWNDPARENT 1018
    System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i $PxCW, i $PxCH, i 0x14)'
  FunctionEnd

  ; Accent line, ghost tile, product name and version. Draws on $PxDlg.
  Function ${un}PxHeader
    !insertmacro PxMkTo "${un}" $R9 0 0 ${PX_W} 3 "STATIC" ${PX_STYLE_LABEL} 0 "" 0 ${PX_ACCENT} ${PX_ACCENT}
    !insertmacro PxMkTo "${un}" $R9 48 36 64 64 "STATIC" ${PX_STYLE_IMAGE} 0 "" 0 "" ""
    ${NSD_SetStretchedImage} $R9 "$PLUGINSDIR\ghost.bmp" $PxImg
    !insertmacro PxMkTo "${un}" $R9 128 40 380 32 "STATIC" ${PX_STYLE_LABEL} 0 "${PRODUCTNAME}" $PxFBrand ${PX_TEXT} ${PX_BG}
    !insertmacro PxMkTo "${un}" $R9 128 74 380 20 "STATIC" ${PX_STYLE_LABEL} 0 "$(px_version_line)" $PxFSmall ${PX_MUTED} ${PX_BG}
  FunctionEnd

  ; Page title and description. Text arrives on the stack: description, then title.
  Function ${un}PxTitleAndText
    Pop $R8
    Pop $R7
    !insertmacro PxMkTo "${un}" $R9 48 128 464 36 "STATIC" ${PX_STYLE_LABEL} 0 "$R7" $PxFTitle ${PX_TEXT} ${PX_BG}
    !insertmacro PxMkTo "${un}" $R9 48 172 464 60 "STATIC" ${PX_STYLE_LABEL} 0 "$R8" $PxFBody ${PX_TEXT2} ${PX_BG}
  FunctionEnd

  ; Click the (hidden) stock Next or Cancel button: id 1 = Next, 2 = Cancel.
  Function ${un}PxPress
    Pop $R0
    GetDlgItem $R1 $HWNDPARENT $R0
    EnableWindow $R1 1
    SendMessage $R1 ${BM_CLICK} 0 0
  FunctionEnd

!macroend

!insertmacro PxDefine ""
!insertmacro PxDefine "un."

; ---------------------------------------------------------------------------------------------
; Install: page 1 (Install / Update / Reinstall), with the Advanced options
; ---------------------------------------------------------------------------------------------

Function PxDefaultDir
  ; result in $R9: the default install folder for the current "who is it for" choice
  ${If} $PxAllUsers = 1
    !if "${ARCH}" == "x64"
      ${If} ${RunningX64}
        StrCpy $R9 "$PROGRAMFILES64\${PRODUCTNAME}"
      ${Else}
        StrCpy $R9 "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${ARCH}" == "arm64"
      StrCpy $R9 "$PROGRAMFILES64\${PRODUCTNAME}"
    !else
      StrCpy $R9 "$PROGRAMFILES\${PRODUCTNAME}"
    !endif
  ${Else}
    StrCpy $R9 "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}
FunctionEnd

Function PraxiStartPage
  ; The first page is skipped for silent, passive, update and relaunched-as-administrator runs.
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} $PxGo = 1
    Abort
  ${EndIf}

  ; an update or reinstall does not bring a desktop shortcut back that the user removed
  ${If} $PxMode = 1
  ${OrIf} $PxMode = 2
    StrCpy $PxDesktop 0
  ${EndIf}

  Call PxChrome
  nsDialogs::Create 1018
  Pop $PxDlg
  ${If} $PxDlg == error
    Abort
  ${EndIf}
  StrCpy $PxNsd 1
  SetCtlColors $PxDlg "" ${PX_BG}
  Call PxHeader

  ${If} $PxMode = 1
    StrCpy $PxBtnText "$(px_btn_update)"
    Push "$(px_start_update_title)"
    Push "$(px_start_update_text)"
  ${ElseIf} $PxMode = 2
    StrCpy $PxBtnText "$(px_btn_reinstall)"
    Push "$(px_start_same_title)"
    Push "$(px_start_same_text)"
  ${ElseIf} $PxMode = 3
    StrCpy $PxBtnText "$(px_btn_close)"
    Push "$(px_start_newer_title)"
    Push "$(px_start_newer_text)"
  ${Else}
    StrCpy $PxBtnText "$(px_btn_install)"
    Push "$(px_start_install_title)"
    Push "$(px_start_install_text)"
  ${EndIf}
  Call PxTitleAndText

  ${If} $PxMode = 0
    ; Advanced options: a link, and a panel that is hidden until the link is clicked
    !insertmacro PxMkTo "" $PxCtl 48 236 464 22 "STATIC" ${PX_STYLE_LINK} 0 "$(px_advanced_link)" $PxFLink ${PX_ACCENT} ${PX_BG}
    ${NSD_OnClick} $PxCtl PxToggleAdvanced
    !insertmacro PxMkTo "" $PxAdvPanel 48 262 464 104 "STATIC" ${PX_STYLE_LABEL} 0 "" 0 ${PX_TEXT} ${PX_SURFACE}
    !insertmacro PxMkTo "" $PxAdvLabel 60 270 120 18 "STATIC" ${PX_STYLE_LABEL} 0 "$(px_advanced_folder)" $PxFSmall ${PX_MUTED} ${PX_SURFACE}
    StrCpy $PxDir $INSTDIR
    !insertmacro PxMkTo "" $PxPath 60 290 340 24 "STATIC" ${PX_STYLE_PATH} 0 "  $PxDir" $PxFSmall ${PX_TEXT} ${PX_ELEVATED}
    !insertmacro PxMkTo "" $PxBrowse 408 290 92 24 "STATIC" ${PX_STYLE_BUTTON} 0 "$(px_btn_browse)" $PxFSmall ${PX_TEXT} ${PX_ELEVATED}
    ${NSD_OnClick} $PxBrowse PxBrowseFolder
    !insertmacro PxMkTo "" $PxRadioMe 60 318 440 20 "BUTTON" ${PX_STYLE_RADIO} 0 "$(px_advanced_just_me)" $PxFSmall ${PX_TEXT2} ${PX_SURFACE}
    ${NSD_OnClick} $PxRadioMe PxPickWho
    !insertmacro PxMkTo "" $PxRadioAll 60 340 440 20 "BUTTON" ${PX_STYLE_RADIO} 0 "$(px_advanced_all_users)" $PxFSmall ${PX_TEXT2} ${PX_SURFACE}
    ${NSD_OnClick} $PxRadioAll PxPickWho
    ; the desktop shortcut tick lives below the panel so the panel stays short
    !insertmacro PxMkTo "" $PxCheckDesktop 48 374 464 20 "BUTTON" ${PX_STYLE_CHECK} 0 "$(px_advanced_desktop)" $PxFSmall ${PX_TEXT2} ${PX_BG}
    ${If} $PxAllUsers = 1
      SendMessage $PxRadioAll ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $PxRadioMe ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}
    ${If} $PxDesktop = 1
      SendMessage $PxCheckDesktop ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}
    ${If} $PxAdvOpen != 1
      Call PxShowAdvanced
    ${EndIf}
  ${EndIf}


  ; the one big button
  ${If} $PxMode = 3
    !insertmacro PxMkTo "" $PxCtl 48 412 200 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$PxBtnText" $PxFBtn ${PX_TEXT} ${PX_ELEVATED}
  ${Else}
    !insertmacro PxMkTo "" $PxCtl 48 412 200 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$PxBtnText" $PxFBtn ${PX_ACCENT_TEXT} ${PX_ACCENT}
  ${EndIf}
  ${NSD_OnClick} $PxCtl PxStartInstall

  nsDialogs::Show
FunctionEnd

Function PraxiStartLeave
FunctionEnd

Function PxShowAdvanced
  ${If} $PxAdvOpen = 1
    StrCpy $R0 ${SW_SHOW}
  ${Else}
    StrCpy $R0 ${SW_HIDE}
  ${EndIf}
  ShowWindow $PxAdvPanel $R0
  ShowWindow $PxAdvLabel $R0
  ShowWindow $PxPath $R0
  ShowWindow $PxBrowse $R0
  ShowWindow $PxRadioMe $R0
  ShowWindow $PxRadioAll $R0
  ShowWindow $PxCheckDesktop $R0
FunctionEnd

Function PxToggleAdvanced
  ${If} $PxAdvOpen = 1
    StrCpy $PxAdvOpen 0
  ${Else}
    StrCpy $PxAdvOpen 1
  ${EndIf}
  Call PxShowAdvanced
FunctionEnd

Function PxBrowseFolder
  nsDialogs::SelectFolderDialog "$(px_advanced_browse_title)" "$PxDir"
  Pop $R0
  ${If} $R0 != error
    ; install into a folder named after the app inside the chosen one, like the stock wizard did
    StrLen $R1 "\${PRODUCTNAME}"
    StrCpy $R2 $R0 "" -$R1
    ${If} $R2 != "\${PRODUCTNAME}"
      StrCpy $R3 $R0 1 -1
      ${If} $R3 == "\"
        StrCpy $R0 "$R0${PRODUCTNAME}"
      ${Else}
        StrCpy $R0 "$R0\${PRODUCTNAME}"
      ${EndIf}
    ${EndIf}
    StrCpy $PxDir $R0
    SendMessage $PxPath ${WM_SETTEXT} 0 "STR:  $PxDir"
  ${EndIf}
FunctionEnd

Function PxPickWho
  ${NSD_GetState} $PxRadioAll $R0
  ${If} $R0 = 1
    StrCpy $R5 1
  ${Else}
    StrCpy $R5 0
  ${EndIf}
  ${If} $R5 <> $PxAllUsers
    Call PxDefaultDir
    StrCpy $R6 $R9
    StrCpy $PxAllUsers $R5
    ; a folder the user did not pick follows the choice; a picked one is left alone
    ${If} $PxDir == $R6
      Call PxDefaultDir
      StrCpy $PxDir $R9
      SendMessage $PxPath ${WM_SETTEXT} 0 "STR:  $PxDir"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function PxRelaunchElevated
  ; Start this installer again with administrator rights, straight into the install step.
  ${If} $PxDesktop = 1
    StrCpy $R2 1
  ${Else}
    StrCpy $R2 0
  ${EndIf}
  ; /D= has to come last; NSIS reads everything after it as the folder, spaces included
  StrCpy $R0 `/ALLUSERS /GO /XDESKTOP=$R2 /D=$INSTDIR`
  System::Call 'shell32::ShellExecuteW(p $HWNDPARENT, w "runas", w "$EXEPATH", w `$R0`, p 0, i 1) p .r1'
  ${If} $1 > 32
    Quit
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(px_elevate_failed)"
  ${EndIf}
FunctionEnd

Function PxStartInstall
  ${If} $PxMode = 3
    Push 2
    Call PxPress
    Return
  ${EndIf}
  ${If} $PxMode = 0
    StrCpy $INSTDIR $PxDir
    ${NSD_GetState} $PxCheckDesktop $R0
    ${If} $R0 = 1
      StrCpy $PxDesktop 1
    ${Else}
      StrCpy $PxDesktop 0
    ${EndIf}
  ${EndIf}
  ${If} $PxAllUsers = 1
    System::Call 'shell32::IsUserAnAdmin() i .r0'
    ${If} $0 = 0
      Call PxRelaunchElevated
      Return
    ${EndIf}
    SetShellVarContext all
  ${Else}
    SetShellVarContext current
  ${EndIf}
  StrCpy $AppStartMenuFolder "${STARTMENUFOLDER}"
  Push 1
  Call PxPress
FunctionEnd

; ---------------------------------------------------------------------------------------------
; Install: progress page (the stock page, restyled)
; ---------------------------------------------------------------------------------------------

!macro PxStatus text
  SetDetailsPrint textonly
  DetailPrint "${text}"
  SetDetailsPrint none
!macroend

Function PraxiInstShow
  Call PxChrome
  StrCpy $PxNsd 0
  FindWindow $PxDlg "#32770" "" $HWNDPARENT
  System::Call 'user32::SetWindowPos(p $PxDlg, p 0, i 0, i 0, i $PxCW, i $PxCH, i 0x14)'
  SetCtlColors $PxDlg "" ${PX_BG}
  GetDlgItem $0 $PxDlg 1016
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $PxDlg 1027
  ShowWindow $0 ${SW_HIDE}
  Call PxHeader
  ${If} $PxMode = 1
    Push "$(px_progress_update_title)"
  ${Else}
    Push "$(px_progress_install_title)"
  ${EndIf}
  Push ""
  Call PxTitleAndText
  Call PxProgressControls
FunctionEnd

Function PxProgressControls
  ; reuse the stock progress bar and status line, move them under the title and colour them
  GetDlgItem $PxProg $PxDlg 1004
  GetDlgItem $PxStatus $PxDlg 1006
  IntOp $0 48 * $PxDpi
  IntOp $0 $0 / 96
  IntOp $1 190 * $PxDpi
  IntOp $1 $1 / 96
  IntOp $2 464 * $PxDpi
  IntOp $2 $2 / 96
  IntOp $3 24 * $PxDpi
  IntOp $3 $3 / 96
  System::Call 'user32::SetWindowPos(p $PxStatus, p 0, i r0, i r1, i r2, i r3, i 0x14)'
  SendMessage $PxStatus ${WM_SETFONT} $PxFBody 1
  SetCtlColors $PxStatus ${PX_TEXT2} ${PX_BG}
  IntOp $1 224 * $PxDpi
  IntOp $1 $1 / 96
  IntOp $3 6 * $PxDpi
  IntOp $3 $3 / 96
  System::Call 'uxtheme::SetWindowTheme(p $PxProg, w "", w "")'
  SendMessage $PxProg 0x409 0 ${PX_ACCENT_BGR}
  SendMessage $PxProg 0x2001 0 ${PX_ELEVATED_BGR}
  System::Call 'user32::SetWindowPos(p $PxProg, p 0, i r0, i r1, i r2, i r3, i 0x14)'
  !insertmacro PxMkTo "" $R9 48 250 464 20 "STATIC" ${PX_STYLE_LABEL} 0 "$(px_progress_note)" $PxFSmall ${PX_MUTED} ${PX_BG}
FunctionEnd

; ---------------------------------------------------------------------------------------------
; Install: last page (Launch / Close)
; ---------------------------------------------------------------------------------------------

Function PraxiFinishPage
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
  Call PxChrome
  nsDialogs::Create 1018
  Pop $PxDlg
  ${If} $PxDlg == error
    Abort
  ${EndIf}
  StrCpy $PxNsd 1
  SetCtlColors $PxDlg "" ${PX_BG}
  Call PxHeader
  ${If} $PxMode = 1
    Push "$(px_finish_update_title)"
  ${Else}
    Push "$(px_finish_install_title)"
  ${EndIf}
  Push "$(px_finish_text)"
  Call PxTitleAndText
  !insertmacro PxMkTo "" $PxCtl 48 412 200 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$(px_btn_launch)" $PxFBtn ${PX_ACCENT_TEXT} ${PX_ACCENT}
  ${NSD_OnClick} $PxCtl PxLaunch
  !insertmacro PxMkTo "" $PxCtl 260 412 120 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$(px_btn_close)" $PxFBtn ${PX_TEXT} ${PX_ELEVATED}
  ${NSD_OnClick} $PxCtl PxCloseFinish
  nsDialogs::Show
FunctionEnd

Function PraxiFinishLeave
FunctionEnd

Function PxLaunch
  Call RunMainBinary
  Push 1
  Call PxPress
FunctionEnd

Function PxCloseFinish
  Push 1
  Call PxPress
FunctionEnd

; ---------------------------------------------------------------------------------------------
; Uninstall: confirm page (with the "Also delete app data" box, off by default)
; ---------------------------------------------------------------------------------------------

Function un.PraxiConfirmPage
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
  Call un.PxChrome
  nsDialogs::Create 1018
  Pop $PxDlg
  ${If} $PxDlg == error
    Abort
  ${EndIf}
  StrCpy $PxNsd 1
  SetCtlColors $PxDlg "" ${PX_BG}
  Call un.PxHeader
  Push "$(px_un_title)"
  Push "$(px_un_text)"
  Call un.PxTitleAndText
  !insertmacro PxMkTo "un." $PxCheckData 48 252 464 22 "BUTTON" ${PX_STYLE_CHECK} 0 "$(px_un_delete_data)" $PxFBody ${PX_TEXT} ${PX_BG}
  ${NSD_OnClick} $PxCheckData un.PxToggleWarning
  !insertmacro PxMkTo "un." $PxWarn 48 282 464 56 "STATIC" ${PX_STYLE_LABEL} 0 "$(px_un_delete_warning)" $PxFSmall ${PX_DANGER} ${PX_BG}
  ShowWindow $PxWarn ${SW_HIDE}
  !insertmacro PxMkTo "un." $PxCtl 48 412 200 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$(px_btn_uninstall)" $PxFBtn ${PX_DANGER_TEXT} ${PX_DANGER}
  ${NSD_OnClick} $PxCtl un.PxDoUninstall
  !insertmacro PxMkTo "un." $PxCtl 260 412 120 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$(px_btn_cancel)" $PxFBtn ${PX_TEXT} ${PX_ELEVATED}
  ${NSD_OnClick} $PxCtl un.PxCancel
  nsDialogs::Show
FunctionEnd

Function un.PraxiConfirmLeave
FunctionEnd

Function un.PxToggleWarning
  ${NSD_GetState} $PxCheckData $R0
  ${If} $R0 = 1
    ShowWindow $PxWarn ${SW_SHOW}
  ${Else}
    ShowWindow $PxWarn ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function un.PxDoUninstall
  ${NSD_GetState} $PxCheckData $R0
  ${If} $R0 = 1
    StrCpy $DeleteAppDataCheckboxState 1
  ${Else}
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
  Push 1
  Call un.PxPress
FunctionEnd

Function un.PxCancel
  Push 2
  Call un.PxPress
FunctionEnd

Function un.PraxiInstShow
  Call un.PxChrome
  StrCpy $PxNsd 0
  FindWindow $PxDlg "#32770" "" $HWNDPARENT
  System::Call 'user32::SetWindowPos(p $PxDlg, p 0, i 0, i 0, i $PxCW, i $PxCH, i 0x14)'
  SetCtlColors $PxDlg "" ${PX_BG}
  GetDlgItem $0 $PxDlg 1016
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $PxDlg 1027
  ShowWindow $0 ${SW_HIDE}
  Call un.PxHeader
  Push "$(px_un_progress_title)"
  Push ""
  Call un.PxTitleAndText
  Call un.PxProgressControls
FunctionEnd

Function un.PxProgressControls
  GetDlgItem $PxProg $PxDlg 1004
  GetDlgItem $PxStatus $PxDlg 1006
  IntOp $0 48 * $PxDpi
  IntOp $0 $0 / 96
  IntOp $1 190 * $PxDpi
  IntOp $1 $1 / 96
  IntOp $2 464 * $PxDpi
  IntOp $2 $2 / 96
  IntOp $3 24 * $PxDpi
  IntOp $3 $3 / 96
  System::Call 'user32::SetWindowPos(p $PxStatus, p 0, i r0, i r1, i r2, i r3, i 0x14)'
  SendMessage $PxStatus ${WM_SETFONT} $PxFBody 1
  SetCtlColors $PxStatus ${PX_TEXT2} ${PX_BG}
  IntOp $1 224 * $PxDpi
  IntOp $1 $1 / 96
  IntOp $3 6 * $PxDpi
  IntOp $3 $3 / 96
  System::Call 'uxtheme::SetWindowTheme(p $PxProg, w "", w "")'
  SendMessage $PxProg 0x409 0 ${PX_ACCENT_BGR}
  SendMessage $PxProg 0x2001 0 ${PX_ELEVATED_BGR}
  System::Call 'user32::SetWindowPos(p $PxProg, p 0, i r0, i r1, i r2, i r3, i 0x14)'
FunctionEnd

; Uninstall: last page

Function un.PraxiDonePage
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
  Call un.PxChrome
  nsDialogs::Create 1018
  Pop $PxDlg
  ${If} $PxDlg == error
    Abort
  ${EndIf}
  StrCpy $PxNsd 1
  SetCtlColors $PxDlg "" ${PX_BG}
  Call un.PxHeader
  Push "$(px_un_done_title)"
  ${If} $DeleteAppDataCheckboxState = 1
    Push "$(px_un_done_deleted)"
  ${Else}
    Push "$(px_un_done_kept)"
  ${EndIf}
  Call un.PxTitleAndText
  !insertmacro PxMkTo "un." $PxCtl 48 412 200 44 "STATIC" ${PX_STYLE_BUTTON} 0 "$(px_btn_close)" $PxFBtn ${PX_ACCENT_TEXT} ${PX_ACCENT}
  ${NSD_OnClick} $PxCtl un.PxCloseDone
  nsDialogs::Show
FunctionEnd

Function un.PraxiDoneLeave
FunctionEnd

Function un.PxCloseDone
  Push 1
  Call un.PxPress
FunctionEnd
