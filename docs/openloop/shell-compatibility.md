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
- Required DSH conversation, tool, approval, question, Plan, model selection,
  and details contributors remain active.
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
binary through the embedded WDIO WebDriver. It checks the embedded version,
manual update availability, cancelled install, a credential sheet attached to
the main window, Workspace entry, resize, and maximize.

The test-only boundary is explicit:

- Cargo dependencies `tauri-plugin-wdio` and
  `tauri-plugin-wdio-webdriver` are optional.
- Only feature `openloop-e2e` enables them.
- `tauri.e2e.conf.json` selects only capability `e2e`.
- Release `tauri.conf.json` selects only capability `main`.
- Release capability `main.json` contains no WDIO permission.
- The E2E feature does not start the production sidecar or contact an updater
  endpoint; its native action command returns fixed fixture outcomes.

Build and run:

```sh
pnpm --dir apps/openloop-desktop tauri build --config tauri.e2e.conf.json --target aarch64-apple-darwin --no-bundle --features openloop-e2e
pnpm openloop:gate-test -- wdio --config apps/openloop-desktop/wdio.conf.ts --binary apps/openloop-desktop/src-tauri/target/aarch64-apple-darwin/release/openloop-desktop --file apps/openloop-desktop/tests/openloop-shell.e2e.ts
```

The release build is separately checked with the default Cargo feature set and
the production Tauri configuration.
