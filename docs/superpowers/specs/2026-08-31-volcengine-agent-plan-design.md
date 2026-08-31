# Volcengine Ark Agent Plan Provider Design

## Goal

Add one built-in Openloop model-provider profile for Volcengine Ark Agent Plan.
Users should only need to enter their Agent Plan API key before selecting
`ark-code-latest`.

## Scope

- Add only the Agent Plan product, not the ordinary Volcengine Ark API.
- Keep the integration in the Openloop composition layer.
- Reuse the existing `llm-pi-ai` adapter and Models settings UI.
- Keep API keys in the existing credential service and macOS Keychain path.
- Publish the next test-channel macOS release after the change reaches
  protected `main`, then install that release in `/Applications/Openloop.app`.

Out of scope:

- A new provider-specific adapter.
- A new onboarding step.
- Model discovery for the Agent Plan endpoint.
- Changes to security modules, credential protocols, or CI policy.
- Image and video generation models.

## Provider Profile

The Openloop bundle supplies this base profile to the existing `llm-pi-ai`
composition row:

| Field | Value |
| --- | --- |
| Provider ID | `volcengine-agent-plan` |
| Display name | `火山方舟 Agent Plan` |
| Protocol | `anthropic-messages` |
| Base URL | `https://ark.cn-beijing.volces.com/api/plan` |
| Credential reference | `VOLCENGINE_ARK_AGENT_PLAN_API_KEY` |
| Credential mode | `bearer` |
| Default model ID | `ark-code-latest` |
| Default input | text |

The values follow the official Agent Plan quick-start document. The configured
base URL is passed to the Anthropic-compatible client, which owns the final
Messages request path, producing
`https://ark.cn-beijing.volces.com/api/plan/v1/messages`. Agent Plan uses
`ANTHROPIC_AUTH_TOKEN` semantics, so its credential must be sent as
`Authorization: Bearer <token>`, not as Anthropic's ordinary `x-api-key`
header.

## Architecture

The profile belongs in `packages/openloop/bundle/cordis.patch.yml`. This keeps
the product-specific preset outside the shared DSH provider catalog and avoids
patching the `@earendil-works/pi-ai` dependency.

The shared `llm-pi-ai` profile gains an optional `credentialMode` field with
`api-key` as the compatibility-preserving default and `bearer` as the new
choice. In bearer mode, the existing credential resolver returns an
`Authorization` header to pi-ai instead of an `apiKey` value. This is a generic
transport capability rather than Volcengine-specific branching in the shared
adapter.

At runtime:

1. The Openloop profile patch supplies the Agent Plan route to `llm-pi-ai`.
2. `llm-pi-ai` registers the route and exposes it through `llm.providers`.
3. The existing Models page renders the route and writes only its credential
   reference into settings.
4. The credential value is written through `credentials.set` and remains
   behind the existing Keychain boundary.
5. Requests use the existing Anthropic Messages implementation with the
   configured base URL and model. The resolved key is attached as a Bearer
   authorization header.

No new browser-to-host API or secret-bearing payload is introduced.

## User Experience

The Models settings page shows `火山方舟 Agent Plan` as an available configured
provider. Its initial state has the documented endpoint and
`ark-code-latest`; the user enters only the Agent Plan API key. Advanced fields
remain editable through the existing provider editor.

Because the route is product-supplied rather than shipped by the upstream
pi-ai catalog, the current directory contract may label it `Custom`. Removing
that label would require widening the shared provider-directory contract and
is not required for this change.

## Failure Handling

- A missing key keeps the provider visible but requests fail with the existing
  `MISSING_CREDENTIAL` diagnostic.
- An invalid key or unsupported subscription/model is returned through the
  existing provider error path.
- A malformed profile must fail bundle/configuration tests before packaging.
- Existing DeepSeek and pi-ai provider behavior must remain unchanged.

## Tests

Test-first coverage will verify:

1. The Openloop bundle patch contains exactly one Agent Plan profile with the
   documented ID, endpoint, protocol, credential mode, credential reference,
   and model.
2. Profile composition resolves through `llm-pi-ai` and lists
   `ark-code-latest`.
3. A mock Anthropic endpoint receives a request on the expected Messages path
   with `Authorization: Bearer <token>`, without `x-api-key`, and without
   persisting the plaintext key.
4. Existing bundle, `llm-pi-ai`, Models UI, typecheck, and desktop build checks
   continue to pass.

No real Agent Plan key is required in CI.

## Delivery

1. Start from current `origin/main` on a feature branch.
2. Commit the tested provider preset and documentation.
3. Push the branch and create a pull request.
4. Do not self-merge; protected `main` requires human approval.
5. After the PR is merged, dispatch the existing
   `openloop-spike-release.yml` workflow for the next test-channel version.
6. Verify all required Release assets, download the DMG, replace the local
   `/Applications/Openloop.app`, and verify the installed version and signature.
