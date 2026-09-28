---
task: 10
status: todo
depends_on: [9]
rework_rounds: 0
---

# Build and automatically test the Windows installer

## Goal
Create a user-scoped Inno Setup installer for the complete payload and automate install, reinstall/upgrade, launch, and uninstall checks on Windows CI.

## Scope
Inno Setup sources, installer build/test scripts, release tests, documentation directly tied to installer behavior, and Windows CI. Signing and Application Control certification are excluded.

## Do
- Use a stable AppId and per-user installation under `%LOCALAPPDATA%` with `PrivilegesRequired=lowest`; the default path must not prompt for elevation.
- Install the complete onedir payload, licenses/notices, Start Menu shortcut for opening the UI, and the uninstaller.
- Keep mutable state and models outside the installation directory. Reinstall/upgrade and default uninstall must preserve recipes, preferences, history, logs, and downloaded models.
- Offer explicit, unchecked-by-default user-data removal during interactive uninstall and an explicit equivalent for automated testing. Clearly list which data will be removed.
- Add signed-ready build hooks/ordering without embedding credentials, certificate material, or claims that unsigned artifacts are signed.
- Generate installer checksums and a machine-readable manifest tying the installer to its payload/version.
- Add unattended Windows CI tests for clean install, same-AppId reinstall/upgrade behavior, service/UI smoke without developer tools, default uninstall preservation, explicit data removal, and removal of program files/shortcuts.
- Fail tests if files are written beside installed program files at runtime or if uninstall removes user data without explicit selection.

## Acceptance criteria
- [ ] Default installation is current-user scoped and requests no administrator elevation.
- [ ] Installed service, UI, fake smoke decision, MCP executable, notices, shortcut, and uninstaller all work from the installed layout.
- [ ] Automated reinstall/upgrade preserves user state and keeps a single coherent installation identity.
- [ ] Default uninstall preserves app data; explicit removal deletes only the documented OpenReflex data directory after confirmation.
- [ ] CI produces and tests an unsigned/signed-ready installer without claiming release-signing completion.
- [ ] `py scripts/verify.py` and the Windows package/installer test command pass.

## Out of scope
- Code-signing certificate use or release signing.
- Clean-machine Application Control validation.
- Human-guided installer or usability testing.
