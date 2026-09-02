# Openloop Settings Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the misplaced Workspace Settings page and restore functional General, Models & Credentials, and Plugins settings without reopening unrestricted browser settings access or storing UI-entered keys outside Keychain.

**Architecture:** Keep the Openloop Settings shell and Workspace sidebar behavior. Add same-origin Host routes authenticated by the existing HttpOnly bootstrap session; those routes project and mutate only explicit namespaces and paths. Inject the resulting product settings API into shared Settings contributors while leaving the default DSH profile unchanged.

**Tech Stack:** TypeScript, Cordis, Typert API types, Node HTTP routes, React, Vitest, Playwright, WebdriverIO, Tauri 2.

---

### Task 1: Product Settings Adapter Contract

**Files:**
- Modify: `packages/client/ui-settings/src/client/index.ts`
- Modify: `packages/client/ui-settings/src/client/settings-scope.ts`
- Modify: `packages/client/ui-settings/tests/settings-scope.client.spec.ts`
- Modify: `packages/client/ui-settings-models/src/client/index.ts`
- Modify: `packages/client/ui-settings-models/src/client/ModelListEditor.tsx`
- Modify: `packages/client/ui-settings-models/src/client/ModelsSection.tsx`
- Modify: `packages/client/ui-settings-models/src/client/welcome-store.ts`
- Modify: `packages/client/ui-settings-models/tests/components.client.spec.tsx`
- Modify: `packages/client/ui-settings-models/tests/welcome-store.client.spec.ts`
- Modify: `packages/client/ui-settings-plugins/src/client/index.ts`
- Modify: `packages/client/ui-settings-plugins/tests/apply.client.spec.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests proving:

```ts
const owner: SettingsShellOwner = {
  id: 'openloop',
  settingsApi: filteredApi,
}
```

is used by Models, Plugins, and `SettingsScopeBinder`, while an owner without
`settingsApi` continues using `connection.api`. Require model discovery controls
to be absent when `settingsApi.llm.discoverModels` is undefined.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run \
  packages/client/ui-settings/tests/settings-scope.client.spec.ts \
  packages/client/ui-settings-models/tests/components.client.spec.tsx \
  packages/client/ui-settings-models/tests/welcome-store.client.spec.ts \
  packages/client/ui-settings-plugins/tests/apply.client.spec.ts
```

Expected: failures because `SettingsShellOwner.settingsApi` is not defined or
consulted.

- [ ] **Step 3: Add the minimal adapter contract**

Define a product-owned API with:

```ts
interface ProductSettingsApi {
  settings: Pick<IApiClient['settings'], 'describe' | 'mutate'>
  llm: {
    providers: IApiClient['llm']['providers']
    discoverModels?: IApiClient['llm']['discoverModels']
  }
}
```

Let `SettingsScopeBinder` accept an optional API override. Models and Plugins
select `ctx.settingsShellOwner.settingsApi` before `ctx.connection.api`.
Update onboarding acknowledgement and provider deletion to retain and submit
the namespace revision they loaded; never have the adapter infer a revision.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-settings packages/client/ui-settings-models packages/client/ui-settings-plugins
git commit -m "feat: support product-scoped settings adapters"
```

### Task 2: Authenticated Openloop Settings Host

**Files:**
- Create: `packages/openloop/bundle/src/settings-policy.ts`
- Create: `packages/openloop/bundle/src/settings-host.ts`
- Create: `packages/openloop/bundle/tests/settings-policy.spec.ts`
- Create: `packages/openloop/bundle/tests/settings-host.spec.ts`
- Modify: `packages/openloop/bundle/package.json`
- Modify: `packages/openloop/bundle/cordis.patch.yml`
- Modify: `packages/openloop/bundle/tests/profile.spec.ts`

- [ ] **Step 1: Write failing policy tests**

Cover the exact namespace/path matrix from the design. Include denial tests for
unknown namespaces, empty paths, endpoint fields, credential fields at any
depth, unregistered `apiKeyEnv` references, whole-section writes, oversized
bodies, duplicate namespaces, malformed revisions, and non-JSON values.

- [ ] **Step 2: Write failing route-authentication tests**

Require every describe, mutate, and provider-list request to carry the existing
`openloop_bootstrap` cookie and pass
`runtimeBootstrap.validateBootstrapSession`. Assert missing, malformed, stale,
and forged sessions return 401 before touching `ctx.settings` or `ctx.llm`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run \
  packages/openloop/bundle/tests/settings-policy.spec.ts \
  packages/openloop/bundle/tests/settings-host.spec.ts \
  packages/openloop/bundle/tests/profile.spec.ts
```

- [ ] **Step 4: Implement policy and routes**

Register exact POST routes:

```text
/api/openloop/settings/describe
/api/openloop/settings/mutate
/api/openloop/settings/providers
```

Use bounded JSON parsing, no-store responses, stable error codes, namespace
projection, mandatory `expectedRevision`, and schema validation through the
existing settings service. Provider projection includes only id, display name,
active state, settings address, built-in flag, and registered credential ref.

- [ ] **Step 5: Mount the Host plugin**

Export `./settings-host`, add it to the host profile after bootstrap and settings
providers, and assert no generic `settings.*` or `llm.discoverModels` browser
method becomes allowlisted.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run the Step 3 command. Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/openloop/bundle
git commit -m "feat: add authenticated Openloop settings facade"
```

### Task 3: Openloop Client Settings Foundation

**Files:**
- Create: `packages/openloop/settings-foundation/src/client/settings-api.ts`
- Modify: `packages/openloop/settings-foundation/src/client/index.ts`
- Modify: `packages/openloop/settings-foundation/package.json`
- Modify: `packages/openloop/settings-foundation/tests/plugin.client.spec.ts`
- Modify: `packages/openloop/shell/src/client/index.ts`
- Modify: `packages/openloop/shell/tests/settings.client.spec.tsx`

- [ ] **Step 1: Write failing adapter tests**

Require same-origin fetches with `credentials: 'same-origin'`, filtered
descriptors, stable error mapping, revision forwarding, and no secret-bearing
request fields. Require the Openloop shell owner to expose this API and existing
Keychain `credentialControl`.

- [ ] **Step 2: Write failing durable General tests**

Bind `locale`, `ui-theme`, and `ui-conversation` through the Openloop settings
foundation; change one field in each and assert the next load reads the Host
revision and value rather than `mode: 'memory'` or `status: 'unavailable'`.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
pnpm exec vitest run \
  packages/openloop/settings-foundation/tests/plugin.client.spec.ts \
  packages/openloop/shell/tests/settings.client.spec.tsx
```

- [ ] **Step 4: Implement the fetch adapter and binder**

Use the authenticated Host routes, inject the adapter into
`SettingsScopeBinder`, and provide it through `SettingsShellOwner`. Keep
credential values exclusively in `credentialControl`.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run Step 3. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/openloop/settings-foundation packages/openloop/shell
git commit -m "feat: connect Openloop settings to scoped host storage"
```

### Task 4: Restore Settings Navigation and Remove Workspace Settings

**Files:**
- Modify: `packages/openloop/shell/src/client/OpenloopSettings.tsx`
- Modify: `packages/openloop/shell/src/client/index.ts`
- Modify: `packages/openloop/shell/tests/settings.client.spec.tsx`
- Modify: `packages/openloop/workspace-client/src/client/index.ts`
- Modify: `packages/openloop/workspace-client/tests/apply.client.spec.tsx`
- Modify: `packages/openloop/bundle/cordis.patch.yml`
- Modify: `packages/openloop/bundle/package.json`
- Modify: `packages/openloop/bundle/tests/profile.spec.ts`

- [ ] **Step 1: Write failing shell and Workspace tests**

Require Settings navigation ids to equal:

```ts
['general', 'models', 'plugins', 'about-update']
```

Assert there is no `UnavailableSettingsSection`, no
`settings.section/workspace`, and no “此版本暂不提供该设置” copy. Preserve tests
for sidebar list, add, authorize, reauthorize, rename, reveal, revoke, and
session guard.

- [ ] **Step 2: Write failing bundle tests**

Require General, Models, Plugins, and configurable plugin contributors enabled.
Keep permission, agent-preset, config-file opening, plugin inventory, and model
discovery disabled for this correction.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
pnpm exec vitest run \
  packages/openloop/shell/tests/settings.client.spec.tsx \
  packages/openloop/workspace-client/tests/apply.client.spec.tsx \
  packages/openloop/bundle/tests/profile.spec.ts
```

- [ ] **Step 4: Remove placeholders and Workspace registration**

Delete only the Settings Workspace contributor. Do not alter Workspace runtime,
sidebar, file broker, or authorization code.

- [ ] **Step 5: Enable real contributors and confirm GREEN**

Run Step 3. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/openloop/shell packages/openloop/workspace-client packages/openloop/bundle
git commit -m "fix: restore functional Openloop settings"
```

### Task 5: Credential, Concurrency, and Leakage Regression

**Files:**
- Modify: `packages/openloop/settings-foundation/tests/plugin.client.spec.ts`
- Modify: `packages/openloop/bundle/tests/settings-host.spec.ts`
- Modify: `packages/openloop/shell/tests/settings.client.spec.tsx`
- Modify: `apps/web/tests/openloop-minimum-shell.e2e.ts`
- Modify: `apps/openloop-desktop/tests/openloop-shell.e2e.ts`

- [ ] **Step 1: Add stale-revision and recoverable-draft tests**

Simulate two clients editing one namespace. Require the stale mutation to return
`SETTINGS_CONFLICT`, preserve its draft, refresh the Host value, and require an
explicit retry.

Add equivalent draft-preservation assertions for
`SETTINGS_POLICY_DENIED`, `SETTINGS_VALIDATION_FAILED`, and
`SETTINGS_UNAVAILABLE`. Send a mixed valid/invalid multi-operation mutation and
prove no field persists.

- [ ] **Step 2: Add secret-sentinel tests**

Enter a sentinel through the Keychain control and assert it is absent from
settings HTTP bodies/responses, DOM, local/session storage, console and Host
logs, crash artifacts, and settings files.

- [ ] **Step 3: Add real App restart persistence coverage**

Change Language/Appearance/Enter behavior, one model option, and one plugin
option; restart the App process; assert the restored values render. Confirm the
Keychain credential remains configured without its literal reaching the
browser.

Replace the obsolete desktop E2E click on
`#openloop-settings-tab-workspace` with sidebar Workspace assertions. The test
must prove Settings has no Workspace tab while sidebar authorization remains
available.

- [ ] **Step 4: Run focused E2E**

```bash
pnpm openloop:gate-test -- playwright --file apps/web/tests/openloop-minimum-shell.e2e.ts
pnpm openloop:gate-test -- wdio \
  --config apps/openloop-desktop/wdio.conf.ts \
  --file apps/openloop-desktop/tests/openloop-shell.e2e.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/openloop apps/web/tests apps/openloop-desktop/tests
git commit -m "test: cover restored Openloop settings end to end"
```

### Task 6: Full Verification and Local Replacement

**Files:**
- Modify if generated: `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`
- Modify if generated: `pnpm-lock.yaml`

- [ ] **Step 1: Regenerate catalogs**

```bash
pnpm run gen-client-catalog
pnpm run gen-cordis-inspect-catalog
```

- [ ] **Step 2: Run focused and full checks**

```bash
pnpm test
pnpm run typecheck
pnpm run lint
cargo test --manifest-path apps/openloop-desktop/src-tauri/Cargo.toml --all-targets --all-features
```

- [ ] **Step 3: Run release gates**

Run the existing minimum-shell, credential migration, Workspace authority,
rollback/cleanup, real Tauri shell, and release-default gates.

- [ ] **Step 4: Review the final diff**

Confirm no Workbench implementation, unrestricted settings methods, plaintext
credentials, or unrelated refactors entered the change.

Add a bundle test asserting there is no `workbench` slot contributor and no new
Workbench UI package in the Openloop profile; the manual diff review supplements
this executable assertion.

- [ ] **Step 5: Build and replace the local App**

Build the test-channel App, verify hashes/signature/bundle id, preserve the
current `.10` backup, atomically replace `/Applications/Openloop.app`, and
verify desktop/runtime processes plus Settings persistence.
