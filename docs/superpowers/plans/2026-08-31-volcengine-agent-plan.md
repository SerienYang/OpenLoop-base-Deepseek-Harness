# Volcengine Ark Agent Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in Openloop provider profile for Volcengine Ark Agent Plan with Bearer-token authentication and the `ark-code-latest` model.

**Architecture:** Extend the generic `llm-pi-ai` profile with a compatibility-preserving credential transport switch, then declare the product-specific route in the Openloop bundle patch. Existing settings and Keychain services remain the only owners of configuration and secret storage.

**Tech Stack:** TypeScript, Vitest, Cordis YAML composition, `@earendil-works/pi-ai`, Tauri, GitHub Actions.

---

### Task 1: Add Bearer Credential Transport

**Files:**
- Modify: `packages/llm/llm-pi-ai/src/config.ts`
- Modify: `packages/llm/llm-pi-ai/src/adapter.ts`
- Test: `packages/llm/llm-pi-ai/tests/adapter.spec.ts`
- Test: `packages/llm/llm-pi-ai/tests/config.spec.ts`

- [ ] **Step 1: Write the failing request test**

Add a mock-server test that mounts a hand-declared
`volcengine-agent-plan` route with:

```ts
{
  apiKeyEnv: 'PI_TEST_KEY',
  credentialMode: 'bearer',
  api: 'anthropic-messages',
  baseURL: `${server.url}/api/plan`,
  models: [{ id: 'ark-code-latest' }],
}
```

Send one request against a mock `401` response and assert:

```ts
expect(server.paths).toEqual(['/api/plan/v1/messages'])
expect(server.headers[0]?.authorization).toBe('Bearer test-key')
expect(server.headers[0]?.['x-api-key']).toBeUndefined()
```

- [ ] **Step 2: Write failing configuration tests**

Verify:

```ts
expect(resolveProfiles({
  ark: {
    apiKeyEnv: 'ARK_KEY',
    credentialMode: 'bearer',
    api: 'anthropic-messages',
    baseURL: 'https://ark.example/api/plan',
    models: [{ id: 'ark-code-latest' }],
  },
}).get('ark')?.credentialMode).toBe('bearer')
```

Also verify `credentialMode: bearer` without `apiKeyEnv` is rejected, and an
omitted mode resolves to `api-key`.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest run \
  packages/llm/llm-pi-ai/tests/adapter.spec.ts \
  packages/llm/llm-pi-ai/tests/config.spec.ts
```

Expected: FAIL because `credentialMode` is not part of the profile and the
request uses `x-api-key`.

- [ ] **Step 4: Implement the minimal profile field**

In `config.ts`:

- Add `PiAiCredentialMode = 'api-key' | 'bearer'`.
- Add optional `credentialMode` to `PiAiProviderProfile`.
- Add it to the schema.
- Resolve omission to `api-key`.
- Reject `bearer` when no `apiKeyEnv` is configured.
- Expose the resolved mode as a required field.

- [ ] **Step 5: Implement request authentication**

In `adapter.ts`:

- Pass `apiKey` to pi-ai only for `api-key` mode.
- For `bearer`, merge `Authorization: Bearer <resolved key>` into request
  headers.
- Remove case-insensitive configured `Authorization` collisions before adding
  the resolved credential.
- Preserve the existing attribution-header precedence.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run the Step 3 command.

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  packages/llm/llm-pi-ai/src/config.ts \
  packages/llm/llm-pi-ai/src/adapter.ts \
  packages/llm/llm-pi-ai/tests/adapter.spec.ts \
  packages/llm/llm-pi-ai/tests/config.spec.ts
git commit -m "feat(llm): support bearer provider credentials"
```

### Task 2: Add the Openloop Agent Plan Preset

**Files:**
- Modify: `packages/openloop/bundle/cordis.patch.yml`
- Test: `packages/openloop/bundle/tests/profile.spec.ts`

- [ ] **Step 1: Write the failing composition test**

Compose `OPENLOOP_PROFILE_BUNDLES`, find the `llm-pi-ai` row, and assert:

```ts
expect(llmPiAi?.config).toEqual({
  providers: {
    'volcengine-agent-plan': {
      displayName: '火山方舟 Agent Plan',
      apiKeyEnv: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
      credentialMode: 'bearer',
      api: 'anthropic-messages',
      baseURL: 'https://ark.cn-beijing.volces.com/api/plan',
      models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
    },
  },
})
```

- [ ] **Step 2: Run the bundle test and verify RED**

Run:

```bash
pnpm openloop:gate-test -- vitest --files packages/openloop/bundle/tests/profile.spec.ts
```

Expected: FAIL because the Openloop patch does not configure `llm-pi-ai`.

- [ ] **Step 3: Add the profile to the Openloop patch**

Add an ID-targeted patch entry for `llm-pi-ai` with the exact profile from
Step 1. Do not modify the base DSH bundle.

- [ ] **Step 4: Run focused provider and bundle tests**

Run:

```bash
pnpm openloop:gate-test -- vitest --files \
  packages/openloop/bundle/tests/profile.spec.ts \
  packages/llm/llm-pi-ai/tests/adapter.spec.ts \
  packages/llm/llm-pi-ai/tests/config.spec.ts \
  packages/client/ui-settings-models/tests/provider-form.client.spec.tsx
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add \
  packages/openloop/bundle/cordis.patch.yml \
  packages/openloop/bundle/tests/profile.spec.ts
git commit -m "feat(openloop): add Volcengine Agent Plan provider"
```

### Task 3: Document the New Configuration

**Files:**
- Modify: `packages/llm/llm-pi-ai/README.md`
- Modify: `packages/llm/llm-pi-ai/README.zh.md`
- Modify: `packages/llm/llm-pi-ai/README.i18n.yaml`
- Modify: `packages/openloop/bundle/README.md`
- Modify: `packages/openloop/bundle/README.zh.md`
- Modify: `packages/openloop/bundle/README.i18n.yaml`

- [ ] **Step 1: Document `credentialMode`**

Explain `api-key` as the default and `bearer` as the mode for
Anthropic-compatible endpoints that use `Authorization`.

- [ ] **Step 2: Document the Openloop preset**

Record the provider ID, endpoint, credential reference, and default model.
State that Agent Plan keys are distinct from ordinary Ark and Coding Plan keys.

- [ ] **Step 3: Verify paired documentation**

Regenerate both pairing records, then verify all pairs:

```bash
pnpm run verify-translation-pairing --write packages/llm/llm-pi-ai/README.md
pnpm run verify-translation-pairing --write packages/openloop/bundle/README.md
pnpm verify-translation-pairing
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add \
  packages/llm/llm-pi-ai/README.md \
  packages/llm/llm-pi-ai/README.zh.md \
  packages/llm/llm-pi-ai/README.i18n.yaml \
  packages/openloop/bundle/README.md \
  packages/openloop/bundle/README.zh.md \
  packages/openloop/bundle/README.i18n.yaml
git commit -m "docs: describe Volcengine Agent Plan setup"
```

### Task 4: Verify and Deliver

**Files:**
- Verify only; release metadata is supplied to the existing workflow.

- [ ] **Step 1: Run full local verification**

Run:

```bash
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

Expected: every command exits `0`.

- [ ] **Step 2: Review the final diff**

Verify no security module, credential bridge protocol, or CI workflow changed.

- [ ] **Step 3: Push and open the PR**

Push `feat/volcengine-agent-plan` and open a PR targeting `main`. Do not merge
it from the agent session.

- [ ] **Step 4: Wait for human merge**

The protected `main` branch and project policy require human approval. Confirm
the merged commit exists on `origin/main` before publishing.

- [ ] **Step 5: Publish the next test release**

Determine the next unused version and alternating A/B tag from GitHub Releases,
then dispatch:

```bash
gh workflow run openloop-spike-release.yml \
  --ref main \
  -f release_tag=<next-test-tag> \
  -f app_version=<next-test-version> \
  -f release_notes='Add Volcengine Ark Agent Plan provider support.' \
  -f update_rolling_manifest=true
```

Wait for completion and verify the Release contains the DMG, updater archive,
signature, core manifest, artifact manifest, and runtime SBOM inputs.

- [ ] **Step 6: Update the local app**

Download the published DMG, verify it came from the expected immutable GitHub
Release, mount it, replace `/Applications/Openloop.app`, unmount it, and verify:

```bash
defaults read /Applications/Openloop.app/Contents/Info CFBundleShortVersionString
codesign -dv --verbose=2 /Applications/Openloop.app
```

Expected: the installed version equals the new release version and the app
remains the expected Apple Silicon test-channel bundle.
