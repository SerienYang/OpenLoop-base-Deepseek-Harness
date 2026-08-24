# Openloop Chat Text Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent macOS `Command +/-/0` shortcuts that change only Openloop conversation transcript typography.

**Architecture:** A private `@openloop/chat-zoom` Cordis package owns the zoom model, Host settings schema, browser shortcut listener, and root CSS variable. DSH conversation and shared Markdown styles consume that value only through a transcript-local variable, preserving non-transcript controls and layouts.

**Tech Stack:** TypeScript, Cordis, Schemastery, DSH settings scopes, CSS Modules, Vitest, Playwright.

---

### Task 1: Scaffold And Register The Package

**Files:**
- Create: `packages/openloop/chat-zoom/package.json`
- Create: `packages/openloop/chat-zoom/README.md`
- Create: `packages/openloop/chat-zoom/tsconfig.json`
- Create: `packages/openloop/chat-zoom/tsdown.config.ts`
- Create: `packages/openloop/chat-zoom/src/index.ts`
- Create: `packages/openloop/chat-zoom/src/client/index.ts`
- Create: `packages/openloop/chat-zoom/tests/package-contract.spec.ts`
- Modify: `packages/openloop/bundle/package.json`
- Modify: `packages/openloop/bundle/cordis.patch.yml`
- Modify: `tsconfig.client.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Run the repository scaffolder as setup**

```sh
pnpm openloop:new-package -- \
  --name chat-zoom \
  --face client \
  --client-bundle \
  --bundle-row bundle
```

The target must be absent before this command; the scaffolder refuses an
existing `src/` directory.

- [ ] **Step 2: Add direct manifest dependencies and update the lockfile**

Add `@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery`,
`@deepseek-ai/dsh-client-runtime`, `@deepseek-ai/dsh-client-ui-settings`,
`@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-api-remotes`, and the
client test runtime according to existing package conventions. Set the exact
`dsh.client.inject` package list and `"immediately": true`.

Run:

```sh
pnpm install --lockfile-only
```

- [ ] **Step 3: Write the package contract test**

Assert the private Client face, exact Client injection package list,
`immediately: true`, one Client aggregate reference, bundle workspace
dependency, and exact row:

```ts
{ id: 'chat-zoom', name: '@openloop/chat-zoom' }
```

Also prove the package adds no Tauri capability or Openloop Host service.

- [ ] **Step 4: Run repository tests**

```sh
pnpm openloop:gate-test -- vitest --files \
  scripts/openloop/scaffold-package.spec.ts \
  scripts/openloop/workspace-conventions.spec.ts \
  packages/openloop/chat-zoom/tests/package-contract.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/openloop/chat-zoom packages/openloop/bundle/package.json \
  packages/openloop/bundle/cordis.patch.yml tsconfig.client.json pnpm-lock.yaml
git commit -m "build: register Openloop chat zoom plugin"
```

### Task 2: Define The Pure Zoom Contract

**Files:**
- Create: `packages/openloop/chat-zoom/tests/zoom.spec.ts`
- Create: `packages/openloop/chat-zoom/src/zoom.ts`

- [ ] **Step 1: Write failing model and shortcut tests**

Cover levels `80..160` by tens, default `100`, boundary clamping, reset,
supported-value validation, `Meta+=`, `Meta++`, `Meta+-`, `Meta+_`, and
`Meta+0`. Explicitly prove Shift variants work and Ctrl/Alt, missing Meta, and
unrelated keys are ignored.

- [ ] **Step 2: Run the focused test and observe RED**

```sh
pnpm openloop:gate-test -- vitest --files packages/openloop/chat-zoom/tests/zoom.spec.ts
```

Expected: FAIL because `src/zoom.ts` does not exist.

- [ ] **Step 3: Implement the minimal DOM-free model**

```ts
export const CHAT_ZOOM_LEVELS = [80, 90, 100, 110, 120, 130, 140, 150, 160] as const
export const DEFAULT_CHAT_ZOOM = 100
export type ChatZoomCommand = 'increase' | 'decrease' | 'reset'

export function normalizeZoom(value: unknown): number
export function stepZoom(current: number, command: ChatZoomCommand): number
export function commandFromKeyboard(event: KeyboardShortcut): ChatZoomCommand | undefined
```

- [ ] **Step 4: Re-run the test and observe GREEN**

- [ ] **Step 5: Commit**

```sh
git add packages/openloop/chat-zoom/src/zoom.ts \
  packages/openloop/chat-zoom/tests/zoom.spec.ts
git commit -m "feat: define chat zoom behavior"
```

### Task 3: Establish Acceptance Tests Before Production Behavior

**Files:**
- Create: `apps/web/tests/openloop-chat-zoom.e2e.ts`

- [ ] **Step 1: Write the browser composition acceptance test**

Use the existing Vitest+Playwright scaffold:

```ts
launchWebScaffold({
  extraOverlayPath: 'packages/openloop/bundle/cordis.patch.yml',
  harnessHome,
})
```

Create a fixture conversation and assert keyboard-driven computed typography
for user text, Markdown headings/tables/fenced code, reasoning title/body, and
status text. Record and compare sidebar, header, composer, action-button,
image, code-banner, and copy-button dimensions.

- [ ] **Step 2: Add cross-port relaunch coverage**

Create `harnessHome` outside each scaffold-owned workspace. Launch and close
three scaffolds sequentially, reusing that directory while each instance gets
its own ephemeral port: persist `130%`, restore `130%`, reset, then restore
`100%`.

- [ ] **Step 3: Run the exact test and observe RED**

```sh
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/openloop-chat-zoom.e2e.ts
```

Expected: FAIL because Host settings, shortcuts, and scaled styles are not
implemented. Fixture startup errors are not an acceptable RED state.

- [ ] **Step 4: Commit the failing acceptance contract**

```sh
git add apps/web/tests/openloop-chat-zoom.e2e.ts
git commit -m "test: specify Openloop chat zoom acceptance"
```

### Task 4: Add Durable Host Settings

**Files:**
- Create: `packages/openloop/chat-zoom/src/settings.ts`
- Modify: `packages/openloop/chat-zoom/src/index.ts`
- Create: `packages/openloop/chat-zoom/tests/settings.spec.ts`

- [ ] **Step 1: Write failing schema and registration tests**

Test namespace `openloop-chat-zoom`, default `{ percent: 100 }`, rejection of
unsupported values, optional `settings` injection, and registration disposal.

- [ ] **Step 2: Run and observe RED**

```sh
pnpm openloop:gate-test -- vitest --files packages/openloop/chat-zoom/tests/settings.spec.ts
```

- [ ] **Step 3: Implement the settings contract**

Define a Schemastery union over the nine values. Register it in the default
Cordis entry through:

```ts
ctx.inject(['settings'], settingsCtx => {
  settingsCtx.settings.register(
    settingsNamespace(CHAT_ZOOM_SETTINGS_NAMESPACE),
    ChatZoomSettingsSchema,
  )
})
```

Do not add a service or direct filesystem storage.

- [ ] **Step 4: Re-run and observe GREEN**

- [ ] **Step 5: Commit**

```sh
git add packages/openloop/chat-zoom/src/settings.ts \
  packages/openloop/chat-zoom/src/index.ts \
  packages/openloop/chat-zoom/tests/settings.spec.ts
git commit -m "feat: persist chat zoom in Host settings"
```

### Task 5: Implement Browser Shortcut And Lifecycle Behavior

**Files:**
- Modify: `packages/openloop/chat-zoom/src/client/index.ts`
- Create: `packages/openloop/chat-zoom/tests/client-plugin.client.spec.ts`

- [ ] **Step 1: Write failing browser plugin tests**

Use a real Cordis context. Use `SettingsScopeController` with a fake API for
write-recovery behavior and controlled scopes for malformed/unavailable
snapshots. Prove:

- initial Host percent publishes `--openloop-chat-text-scale`;
- Shift variants work;
- supported keys prevent default, update immediately, and write `percent`;
- unrelated events do nothing;
- failed writes recover and roll back to durable Host state;
- malformed/unavailable snapshots use `100%`;
- missing `document` is safe;
- absent and empty pre-existing inline CSS values are restored exactly;
- dispose/reactivate leaves one listener.

- [ ] **Step 2: Run and observe RED**

```sh
pnpm openloop:gate-test -- vitest --files \
  packages/openloop/chat-zoom/tests/client-plugin.client.spec.ts
```

- [ ] **Step 3: Implement the browser lifecycle**

Declare:

```ts
export const inject = ['connection', 'remote', 'settingsScope']
```

Call `ctx.settingsScope.bind(...)` once; the binder starts the load and owns
transport disposal. Immediately adopt `scope.getSnapshot()`, then register the
feature's snapshot subscription, exact document listener, and prior-value CSS
restoration with `ctx.effect(...)`. Convert percent to a unitless multiplier.

- [ ] **Step 4: Re-run and observe GREEN**

- [ ] **Step 5: Commit**

```sh
git add packages/openloop/chat-zoom/src/client/index.ts \
  packages/openloop/chat-zoom/tests/client-plugin.client.spec.ts
git commit -m "feat: handle persistent chat zoom shortcuts"
```

### Task 6: Add Transcript-Local Typography Scaling

**Files:**
- Modify: `packages/client/ui-conversation/src/client/chat/ChatView.module.css`
- Modify: `packages/client/ui-conversation/src/client/chat/AssistantMarkdown.module.css`
- Modify: `packages/client/ui-conversation/src/client/chat/MessageItem.module.css`
- Modify: `packages/client/ui-conversation/src/client/chat/ReasoningRow.module.css`
- Modify: `packages/client/ui-primitives/src/markdown/MarkdownText.module.css`
- Modify: `packages/client/ui-primitives/src/markdown/CodeBlock.module.css`
- Create: `packages/openloop/chat-zoom/tests/transcript-styles.spec.ts`

- [ ] **Step 1: Write the failing static CSS contract test**

Assert `.column` maps the Openloop variable to `--dsh-chat-text-scale`; every
specified transcript text class scales size and line height after any `font:`
shorthand; shared Markdown uses only the local variable with fallback `1`;
code `<pre>` scales while banner controls do not; action styles have no scale.

For reasoning, require transcript-local overrides:

```css
.row {
  height: auto;
  min-height: 24px;
}
```

and scaled `.title`, `.summary`, and `.thinkBody`, leaving shared
`DisclosureRow.module.css` unchanged.

- [ ] **Step 2: Run and observe RED**

```sh
pnpm openloop:gate-test -- vitest --files \
  packages/openloop/chat-zoom/tests/transcript-styles.spec.ts
```

- [ ] **Step 3: Implement minimal CSS changes**

Use `calc(<base> * var(--dsh-chat-text-scale, 1))`. Replace clipping fixed
heights only on transcript-local rows. Do not use `zoom`, `transform`, global
descendant scaling, or alter icon/control dimensions.

- [ ] **Step 4: Run focused tests and the acceptance test**

```sh
pnpm openloop:gate-test -- vitest --files \
  packages/openloop/chat-zoom/tests/transcript-styles.spec.ts \
  packages/client/ui-conversation/tests/chat-view.client.spec.tsx \
  packages/client/ui-primitives/tests/markdown.client.spec.tsx
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/openloop-chat-zoom.e2e.ts
```

Expected: PASS. At `160%`, reasoning/compaction rows must have client height
at least their computed line height with no clipped line box.

- [ ] **Step 5: Commit**

```sh
git add packages/client/ui-conversation/src/client/chat \
  packages/client/ui-primitives/src/markdown \
  packages/openloop/chat-zoom/tests/transcript-styles.spec.ts
git commit -m "feat: scale conversation transcript typography"
```

### Task 7: Full Verification

**Files:**
- Modify only files required by failures caused by this feature.

- [ ] **Step 1: Run exact focused Openloop tests**

```sh
pnpm openloop:gate-test -- vitest --files \
  packages/openloop/chat-zoom/tests/package-contract.spec.ts \
  packages/openloop/chat-zoom/tests/zoom.spec.ts \
  packages/openloop/chat-zoom/tests/settings.spec.ts \
  packages/openloop/chat-zoom/tests/client-plugin.client.spec.ts \
  packages/openloop/chat-zoom/tests/transcript-styles.spec.ts
pnpm openloop:gate-test -- scan-repo
```

- [ ] **Step 2: Run the complete repository matrix from `AGENTS.md`**

```sh
pnpm install --frozen-lockfile
pnpm run verify:repository-layout
pnpm run verify:brand-tokens
pnpm run knip
pnpm run typecheck
pnpm run lint
pnpm run verify-client-catalog
pnpm run verify-cordis-inspect-catalog
pnpm run verify-session-event-types
pnpm run verify-third-party-notices
pnpm run verify-translation-pairing
pnpm run build
pnpm run test
uv run --python 3.10 --group test --project python/sdk pytest
pnpm --dir native/landlock-run test
pnpm run verify-runtime-closure
pnpm run verify-dsh-package-licenses
```

- [ ] **Step 3: Re-run browser acceptance**

```sh
pnpm exec vitest run --config vitest.web.config.ts \
  apps/web/tests/openloop-chat-zoom.e2e.ts
```

- [ ] **Step 4: Inspect the final diff**

```sh
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Confirm no generated binaries, installers, build outputs, credentials,
unrelated formatting, or security-module changes.

