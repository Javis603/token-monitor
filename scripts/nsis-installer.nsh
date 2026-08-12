# In assisted mode, perMachine: false allows users to choose between
# per-user and per-machine installation. Force per-user installation.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend
