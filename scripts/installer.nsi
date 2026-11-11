Unicode true
!include "MUI2.nsh"
!include "x64.nsh"

Name "sonac launcher"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\sonac launcher"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ICON "${APPICON}"
!define MUI_UNICON "${APPICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\sonac launcher.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "sonac launcher requires 64-bit Windows."
    Abort
  ${EndIf}
  SetShellVarContext current
FunctionEnd

Section "sonac launcher"
  SetOutPath "$INSTDIR"
  File /r "${SOURCE}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\sonac launcher"
  CreateShortcut "$SMPROGRAMS\sonac launcher\sonac launcher.lnk" "$INSTDIR\sonac launcher.exe" "" "$INSTDIR\SonacLauncher.ico"
  CreateShortcut "$SMPROGRAMS\sonac launcher\제거.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "DisplayName" "sonac launcher"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "DisplayIcon" "$INSTDIR\SonacLauncher.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !include "${UNINSTALL_FILES}"
  Delete "$SMPROGRAMS\sonac launcher\sonac launcher.lnk"
  Delete "$SMPROGRAMS\sonac launcher\제거.lnk"
  RMDir "$SMPROGRAMS\sonac launcher"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SonacLauncher"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SonacLauncher"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
