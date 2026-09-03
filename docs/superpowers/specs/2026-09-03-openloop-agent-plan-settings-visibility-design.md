# Openloop Agent Plan Settings Visibility Design

## Problem

Openloop 0.1.3-test.13 ships the `volcengine-agent-plan` provider in the
Openloop bundle, but the authenticated Settings facade omits it. The facade
currently treats `LlmConfigurableProvider.declared === true` as user-defined.
For pi-ai, `declared` only means the provider is absent from pi-ai's native
catalog. It does not identify which settings layer supplied the provider.

As a result, the Openloop-shipped Agent Plan route is excluded from both the
provider directory and the projected `llm-pi-ai` settings value.

## Decision

Determine product-built-in providers from settings provenance:

- Keep pi-ai catalog providers (`declared !== true`) trusted as before.
- Also trust a configurable provider when its exact settings path exists in
  the corresponding namespace's `base` layer.
- Do not trust a `declared === true` route that exists only in the user layer.

This preserves the fixed Host-controlled settings boundary without hardcoding
`volcengine-agent-plan` or exposing arbitrary user-defined routes.

## Data Flow

1. The Settings Host reads redacted namespace descriptors once.
2. It combines pi-ai catalog membership with base-layer path presence to build
   the product-built-in provider set.
3. The same set drives provider listing, settings projection, and mutation
   policy.
4. The client receives Agent Plan as a built-in configured provider and renders
   it in the main Models list.

## Error And Security Behavior

- Missing namespace or base data does not promote a declared route.
- User-only custom routes remain excluded from the authenticated facade.
- Existing field restrictions continue to hide endpoint and credential
  metadata.
- Credential references remain exposed only when the Host consumer registry
  confirms ownership by the matching model route.

## Tests

- A declared provider present in the base layer is returned as built-in and its
  allowed model fields survive projection.
- A declared provider present only in the user/value layer remains excluded.
- Existing catalog-provider, credential-reference, and denied-field tests stay
  green.

## Scope

Modify only:

- `packages/openloop/bundle/src/settings-host.ts`
- `packages/openloop/bundle/tests/settings-host.spec.ts`

No security-module, updater, CI, or credential-storage changes.
