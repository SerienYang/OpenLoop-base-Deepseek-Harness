# Openloop Window State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Openloop main window's last size, position, and maximized state without restoring fullscreen.

**Architecture:** Register the official Tauri window-state plugin in the Rust desktop host. Restrict its state flags to position, size, and maximized state, and filter persistence to the `main` window label so secure prompts and future auxiliary windows remain unaffected.

**Tech Stack:** Rust 2021, Tauri 2.11.5, `tauri-plugin-window-state` 2.4.1, TypeScript, Vitest

---

## File Structure

- Modify `apps/openloop-desktop/tests/config.spec.ts`: enforce the pinned dependency and exact native registration contract.
- Modify `apps/openloop-desktop/src-tauri/Cargo.toml`: add the official plugin dependency.
- Modify `apps/openloop-desktop/src-tauri/Cargo.lock`: lock the new transitive dependency graph.
- Modify `apps/openloop-desktop/src-tauri/src/lib.rs`: construct and register the filtered plugin.

### Task 1: Add The Failing Desktop Contract

**Files:**
- Modify: `apps/openloop-desktop/tests/config.spec.ts`
- Test: `apps/openloop-desktop/tests/config.spec.ts`

- [ ] **Step 1: Add a focused failing contract test**

Add this test beside the existing desktop configuration and Host ownership tests:

```ts
test('persists only the main window size, position, and maximized state', () => {
  const cargo = record(
    parseToml(readText('apps/openloop-desktop/src-tauri/Cargo.toml')),
    'Cargo.toml',
  )
  const rustDependencies = record(cargo.dependencies, 'Cargo dependencies')
  const windowStateDependency = record(
    rustDependencies['tauri-plugin-window-state'],
    'tauri-plugin-window-state dependency',
  )
  const library = readText('apps/openloop-desktop/src-tauri/src/lib.rs')

  expect(windowStateDependency).toMatchObject({ version: '=2.4.1' })
  expect(library).toMatch(/use tauri_plugin_window_state::StateFlags;/u)
  expect(library).toMatch(
    /StateFlags::POSITION\s*\|\s*StateFlags::SIZE\s*\|\s*StateFlags::MAXIMIZED/u,
  )
  expect(library).not.toMatch(/StateFlags::FULLSCREEN/u)
  expect(library).toMatch(/\.with_filter\(\|label\|\s*label\s*==\s*"main"\)/u)
  expect(library).toMatch(/\.plugin\(window_state_plugin\)/u)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm openloop:gate-test -- vitest --files apps/openloop-desktop/tests/config.spec.ts
```

Expected: FAIL in the new test because the `tauri-plugin-window-state` dependency and registration are absent.

- [ ] **Step 3: Commit the failing contract**

```bash
git add apps/openloop-desktop/tests/config.spec.ts
git commit -m "test(desktop): require persisted main window state"
```

### Task 2: Register The Official Window-State Plugin

**Files:**
- Modify: `apps/openloop-desktop/src-tauri/Cargo.toml`
- Modify: `apps/openloop-desktop/src-tauri/Cargo.lock`
- Modify: `apps/openloop-desktop/src-tauri/src/lib.rs`
- Test: `apps/openloop-desktop/tests/config.spec.ts`

- [ ] **Step 1: Add the pinned Rust dependency**

Add to `[dependencies]`:

```toml
tauri-plugin-window-state = { version = "=2.4.1" }
```

Regenerate `apps/openloop-desktop/src-tauri/Cargo.lock` through Cargo.

- [ ] **Step 2: Register the filtered state plugin**

Import the state flags:

```rust
use tauri_plugin_window_state::StateFlags;
```

Before building the Tauri builder, construct:

```rust
let window_state_plugin = tauri_plugin_window_state::Builder::default()
    .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
    .with_filter(|label| label == "main")
    .build();
```

Register it on the builder:

```rust
let builder = tauri::Builder::default()
    .plugin(window_state_plugin)
    .plugin(updater_plugin)
    .manage(updater_config);
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```bash
pnpm openloop:gate-test -- vitest --files apps/openloop-desktop/tests/config.spec.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 4: Prepare ignored native build prerequisites**

Prepare same-platform ignored build artifacts for this isolated worktree:

```bash
mkdir -p dist-openloop
cp ../../dist-openloop/openloop-core.json dist-openloop/
cp ../../dist-openloop/openloop-artifacts.json dist-openloop/
cp \
  ../volcengine-agent-plan/apps/openloop-desktop/src-tauri/binaries/openloop-runtime-aarch64-apple-darwin \
  apps/openloop-desktop/src-tauri/binaries/
```

These files are native test prerequisites and must not be committed. If those existing artifacts are unavailable or stale, regenerate them through the repository's `openloop:build-desktop` pipeline instead.

- [ ] **Step 5: Verify Rust compilation and unit tests**

Run:

```bash
cargo test --manifest-path apps/openloop-desktop/src-tauri/Cargo.toml --locked
cargo check --manifest-path apps/openloop-desktop/src-tauri/Cargo.toml --locked
```

Expected: both commands exit 0.

- [ ] **Step 6: Verify formatting and diff hygiene**

Run:

```bash
cargo fmt --manifest-path apps/openloop-desktop/src-tauri/Cargo.toml -- --check
git diff --check
git status --short
```

Expected: formatting and diff checks exit 0; status lists only the intended Cargo, Rust, lockfile, and test changes. The implementation plan has already been committed separately.

- [ ] **Step 7: Commit the implementation**

```bash
git add \
  apps/openloop-desktop/src-tauri/Cargo.toml \
  apps/openloop-desktop/src-tauri/Cargo.lock \
  apps/openloop-desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): persist main window state"
```

### Task 3: Manual macOS Acceptance

**Files:**
- No source changes

- [ ] **Step 1: Launch the desktop app**

Run:

```bash
pnpm --dir apps/openloop-desktop dev
```

- [ ] **Step 2: Verify normal geometry restoration**

Resize and move the main window, quit Openloop normally, relaunch it, and confirm the same usable size and position return.

- [ ] **Step 3: Verify maximized and fullscreen behavior**

Quit once while maximized and confirm the next launch is maximized. Quit once while fullscreen and confirm the next launch is not fullscreen; pre-fullscreen geometry is not asserted.

- [ ] **Step 4: Record any environment limitation**

If local app launch is blocked by signing, generated runtime artifacts, or macOS automation constraints, report that limitation explicitly while retaining the passing automated evidence.
