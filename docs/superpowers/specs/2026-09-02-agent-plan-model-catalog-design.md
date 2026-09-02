# Agent Plan Model Catalog Design

## Goal

Make Openloop's built-in Volcengine Agent Plan provider expose the official
model catalog, allow switching by exact model ID, and resolve image capability
from the selected model instead of treating `ark-code-latest` as the only
model.

## Current Problem

The built-in route currently uses the Anthropic-compatible endpoint and
declares one model:

```yaml
api: anthropic-messages
baseURL: https://ark.cn-beijing.volces.com/api/plan
models:
  - id: ark-code-latest
```

This combines three different concepts:

- the Agent Plan provider route;
- the `ark-code-latest` console-managed alias;
- the capabilities of whichever model the alias currently targets.

The selector can already switch models, but it can only display models exposed
by the adapter catalog. A one-row provider configuration therefore makes
switching impossible.

Volcengine documents Agent Plan's OpenAI Responses endpoint as
`https://ark.cn-beijing.volces.com/api/plan/v3` and publishes the supported
model names and per-model context, output, and input-modality metadata. The
endpoint does not implement `GET /models`: authenticated probes to both
`/api/plan/models`, `/api/plan/v1/models`, and `/api/plan/v3/models` return
HTTP 404. The official model table is therefore the available source of truth.

Reference:
<https://docs.volcengine.com/docs/82379/2373741?lang=zh>

## Scope

This change updates the existing `volcengine-agent-plan` route only.

It does not:

- add a Coding Plan provider or credential;
- call ArkCLI Helper;
- introduce a remotely hosted Openloop model manifest;
- infer capabilities from display-name substrings;
- change credential storage, update security, or CI policy.

Coding Plan can reuse the same catalog shape later as a separate provider with
its own endpoint and credential.

## Provider Configuration

The built-in route becomes:

```yaml
volcengine-agent-plan:
  displayName: 火山方舟 Agent Plan
  apiKeyEnv: VOLCENGINE_ARK_AGENT_PLAN_API_KEY
  credentialMode: bearer
  api: openai-responses
  baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
  models: [...]
```

Requests continue to use the existing Agent Plan credential. The selected
model ID is sent unchanged in the Responses API request.

## Official Catalog Snapshot

The Openloop bundle records the official catalog in provider order:

| Model ID | Context | Max output | Input |
| --- | ---: | ---: | --- |
| `ark-code-latest` | 256,000 | 32,000 | text, image |
| `doubao-seed-2.1-turbo` | 256,000 | 65,536 | text, image |
| `doubao-seed-evolving` | 1,024,000 | 65,536 | text, image |
| `glm-5.3` | 1,024,000 | 65,536 | text |
| `glm-5.3-flash` | 1,024,000 | 65,536 | text, image |
| `glm-latest` | 1,024,000 | 65,536 | text |
| `deepseek-v4-flash` | 1,024,000 | 65,536 | text |
| `deepseek-v4-pro` | 1,024,000 | 65,536 | text |
| `doubao-seed-2.0-lite` | 256,000 | 65,536 | text, image |
| `doubao-seed-2.0-mini` | 256,000 | 65,536 | text, image |
| `minimax-m3` | 1,024,000 | 65,536 | text, image |
| `kimi-k2.7-code` | 256,000 | 32,000 | text, image |
| `kimi-k3` | 1,024,000 | 65,536 | text, image |

`ark-code-latest` remains selectable as the console-managed alias. Exact model
IDs provide immediate switching without waiting for a console change.

The catalog is a release-time snapshot. Updating it requires an Openloop
release and a regression-test update, making capability changes reviewable.

## Model Discovery

The existing `llm.discoverModels` contract distinguishes two cases.

### Registered route

When `provider` names a route currently owned by `llm-pi-ai`, discovery returns
that adapter's effective model catalog without a network request. For every
model it returns:

- model ID;
- display name;
- context window;
- configured maximum output;
- input modalities.

This makes the Models settings page's "Fetch available models" action work for
Agent Plan even though the provider has no `/models` endpoint.

### Draft route

When the provider is not registered, discovery keeps the existing behavior:

- OpenAI-compatible protocols query `{baseURL}/models`;
- unsupported protocols fail with `DISCOVERY_UNSUPPORTED`;
- manual entry remains available.

No fallback converts a 404 into the official Agent Plan catalog because an
arbitrary custom route must not inherit vendor-specific models.

## Capability Preservation

`LlmDiscoveredModel` and its RPC wire view gain optional
`inputModalities`.

When the settings UI adopts a discovered model, it maps:

```text
inputModalities -> model profile input
```

Without this mapping, adopting a discovered multimodal model would create a
row with no `input`, causing the adapter to fall back to text-only behavior.

Unknown or absent capability metadata remains absent. The system does not
guess image support from a model name.

## Switching Flow

No new selector is required.

The existing flow already:

1. reads `ctx.llm.listModels(provider)`;
2. groups models under the provider;
3. sends the selected stable model ID through `session.selectModel`;
4. persists the selected provider and model as the default;
5. resolves exact-model capabilities before image admission.

Expanding the provider catalog automatically exposes all Agent Plan models in
the existing composer selector and `/model` surface.

Existing sessions and defaults using `ark-code-latest` remain valid.

## Error Handling

- A malformed built-in model entry fails profile composition.
- Duplicate model IDs fail configuration validation.
- A registered-route discovery failure is returned as a provider-local error.
- A draft endpoint 401 or 403 continues to identify the credential.
- A draft endpoint 404 remains a discovery failure rather than silently
  returning an unrelated vendor catalog.
- Selecting a text-only model while a session contains images remains blocked
  by the existing exact-model admission check.

## Tests

### Openloop bundle

- Assert the OpenAI Responses endpoint and protocol.
- Assert the complete ordered model catalog.
- Assert representative multimodal and text-only capabilities.

### pi-ai discovery

- A configured hand-declared route returns its effective local catalog.
- Registered-route discovery performs no network request.
- Context, output, and input modalities survive discovery.
- Unknown draft routes retain the current `/models` behavior.

### RPC contract

- `inputModalities` survives schema validation and client transport.
- Invalid modality values are rejected.

### Settings UI

- Adopting a multimodal candidate writes `input: [text, image]`.
- Adopting a text-only candidate writes `input: [text]`.
- Existing tuned rows still win over a discovered row with the same ID.

### Request routing

- Agent Plan dispatch uses `/api/plan/v3/responses`.
- Bearer credentials remain in `Authorization`.
- The selected exact model ID is sent unchanged.

### Desktop acceptance

- The model menu lists the official Agent Plan models.
- Selecting `glm-5.3-flash` allows image attachment.
- Selecting `glm-5.3` blocks image attachment before dispatch.
- Restart preserves the selected model.
