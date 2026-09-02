# Agent Plan Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Openloop expose the official Volcengine Agent Plan model catalog, switch models by exact model ID, and preserve per-model image capabilities through configuration discovery.

**Architecture:** Keep Agent Plan as a normal `llm-pi-ai` route, but move it to Volcengine's OpenAI Responses endpoint and replace its one-row catalog with the official release-time snapshot. Extend provider discovery so a registered custom route answers from its effective adapter catalog without calling `/models`, and carry input modalities through the provider-neutral discovery RPC into settings writes.

**Tech Stack:** TypeScript, React, Vitest, Zod, Cordis configuration YAML, pi-ai OpenAI Responses adapter.

**Design:** `docs/superpowers/specs/2026-09-02-agent-plan-model-catalog-design.md`

---

## File Map

### Provider-neutral discovery contract

- Modify `packages/llm/llm/src/types.ts`
  - Add optional input modalities to `LlmDiscoveredModel`.
- Modify `packages/llm/llm/src/index.ts`
  - Validate and detach discovered modality arrays.
- Modify `packages/llm/llm/tests/service.spec.ts`
  - Pin valid and invalid discovery metadata.
- Modify `packages/host/apiproxy/src/api/llm.ts`
  - Expose modalities in `DiscoveredModelView`.
- Modify `packages/host/apiproxy/src/api/llm.schema.ts`
  - Validate the wire field.
- Modify `packages/host/apiproxy/tests/api-proxy-config.spec.ts`
  - Pin Host forwarding.
- Modify `packages/host/apiproxy/tests/client-handler.spec.ts`
  - Pin transport round-trip.

### Registered-route discovery

- Modify `packages/llm/llm-pi-ai/src/discovery.ts`
  - Accept a configured-catalog resolver and prefer it before endpoint probing.
- Modify `packages/llm/llm-pi-ai/src/index.ts`
  - Project the active adapter catalog into discovery metadata.
- Modify `packages/llm/llm-pi-ai/tests/discovery.spec.ts`
  - Prove configured custom routes perform no network request and retain metadata.

### Settings adoption

- Modify `packages/client/ui-settings-models/src/client/ModelListEditor.tsx`
  - Map discovered modalities to the pi-ai profile's `input` field.
- Modify `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx`
  - Prove multimodal and text-only candidates retain their capability.

### Openloop Agent Plan preset

- Modify `packages/openloop/bundle/cordis.patch.yml`
  - Move to OpenAI Responses and add the official catalog.
- Modify `packages/openloop/bundle/tests/profile.spec.ts`
  - Pin protocol, endpoint, order, capacities, and modalities.
- Modify `packages/openloop/bundle/README.md`
  - Document the Responses route and selectable model IDs.
- Modify `packages/openloop/bundle/README.zh.md`
  - Keep the paired Chinese documentation structurally identical.

---

## Task 1: Preserve Input Modalities Through Model Discovery

**Files:**
- Modify: `packages/llm/llm/src/types.ts`
- Modify: `packages/llm/llm/src/index.ts`
- Modify: `packages/llm/llm/tests/service.spec.ts`
- Modify: `packages/host/apiproxy/src/api/llm.ts`
- Modify: `packages/host/apiproxy/src/api/llm.schema.ts`
- Modify: `packages/host/apiproxy/tests/api-proxy-config.spec.ts`
- Modify: `packages/host/apiproxy/tests/client-handler.spec.ts`

- [ ] **Step 1: Write the failing core discovery test**

Add a `packages/llm/llm/tests/service.spec.ts` case whose registered discovery returns:

```ts
{
  id: 'vision',
  name: 'Vision',
  contextWindow: 256_000,
  maxTokens: 32_000,
  inputModalities: ['text', 'image'],
}
```

Assert `ctx.llm.discoverModels(...)` returns the same detached modality array.
Mutate the source array after the call and assert the returned array does not
change.

Add a parameterized invalid-metadata case for:

```ts
[['audio'], ['text', 'audio'], 'text']
```

The discovery must reject these values as invalid model metadata rather than
letting them reach the RPC schema.

- [ ] **Step 2: Run the core test and verify RED**

Run:

```bash
pnpm vitest run packages/llm/llm/tests/service.spec.ts
```

Expected: the valid case loses `inputModalities`, and invalid modality values
are not rejected.

- [ ] **Step 3: Extend the core contract minimally**

In `packages/llm/llm/src/types.ts`, add:

```ts
/** Accepted request modalities when the discovery source knows them. */
inputModalities?: readonly ModelModality[]
```

to `LlmDiscoveredModel`.

In `LlmRuntime.discoverModels`, validate that a supplied value:

- is an array;
- contains only values in the `ModelModalityMap` vocabulary;
- contains no duplicates.

Reuse the runtime's modality-detachment discipline and return a fresh array.
Do not infer modalities when the field is absent.

- [ ] **Step 4: Run the core test and verify GREEN**

Run:

```bash
pnpm vitest run packages/llm/llm/tests/service.spec.ts
```

Expected: all tests pass.

- [ ] **Step 5: Write failing Host and carrier tests**

Update the discovery candidate in
`packages/host/apiproxy/tests/api-proxy-config.spec.ts` to include:

```ts
inputModalities: ['text', 'image']
```

Assert the Host response retains it.

Update the scripted `llm.discoverModels` response in
`packages/host/apiproxy/tests/client-handler.spec.ts` the same way and assert
the fetched client response retains it.

- [ ] **Step 6: Run the Host tests and verify RED**

Run:

```bash
pnpm vitest run \
  packages/host/apiproxy/tests/api-proxy-config.spec.ts \
  packages/host/apiproxy/tests/client-handler.spec.ts
```

Expected: `llmDiscoverModelsValueSchema` strips or rejects the new field.

- [ ] **Step 7: Extend the RPC view and schema**

In `DiscoveredModelView`, add:

```ts
/** Accepted request modalities when disclosed by the source catalog. */
inputModalities?: Array<'text' | 'image'>
```

Prefer importing the provider-neutral `ModelModality` type if that does not
cross a package ownership boundary.

In `discoveredModelViewSchema`, add an optional array whose values are exactly
`text` or `image`. Keep it optional; unknown capability must remain unknown.

- [ ] **Step 8: Run the Host tests and verify GREEN**

Run:

```bash
pnpm vitest run \
  packages/host/apiproxy/tests/api-proxy-config.spec.ts \
  packages/host/apiproxy/tests/client-handler.spec.ts
```

Expected: all tests pass.

- [ ] **Step 9: Commit Task 1**

```bash
git add \
  packages/llm/llm/src/types.ts \
  packages/llm/llm/src/index.ts \
  packages/llm/llm/tests/service.spec.ts \
  packages/host/apiproxy/src/api/llm.ts \
  packages/host/apiproxy/src/api/llm.schema.ts \
  packages/host/apiproxy/tests/api-proxy-config.spec.ts \
  packages/host/apiproxy/tests/client-handler.spec.ts
git commit -m "feat(llm): preserve discovered model modalities"
```

---

## Task 2: Discover Registered pi-ai Routes From Their Local Catalog

**Files:**
- Modify: `packages/llm/llm-pi-ai/src/discovery.ts`
- Modify: `packages/llm/llm-pi-ai/src/index.ts`
- Modify: `packages/llm/llm-pi-ai/tests/discovery.spec.ts`

- [ ] **Step 1: Write the failing registered-route test**

Mount `llm-pi-ai` with a provider that pi-ai does not ship:

```ts
{
  providers: {
    'volcengine-agent-plan': {
      apiKeyEnv: 'AGENT_PLAN_KEY',
      credentialMode: 'bearer',
      api: 'openai-responses',
      baseURL: 'https://unreachable.invalid/api/plan/v3',
      models: [{
        id: 'glm-5.3-flash',
        name: 'glm-5.3-flash',
        contextWindow: 1_024_000,
        maxTokens: 65_536,
        input: ['text', 'image'],
      }],
    },
  },
}
```

Call:

```ts
ctx.llm.discoverModels('llm-pi-ai', {
  provider: 'volcengine-agent-plan',
  baseURL: 'https://unreachable.invalid/api/plan/v3',
  api: 'openai-responses',
})
```

Assert the result is:

```ts
[{
  id: 'glm-5.3-flash',
  name: 'glm-5.3-flash',
  contextWindow: 1_024_000,
  maxTokens: 65_536,
  inputModalities: ['text', 'image'],
}]
```

Stub `fetch` to throw if called. The test must prove this path is local.

- [ ] **Step 2: Run the discovery test and verify RED**

Run:

```bash
pnpm vitest run packages/llm/llm-pi-ai/tests/discovery.spec.ts
```

Expected: the current implementation calls
`https://unreachable.invalid/api/plan/v3/models`.

- [ ] **Step 3: Add a configured-catalog resolver**

Change `discoverModels` to accept an optional callback:

```ts
type ConfiguredCatalog = (
  provider: string,
) => Promise<readonly LlmDiscoveredModel[] | undefined>
```

Resolution order:

1. installed pi-ai catalog;
2. configured route catalog;
3. endpoint probe.

`undefined` means the route is not configured. An empty array means the route
is configured and intentionally advertises no models; do not fall through to
the network.

In `packages/llm/llm-pi-ai/src/index.ts`, implement the callback using the
already-created `PiAiAdapter`:

```ts
const listConfigured = async (provider: string) => {
  if (!profiles().has(provider)) return undefined
  const models = await adapter.listModels(provider)
  return Promise.all(models.map(async (model) => {
    const resolved = await adapter.resolveModel(provider, model.id)
    return {
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      contextWindow: resolved.context?.contextWindow,
      maxTokens: resolved.defaultMaxTokens,
    }
  }))
}
```

Build each object conditionally so `undefined` optional fields are omitted.
Pass this callback into the discovery registration. Do not resolve a credential
on the local path.

- [ ] **Step 4: Add edge-case tests**

Cover:

- a configured empty catalog returns `[]` without network access;
- an unknown route still uses OpenAI-compatible `/models`;
- a configured route performs no credential lookup;
- installed pi-ai providers retain their installed-catalog precedence.

- [ ] **Step 5: Run discovery tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/llm/llm-pi-ai/tests/discovery.spec.ts
```

Expected: all tests pass with no network request for configured routes.

- [ ] **Step 6: Commit Task 2**

```bash
git add \
  packages/llm/llm-pi-ai/src/discovery.ts \
  packages/llm/llm-pi-ai/src/index.ts \
  packages/llm/llm-pi-ai/tests/discovery.spec.ts
git commit -m "feat(llm): discover configured pi-ai catalogs locally"
```

---

## Task 3: Preserve Capabilities When Settings Adopt Models

**Files:**
- Modify: `packages/client/ui-settings-models/src/client/ModelListEditor.tsx`
- Modify: `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx`

- [ ] **Step 1: Write the failing settings test**

Extend the existing "adopts only the picked candidates" test with:

```ts
models: [
  {
    id: 'vision',
    name: 'Vision',
    inputModalities: ['text', 'image'],
  },
  {
    id: 'text-only',
    inputModalities: ['text'],
  },
]
```

After adopting and applying, assert the settings mutation stores:

```ts
[
  { id: 'vision', name: 'Vision', input: ['text', 'image'] },
  { id: 'text-only', input: ['text'] },
]
```

Add a candidate with no modality field and assert it stores no `input`.

Retain the existing assertion that a configured row with the same model ID
wins over the discovered candidate.

- [ ] **Step 2: Run the settings test and verify RED**

Run:

```bash
pnpm vitest run packages/client/ui-settings-models/tests/provider-form.client.spec.tsx
```

Expected: adopted rows omit `input`.

- [ ] **Step 3: Map discovery metadata into profile metadata**

Extend `adopt(candidate)`:

```ts
...candidate.inputModalities === undefined
  ? {}
  : { input: [...candidate.inputModalities] }
```

The copy must be detached from the RPC response. Do not infer missing
modalities and do not overwrite an existing row.

- [ ] **Step 4: Run the settings test and verify GREEN**

Run:

```bash
pnpm vitest run packages/client/ui-settings-models/tests/provider-form.client.spec.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add \
  packages/client/ui-settings-models/src/client/ModelListEditor.tsx \
  packages/client/ui-settings-models/tests/provider-form.client.spec.tsx
git commit -m "fix(settings): retain discovered model capabilities"
```

---

## Task 4: Replace the Agent Plan Alias-Only Preset With the Official Catalog

**Files:**
- Modify: `packages/openloop/bundle/cordis.patch.yml`
- Modify: `packages/openloop/bundle/tests/profile.spec.ts`
- Modify: `packages/openloop/bundle/README.md`
- Modify: `packages/openloop/bundle/README.zh.md`

- [ ] **Step 1: Rewrite the failing profile expectation first**

Change the expected provider to:

```ts
{
  displayName: '火山方舟 Agent Plan',
  apiKeyEnv: 'VOLCENGINE_ARK_AGENT_PLAN_API_KEY',
  credentialMode: 'bearer',
  api: 'openai-responses',
  baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  models: OFFICIAL_AGENT_PLAN_MODELS,
}
```

Define `OFFICIAL_AGENT_PLAN_MODELS` in the test file as the complete ordered
array below. Keep the assertion exact; this is the release-time drift gate.

- [ ] **Step 2: Run the profile test and verify RED**

Run:

```bash
pnpm vitest run packages/openloop/bundle/tests/profile.spec.ts
```

Expected: protocol, endpoint, and model catalog mismatch.

- [ ] **Step 3: Update the built-in provider**

Replace the provider body in `cordis.patch.yml` with:

```yaml
      volcengine-agent-plan:
        displayName: 火山方舟 Agent Plan
        apiKeyEnv: VOLCENGINE_ARK_AGENT_PLAN_API_KEY
        credentialMode: bearer
        api: openai-responses
        baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
        models:
          - id: ark-code-latest
            name: ark-code-latest
            contextWindow: 256000
            maxTokens: 32000
            input: [text, image]
          - id: doubao-seed-2.1-turbo
            name: doubao-seed-2.1-turbo
            contextWindow: 256000
            maxTokens: 65536
            input: [text, image]
          - id: doubao-seed-evolving
            name: doubao-seed-evolving
            contextWindow: 1024000
            maxTokens: 65536
            input: [text, image]
          - id: glm-5.3
            name: glm-5.3
            contextWindow: 1024000
            maxTokens: 65536
            input: [text]
          - id: glm-5.3-flash
            name: glm-5.3-flash
            contextWindow: 1024000
            maxTokens: 65536
            input: [text, image]
          - id: glm-latest
            name: glm-latest
            contextWindow: 1024000
            maxTokens: 65536
            input: [text]
          - id: deepseek-v4-flash
            name: deepseek-v4-flash
            contextWindow: 1024000
            maxTokens: 65536
            input: [text]
          - id: deepseek-v4-pro
            name: deepseek-v4-pro
            contextWindow: 1024000
            maxTokens: 65536
            input: [text]
          - id: doubao-seed-2.0-lite
            name: doubao-seed-2.0-lite
            contextWindow: 256000
            maxTokens: 65536
            input: [text, image]
          - id: doubao-seed-2.0-mini
            name: doubao-seed-2.0-mini
            contextWindow: 256000
            maxTokens: 65536
            input: [text, image]
          - id: minimax-m3
            name: minimax-m3
            contextWindow: 1024000
            maxTokens: 65536
            input: [text, image]
          - id: kimi-k2.7-code
            name: kimi-k2.7-code
            contextWindow: 256000
            maxTokens: 32000
            input: [text, image]
          - id: kimi-k3
            name: kimi-k3
            contextWindow: 1024000
            maxTokens: 65536
            input: [text, image]
```

- [ ] **Step 4: Update paired documentation**

Document:

- the Responses endpoint;
- the unchanged credential reference;
- that model selection uses exact model IDs;
- that `ark-code-latest` remains the console-managed alias;
- the official documentation URL and snapshot date;
- that Coding Plan keys remain distinct and are not configured here.

Keep English and Chinese heading/list/table structures paired so
`verify-translation-pairing` remains green.

- [ ] **Step 5: Run profile and documentation checks**

Run:

```bash
pnpm vitest run packages/openloop/bundle/tests/profile.spec.ts
pnpm verify-translation-pairing
```

Expected: all checks pass.

- [ ] **Step 6: Add a focused request-routing regression**

In `packages/llm/llm-pi-ai/tests/adapter.spec.ts`, add or adapt the Agent Plan
case to use:

```ts
api: 'openai-responses'
baseURL: `${server.url}/api/plan/v3`
model: 'glm-5.3-flash'
```

Assert:

- path is `/api/plan/v3/responses`;
- `Authorization` is `Bearer test-key`;
- no `x-api-key` or `api-key` header is sent;
- the JSON request body contains `"model":"glm-5.3-flash"`.

- [ ] **Step 7: Run adapter tests**

Run:

```bash
pnpm vitest run packages/llm/llm-pi-ai/tests/adapter.spec.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add \
  packages/openloop/bundle/cordis.patch.yml \
  packages/openloop/bundle/tests/profile.spec.ts \
  packages/openloop/bundle/README.md \
  packages/openloop/bundle/README.zh.md \
  packages/llm/llm-pi-ai/tests/adapter.spec.ts
git commit -m "feat(openloop): add Agent Plan model catalog"
```

---

## Task 5: Integration Verification

**Files:**
- No production changes expected.
- Update tests only if a verification command reveals a directly related gap.

- [ ] **Step 1: Run focused suites together**

```bash
pnpm vitest run \
  packages/llm/llm/tests/service.spec.ts \
  packages/llm/llm-pi-ai/tests/discovery.spec.ts \
  packages/llm/llm-pi-ai/tests/adapter.spec.ts \
  packages/host/apiproxy/tests/api-proxy-config.spec.ts \
  packages/host/apiproxy/tests/client-handler.spec.ts \
  packages/client/ui-settings-models/tests/provider-form.client.spec.tsx \
  packages/openloop/bundle/tests/profile.spec.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 3: Run the full test suite**

```bash
pnpm test
```

Expected: all tests pass. If the known file-watcher timing test fails once,
rerun that test in isolation and record both results; do not classify a new
failure as flaky without a clean isolated rerun.

- [ ] **Step 4: Run Openloop gates**

```bash
pnpm openloop:gate-test
```

Expected: all Openloop release gates pass.

- [ ] **Step 5: Inspect the final diff**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Confirm:

- no security module or CI workflow changed;
- no credential value appears;
- only the approved provider, discovery, RPC, UI, tests, and docs changed.

- [ ] **Step 6: Desktop acceptance after release build**

On the macOS test build:

1. Open the model selector.
2. Confirm all 13 Agent Plan model IDs are listed.
3. Select `glm-5.3-flash`.
4. Attach an image and confirm no local capability rejection appears.
5. Select `glm-5.3` in a text-only session and confirm image attachment is
   rejected before dispatch.
6. Restart Openloop and confirm the selected model persists.

- [ ] **Step 7: Final review and ship handoff**

Run the repository's pre-landing review workflow. Do not merge or publish
without the user's explicit release instruction.
