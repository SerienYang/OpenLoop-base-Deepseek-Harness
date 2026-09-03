# Openloop Credential Mask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Agent Plan credential-management entry and show a fixed, value-free mask for configured Keychain credentials.

**Architecture:** Keep all plaintext handling in the existing macOS native credential Sheet. The Models editor trusts the Host-projected opaque `credentialRef` when deciding whether a pi-ai provider has a registered credential route, while `CredentialControl` renders only status, a constant mask, and existing Host-backed actions.

**Tech Stack:** React 18, TypeScript, CSS Modules, Vitest, Testing Library, WebdriverIO, Tauri AppKit credential Sheet

---

### Task 1: Render the Host credential control for redacted pi-ai profiles

**Files:**
- Modify: `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:209-211`
- Test: `packages/client/ui-settings-models/tests/components.client.spec.tsx:252-292`

- [ ] **Step 1: Write the failing Agent Plan regression test**

Add a ModelsSection test whose provider directory returns:

```ts
{
  provider: 'volcengine-agent-plan',
  displayName: '火山方舟 Agent Plan',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'volcengine-agent-plan'],
  active: true,
  builtIn: true,
  declared: true,
  credentialRef: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
}
```

The `llm-pi-ai` namespace must contain the provider profile and models but omit
`apiKeyEnv`, matching the Openloop Host projection. Open the Agent Plan editor
and assert:

```ts
expect(renderCredential).toHaveBeenCalledWith(expect.objectContaining({
  reference: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
  label: en.keyInput,
}))
expect(document.body.textContent).not.toContain('VOLCENGINE_ARK_AGENT_PLAN_API_KEY')
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm openloop:gate-test -- vitest --files \
  packages/client/ui-settings-models/tests/components.client.spec.tsx
```

Expected: FAIL because the pi-ai editor renders `keyManagedAfterApply` instead
of invoking the Host credential control.

- [ ] **Step 3: Implement the minimal rendering fix**

Change the registration check in `ProviderEditor` to accept the opaque,
Host-approved reference:

```ts
const hasRegisteredKeyRef = layout !== 'pi-ai'
  || props.credentialRef !== undefined
  || stringAt(fallback, 'apiKeyEnv') !== undefined
```

Do not expose `apiKeyEnv`, relax the settings projection, or derive a new
reference in the browser.

- [ ] **Step 4: Re-run the focused test**

Run the command from Step 2.

Expected: PASS, including the new Agent Plan regression.

- [ ] **Step 5: Commit the provider rendering fix**

```bash
git add \
  packages/client/ui-settings-models/src/client/ProviderEditor.tsx \
  packages/client/ui-settings-models/tests/components.client.spec.tsx
git commit -m "fix(models): restore Agent Plan credential control"
```

### Task 2: Show a fixed Keychain mask and accurate read-only states

**Files:**
- Modify: `packages/openloop/shell/src/client/CredentialControl.tsx:30-219`
- Modify: `packages/openloop/shell/src/client/CredentialControl.module.css:1-85`
- Modify: `packages/openloop/shell/src/client/locales.ts:38-55,96-113`
- Test: `packages/openloop/shell/tests/credential-control.client.spec.tsx:79-381`

- [ ] **Step 1: Write failing tests for the configured mask**

Extend the configured Keychain test to assert:

```ts
expect(screen.getByText('**** **** **** ****')).toBeTruthy()
expect(screen.getByRole('button', { name: '更新 API 密钥' })).toBeTruthy()
expect(document.querySelector('input')).toBeNull()
expect(document.body.textContent).not.toContain('DEEPSEEK_API_KEY')
```

Extend the missing-state test to assert the mask is absent and the existing
“添加 API 密钥” action remains.

- [ ] **Step 2: Write a failing test for refresh-time action disabling**

Drive a `refreshToken` change while the second `describeCredential` call is
pending. Assert the existing “更新 API 密钥” and “删除 API 密钥” buttons remain
visible but disabled until the refreshed status settles.

- [ ] **Step 3: Write failing tests for read-only external sources**

Update the parameterized environment and legacy-file test, including their
`env` and `file` aliases, to assert:

```ts
expect(screen.queryByText('**** **** **** ****')).toBeNull()
expect(screen.queryByText('尚未配置 API 密钥')).toBeNull()
expect(screen.getByText(expectedReadOnlyCopy)).toBeTruthy()
```

Keep assertions that update and delete actions are absent.

- [ ] **Step 4: Update the test translators for the approved copy**

Add every new locale key to the test-local `zhT` and `enT` dictionaries. Change
existing “替换 API 密钥” / “Replace API key” button assertions to the approved
“更新 API 密钥” / “Update API key” copy.

- [ ] **Step 5: Run the focused shell tests and verify the expected failures**

Run:

```bash
pnpm openloop:gate-test -- vitest --files \
  packages/openloop/shell/tests/credential-control.client.spec.tsx
```

Expected: FAIL because configured credentials have no mask and read-only
configured sources are currently labelled as missing. The refresh test must
also fail because the visible actions are not disabled while `reading` is true.

- [ ] **Step 6: Implement the credential presentation states**

Use separate booleans:

```ts
const keychainConfigured =
  status?.configured === true && status.source === 'keychain'
const readOnlyConfigured =
  status?.configured === true
  && (status.source === 'environment'
    || status.source === 'env'
    || status.source === 'legacy-file'
    || status.source === 'file')
```

Render `**** **** **** ****` only when `keychainConfigured` is true. Use
`keychainConfigured` for “更新/删除” labels, preserve `writable` as the action
gate, and add localized read-only status copy so an external source is never
called missing. Disable every visible action while `reading` or `busy` is true,
so a refresh cannot leave a button that silently ignores clicks.

- [ ] **Step 7: Style the scheme A credential row**

Add a stable mask column inside the existing flex control:

```css
.mask {
  flex: none;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  white-space: nowrap;
}
```

Keep the label/status/source summary flexible, actions fixed width, and allow
the control to wrap without overlap at narrow settings-panel widths. Do not
add a reveal icon or an editable password input.

- [ ] **Step 8: Re-run the shell tests**

Run the command from Step 5.

Expected: PASS with fixed mask, existing update lifecycle, and source-specific
read-only states.

- [ ] **Step 9: Run the paired Models and Shell suites**

Run:

```bash
pnpm openloop:gate-test -- vitest --files \
  packages/client/ui-settings-models/tests/components.client.spec.tsx \
  packages/openloop/shell/tests/credential-control.client.spec.tsx \
  packages/openloop/shell/tests/settings.client.spec.tsx
```

Expected: PASS with no unhandled rejections. The three existing
`vite-tsconfig-paths` deprecation warnings may remain; no new warning is
introduced by this change.

- [ ] **Step 10: Commit the credential row**

```bash
git add \
  packages/openloop/shell/src/client/CredentialControl.tsx \
  packages/openloop/shell/src/client/CredentialControl.module.css \
  packages/openloop/shell/src/client/locales.ts \
  packages/openloop/shell/tests/credential-control.client.spec.tsx
git commit -m "feat(openloop): show masked Keychain credentials"
```

### Task 3: Verify the native update flow and security boundary

**Files:**
- Modify: `apps/web/tests/openloop-credential-boundary.e2e.ts:217-325`
- Modify: `apps/openloop-desktop/tests/openloop-shell.e2e.ts:186-245`
- Test: `apps/openloop-desktop/tests/openloop-shell.e2e.ts`
- Test: `apps/web/tests/openloop-credential-boundary.e2e.ts`

- [ ] **Step 1: Extend the deterministic browser boundary scenario**

After `bridge.completeCredentialReplacement(sentinel)` and the configured
status refresh, assert inside the open Models editor:

```ts
await expect(settings.getByText('**** **** **** ****')).toBeVisible()
await expect(settings.getByRole('button', { name: '更新 API 密钥' })).toBeVisible()
expect(await settings.locator('input[type="password"]').count()).toBe(0)
expect(await settings.innerText()).not.toContain(REF)
expect(await settings.innerText()).not.toContain(sentinel)
```

This existing bridge fixture deterministically transitions from missing to a
configured Keychain status without exposing plaintext.

- [ ] **Step 2: Build prerequisites and run the browser regression**

Run:

```bash
pnpm build:lib
DSH_SNAPSHOT=replay pnpm openloop:gate-test -- playwright \
  --file apps/web/tests/openloop-credential-boundary.e2e.ts
```

Expected: PASS; the configured state shows the fixed mask and update action,
while the browser has no plaintext credential methods or inputs.

- [ ] **Step 3: Add a scoped desktop flow assertion**

In the existing real-runtime WDIO scenario:

1. Open Settings and select `#openloop-settings-tab-models`.
2. Find the 火山方舟 Agent Plan row and open its editor.
3. Scope all following selectors to that editor.
4. Find the single Host action with a bilingual selector accepting
   “更新 API 密钥” / “Update API key” or
   “添加 API 密钥” / “Add API key”; do not depend on the startup locale.
5. Assert the editor text does not contain
   `VOLCENGINE_ARK_AGENT_PLAN_API_KEY`.
6. Record the current count of `credential-replacement:main` audit events.
7. Click the action and wait until the count increases.
8. Assert only one Tauri window exists because the prompt is an attached
   AppKit Sheet.

- [ ] **Step 4: Build and verify the desktop flow**

```bash
pnpm openloop:build-e2e
pnpm openloop:gate-test -- wdio \
  --config apps/openloop-desktop/wdio.conf.ts \
  --binary ".artifacts/openloop-e2e-target/aarch64-apple-darwin/release/bundle/macos/Openloop E2E.app/Contents/MacOS/openloop-desktop" \
  --file apps/openloop-desktop/tests/openloop-shell.e2e.ts
```

Expected: PASS; the action opens the native attached Sheet and no second
WebView window appears.

- [ ] **Step 5: Run static and package checks**

Run:

```bash
pnpm openloop:gate-test -- vitest --files \
  apps/openloop-desktop/tests/credentials.spec.ts \
  apps/openloop-desktop/tests/config.spec.ts \
  packages/openloop/shell/tests/credential-control.client.spec.tsx \
  packages/client/ui-settings-models/tests/components.client.spec.tsx
pnpm typecheck
pnpm lint
```

Expected: all commands PASS with no new warnings.

- [ ] **Step 6: Check the diff for secret leakage**

Run:

```bash
git diff --check
git diff origin/main...HEAD -- \
  packages/client/ui-settings-models \
  packages/openloop/shell \
  apps/web/tests/openloop-credential-boundary.e2e.ts \
  apps/openloop-desktop/tests/openloop-shell.e2e.ts \
  | rg -n 'sk-|API_KEY|credentialRef|password'
```

Expected: only test fixtures, opaque reference assertions, and the explicit
ban on password inputs appear. No real secret values or new plaintext
credential transport is present.

- [ ] **Step 7: Commit the desktop regression**

```bash
git add \
  apps/web/tests/openloop-credential-boundary.e2e.ts \
  apps/openloop-desktop/tests/openloop-shell.e2e.ts
git commit -m "test(openloop): cover native credential update entry"
```

- [ ] **Step 8: Final branch verification**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: clean worktree with the design commits plus the focused provider,
credential UI, and desktop regression commits.
