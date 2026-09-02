# Openloop Shell Compatibility Evidence

## Scope

Task 6 verifies the minimum branded shell and update UI without adding provider
onboarding, Workbench, Marketplace, CI wiring, or release permissions.

## Browser assembly

`apps/web/tests/openloop-minimum-shell.e2e.ts` boots the shipped DSH and Openloop
Cordis patches through the real Web server. The only native substitute is
`AuthenticatedUnixBridgeServer`, which uses the production authenticated frame
protocol over a Unix socket.

The fixture is deterministic and keyless. It proves:

- Openloop document title, sidebar, hero, Settings, and About identity.
- Required DSH conversation, tool/details, trajectory, approval, question,
  Plan, and model-selection contributors remain active.
- The shell refreshes update state on mount, performs a manual check, displays
  an available version, renders release notes as text, restores availability
  after a cancelled install, and presents bridge failures.
- Update IDs stay in the bridge client and do not enter the rendered view.

Run:

```sh
DSH_SNAPSHOT=replay pnpm openloop:gate-test -- playwright --file apps/web/tests/openloop-minimum-shell.e2e.ts
```

## Native desktop

`apps/openloop-desktop/tests/openloop-shell.e2e.ts` drives the compiled macOS
app through the embedded WDIO WebDriver. The E2E app uses the production
`start_runtime` path, bundled `openloop-runtime`, one-time bootstrap exchange,
authenticated Unix Desktop Bridge, Openloop Client plugins, and update and
Workspace stores. It checks manual update availability, cancelled install,
credential and Workspace AppKit sheets attached to the main window, and
resize/maximize behavior.

The native test boundary is explicit:

- Cargo dependencies `tauri-plugin-wdio` and
  `tauri-plugin-wdio-webdriver` are optional.
- Only feature `openloop-e2e` enables them.
- `tauri.e2e.conf.json` selects only capability `e2e`.
- Release `tauri.conf.json` selects only capability `main`.
- Release capability `main.json` contains no WDIO permission.
- `DSH_HOME` is a fresh private temporary directory for every run.
- A feature-gated native `UpdateChecker` returns version `0.2.0`, so the real
  bridge and update state are deterministic without contacting an updater.
- Feature-and-environment-gated AppKit automation records only after the real
  `beginSheet`/`beginSheetModalForWindow` call, then cancels the sheet. The
  test requires exactly the credential, update-install, and Workspace audit
  records, all attached to window `main`.
- No E2E-only DOM, CSS, or Tauri action command is present.

Build and run:

```sh
pnpm openloop:gate-test -- wdio --config apps/openloop-desktop/wdio.conf.ts --binary ".artifacts/openloop-e2e-target/aarch64-apple-darwin/release/bundle/macos/Openloop E2E.app/Contents/MacOS/openloop-desktop" --file apps/openloop-desktop/tests/openloop-shell.e2e.ts
```

The gate first rebuilds all host/client libraries, the Web bundle, runtime
sidecar, and manifests, then builds the E2E app under the ignored
`.artifacts/openloop-e2e-target` Cargo target. The release target is never
written. Release builds remain separately checked with the default Cargo
feature set and production Tauri configuration.
