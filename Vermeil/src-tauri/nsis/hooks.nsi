; NSIS installer hooks for Vermeil.
;
; Tauri's stock NSIS template handles 99% of what we need (license screen,
; install location picker, Start Menu + desktop shortcuts, registration with
; Add/Remove Programs, an uninstaller with a "Delete the application data"
; checkbox on the confirm page). These hooks add the bits that the default
; doesn't:
;
;   - When the user UN-checks "Delete the application data" on the confirm
;     page, do nothing extra. The data folder stays put for a future reinstall.
;
;   - When the user CHECKS the "Delete the application data" box, surface
;     a confirm dialog right before we delete so it isn't a one-click silent
;     wipe of accounts/instances/settings.
;
; Reference: tauri docs at https://tauri.app/distribute/windows-installer/
; Reference: NSIS docs at https://nsis.sourceforge.io/Docs/Chapter4.html

!include "MUI2.nsh"
!include "FileFunc.nsh"

; -----------------------------------------------------------------------------
; Tauri exposes the "Delete the application data" checkbox state as a global
; named $DeleteAppDataCheckboxState. We read that variable to decide whether
; to show the warning + perform the rmdir. We do NOT show our own checkbox
; — Tauri's confirm page already has one and it's the right UX.
;
; Values:
;   $DeleteAppDataCheckboxState == "1"  -> user wants the data folder gone
;   $DeleteAppDataCheckboxState == "0"  -> keep the data folder (default)
; -----------------------------------------------------------------------------

Var DeleteUserData

!macro NSIS_HOOK_PREUNINSTALL
    ; Default: don't touch user data.
    StrCpy $DeleteUserData "0"

    ; If the user opted in via Tauri's confirm-page checkbox, ask them to
    ; double-confirm — this is destructive and worth the extra click.
    ${If} $DeleteAppDataCheckboxState == "1"
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
            "This will permanently delete your Vermeil data folder including all instances, accounts, settings, and downloads stored in:$\r$\n$APPDATA\Vermeil$\r$\n$\r$\nAre you sure?" \
            /SD IDNO \
            IDNO skip
        StrCpy $DeleteUserData "1"
        skip:
    ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
    ${If} $DeleteUserData == "1"
        DetailPrint "Removing user data folder $APPDATA\Vermeil"
        RMDir /r "$APPDATA\Vermeil"
    ${EndIf}
!macroend
