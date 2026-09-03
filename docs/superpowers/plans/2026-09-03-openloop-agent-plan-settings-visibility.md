# Openloop Agent Plan Settings Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Openloop-shipped Volcengine Agent Plan provider to the Models settings page without exposing user-only custom routes.

**Architecture:** The authenticated Settings Host will classify trusted providers from two independent facts: native pi-ai catalog membership, or an exact `llm-pi-ai.providers.<provider>` path in the settings base layer. The same request-local trusted set will drive provider listing, settings projection, and mutation authorization.

**Tech Stack:** TypeScript, Vitest, Cordis settings descriptors, Openloop authenticated settings facade, GitHub Actions release workflow.

---

### Task 1: Lock The Provenance Contract With Failing Tests

**Files:**
- Modify: `packages/openloop/bundle/tests/settings-host.spec.ts`

- [ ] **Step 1: Add a base-backed declared-provider fixture**

Extend the existing `settings-host` test bench with an `llm-pi-ai` descriptor whose
`base` and `value` contain:

```ts
providers: {
  'volcengine-agent-plan': {
    models: [{ id: 'glm-5.3-flash' }],
    apiKeyEnv: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
    baseURL: 'https://ark.invalid',
  },
}
```

Use a valid serialized Schemastery graph matching the existing projection test:
an object root with a `providers` dict, provider-profile object, `models` array,
and model object containing `id`. This ensures the projection test exercises
provenance rather than failing because an empty schema projects every value to
`{}`.

Declare the route with `declared: true`,
`settingsNs: 'llm-pi-ai'`, and
`settingsPath: ['providers', 'volcengine-agent-plan']`.

- [ ] **Step 2: Assert base-backed declared providers are visible and projected**

Call the authenticated providers and describe routes. Assert:

```ts
expect(providers).toContainEqual(expect.objectContaining({
  provider: 'volcengine-agent-plan',
  displayName: '火山方舟 Agent Plan',
  builtIn: true,
}))
expect(descriptor.value.providers['volcengine-agent-plan'].models)
  .toEqual([{ id: 'glm-5.3-flash' }])
```

Also assert `baseURL` and `apiKeyEnv` remain absent from the response.

- [ ] **Step 3: Assert allowed mutation succeeds for the base-backed route**

Submit a mutation to:

```ts
['providers', 'volcengine-agent-plan', 'models']
```

Assert the request reaches `settings.mutate`.

- [ ] **Step 4: Assert untrusted variants remain denied**

Cover declared providers that are:

- Present only in `value` or `user`, not `base`.
- Registered under another namespace.
- Registered under a non-exact settings path.

Assert they remain absent from provider responses and their mutations are rejected
before `settings.mutate`.

- [ ] **Step 5: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run packages/openloop/bundle/tests/settings-host.spec.ts
```

Expected: the base-backed Agent Plan visibility and mutation assertions fail because
the current code filters every `declared: true` provider.

### Task 2: Implement Request-Local Base Provenance

**Files:**
- Modify: `packages/openloop/bundle/src/settings-host.ts`
- Test: `packages/openloop/bundle/tests/settings-host.spec.ts`

- [ ] **Step 1: Add the exact provenance predicate**

Add a helper that returns true only when:

```ts
provider.settingsNs === 'llm-pi-ai'
provider.settingsPath.length === 2
provider.settingsPath[0] === 'providers'
provider.settingsPath[1] === provider.provider
valueAt(llmPiAiDescriptor?.base, provider.settingsPath) !== undefined
```

- [ ] **Step 2: Build one trusted provider set from catalog or base provenance**

Replace the `declared !== true`-only filter with:

```ts
provider.declared !== true || providerIsInBase(provider, descriptors)
```

Keep the result request-local and reuse it for projection and authorization.
Each handler must derive the trusted list and set from the same descriptor snapshot.

- [ ] **Step 3: Use the trusted provider list in all three Host routes**

Update describe, mutate, and providers handlers so:

- Agent Plan is projected and returned as `builtIn: true`.
- User-only declared routes remain excluded.
- Existing credential-reference ownership checks are unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run \
  packages/openloop/bundle/tests/settings-host.spec.ts \
  packages/openloop/bundle/tests/settings-policy.spec.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the functional fix**

```bash
git add packages/openloop/bundle/src/settings-host.ts \
  packages/openloop/bundle/tests/settings-host.spec.ts
git commit -m "fix(openloop): show bundled Agent Plan provider"
```

### Task 3: Verify The Release Surface

**Files:**
- Delete before final delivery:
  `docs/superpowers/specs/2026-09-03-openloop-agent-plan-settings-visibility-design.md`
- Delete before final delivery:
  `docs/superpowers/plans/2026-09-03-openloop-agent-plan-settings-visibility.md`

- [ ] **Step 1: Run focused Openloop and settings tests**

```bash
pnpm exec vitest run \
  packages/openloop/bundle/tests/settings-host.spec.ts \
  packages/openloop/bundle/tests/settings-policy.spec.ts \
  packages/openloop/bundle/tests/profile.spec.ts \
  packages/client/ui-settings-models/tests/provider-form.client.spec.tsx
```

- [ ] **Step 2: Run typecheck, lint, and repository gates**

```bash
pnpm typecheck
pnpm lint
pnpm openloop:gate-test -- scan-repo
```

- [ ] **Step 3: Remove internal planning artifacts**

Delete the two internal planning files above so the public repository layout gate
continues to pass, then commit the cleanup.

- [ ] **Step 4: Push, create PR, wait for CI, and merge**

Push `fix/openloop-agent-plan-settings-visibility`, create a PR targeting `main`,
wait for all required checks, then squash merge and delete the remote branch.

- [ ] **Step 5: Publish and install 0.1.3-test.14**

Run `openloop-spike-release.yml` from merged `main` with:

```text
release_tag=openloop-test-a-v0.1.3-test.14
app_version=0.1.3-test.14
release_notes=Restore the bundled Volcengine Agent Plan provider in Models settings while preserving the Host settings allowlist.
update_rolling_manifest=true
```

Verify release commit, SHA-256, updater signature, arm64 architecture, bundle code
signature, rolling manifest, and installed version. Back up the existing app before
replacing `/Applications/Openloop.app`.

- [ ] **Step 6: Reproduce the original UI path**

Open Settings -> Models & Credentials and verify `火山方舟 Agent Plan` appears in
the main configured-provider list with its credential state.
