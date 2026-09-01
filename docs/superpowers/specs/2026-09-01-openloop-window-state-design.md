# Openloop Window State Persistence Design

## Goal

Openloop restores the main window's last usable size, position, and maximized state when the desktop app starts again.

## Current Behavior

`apps/openloop-desktop/src-tauri/tauri.conf.json` defines a fixed initial size of 760 by 520 pixels. The Rust host does not register a window-state persistence component, so every launch uses that initial configuration.

## Design

Use the official Tauri v2 `tauri-plugin-window-state` Rust plugin, pinned to version `2.4.1`. Register it on the desktop host builder with these state flags only:

- `POSITION`
- `SIZE`
- `MAXIMIZED`

Do not persist `FULLSCREEN`. Closing the app while fullscreen therefore does not force the next launch into fullscreen.

Filter tracking to the `main` window label. Secure prompts and any future auxiliary windows must not share or create persisted window state.

Keep the existing main-window configuration unchanged:

- initial and fallback size: 760 by 520 pixels;
- minimum size: 760 by 520 pixels;
- resizable and maximizable;
- fullscreen disabled by default.

The plugin owns native window-state storage and restoration. No JavaScript API, frontend dependency, capability permission, app-authored IPC command, or custom state file is added. The plugin's built-in IPC handlers are not exposed through a frontend capability.

## Startup And Exit

On normal startup, the plugin restores valid saved state before the user begins interacting with the main window. On application exit, it saves the selected state fields.

If no saved state exists, or saved state cannot be used, Tauri's configured main-window geometry remains the fallback. The official plugin remains responsible for platform-specific handling such as changed monitor layouts.

Excluding `FULLSCREEN` means only that fullscreen mode itself is never restored. Preserving the pre-fullscreen windowed geometry when the app is closed while fullscreen is outside this change; the plugin and macOS may record the geometry reported at exit.

Updater check, install, and health-probe actions do not create an interactive main window. Registering the plugin must not change those command paths.

## Verification

1. A contract test fails until the Cargo dependency and Rust plugin registration exist.
2. The contract test verifies that restoration flags include position, size, and maximized state, exclude fullscreen state, and filter tracking to the `main` label.
3. Existing desktop configuration tests continue to verify the 760 by 520 fallback and minimum dimensions.
4. Run the focused desktop tests and `cargo check` for the desktop host.
5. On macOS, manually resize and move Openloop, quit it, reopen it, and verify the geometry returns. Repeat from maximized and fullscreen states; maximized mode should return and fullscreen mode should not. The fullscreen case does not assert pre-fullscreen windowed geometry.

## Non-Goals

- Persisting fullscreen state.
- Preserving pre-fullscreen windowed geometry when quitting from fullscreen.
- Changing the default or minimum window dimensions.
- Persisting internal panel layout or web UI state.
- Adding a user-facing reset-window command.
