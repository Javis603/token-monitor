# In assisted mode, perMachine: false allows users to choose between
# per-user and per-machine installation. Force per-user installation.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

# Chromium runs the GPU and renderer processes in an AppContainer, and those
# children still have to read the app's own files out of $INSTDIR. A per-user
# install under %LocalAppData%\Programs inherits no ALL RESTRICTED APPLICATION
# PACKAGES entry, which is normally harmless, but on machines carrying explicit
# AppContainer/capability ACEs on the profile (agent sandboxes, MSIX leftovers)
# the children abort during early startup with STATUS_BREAKPOINT (0x80000003),
# before any GPU code runs. That kills the app outright through the GPU process
# and leaves a permanently blank window through the renderer. Granting
# read/execute to S-1-15-2-2 on our own install directory fixes it with both
# Chromium sandboxes left enabled. See issue #487 and electron/electron#51761.
#
# Three details are deliberate. The SID literal is used because the display name
# is localized and would not resolve on a non-English Windows. /grant is
# additive, never /grant:r, so no existing entry is replaced. And the exit code
# is logged rather than acted on, so an unusual or hardened DACL cannot fail an
# install over a startup workaround.
!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"'
  Pop $0
  DetailPrint "icacls grant for *S-1-15-2-2 on $INSTDIR exited with $0"
!macroend
