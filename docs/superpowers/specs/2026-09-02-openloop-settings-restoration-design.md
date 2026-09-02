# Openloop Settings Restoration Design

## Problem

The `0.1.3-test.11` shell replaced working settings contributors with three
deliberate unavailable placeholders and exposed filesystem authorization as a
top-level Settings section named Workspace. This removed normal product
configuration and confused two separate concepts:

- Workspace: a project folder and its Host authorization.
- Workbench: the right-side surface for web pages, files, code, and artifacts.

The installed App has been rolled back to `0.1.3-test.10` while this correction
is prepared.

## Scope

This correction restores Settings only. It does not implement or redesign
Workbench.

The Settings navigation must contain exactly:

1. General
2. Models & Credentials
3. Plugins
4. About & Updates

The Workspace Settings section is removed. The left sidebar Workspace list,
session-to-Workspace association, native folder authorization, file broker,
and sandbox enforcement remain unchanged.

## Design

### Shell composition

`@openloop/shell` remains the Settings shell owner so Openloop retains its
branding, About & Updates section, and Keychain credential control.

The shell stops registering unavailable placeholder sections. It accepts the
real section registrations from:

- `@deepseek-ai/dsh-client-ui-settings-general`
- `@deepseek-ai/dsh-client-ui-settings-models`
- `@deepseek-ai/dsh-client-ui-settings-plugins`
- `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` where required by the
  Plugins section

`@openloop/workspace-client` stops registering `settings.section/workspace`.
Its sidebar, session guard, grant status, authorization, reauthorization,
rename, reveal, and revoke behavior remain mounted.

### Configuration boundary

The unrestricted legacy browser settings API remains denied.

Openloop exposes a main-WebView-only settings facade over the authenticated
Desktop Bridge. The public browser transport continues denying every legacy
`settings.*` method. The facade accepts only reviewed namespaces and path
operations needed by the restored UI. Unknown namespaces, unknown fields,
whole-document replacement, file opening, absolute paths, and credential
values are rejected.

The first release supports this exact matrix:

| Namespace | Readable and mutable paths | Rules |
|---|---|---|
| `locale` | `preference` | `zh` or `en` |
| `ui-theme` | `preference` | Existing theme enum only |
| `ui-conversation` | `busyEnter` | `queue` or `steer` |
| `agent-loop` | `maxParallelToolCalls` | Existing schema and numeric bounds |
| `shell` | `timeoutMs`, `maxOutputBytes` | Existing schema and numeric bounds; shown only when the namespace is mounted |
| `web-search-deepseek` | `maxUses` | `apiKey`, `apiKeyEnv`, and `baseURL` are immutable |
| `llm-deepseek` | `thinking`, `reasoningEffort`, `maxTokens`, `defaultContextWindow`, `streamIdleTimeoutMs`, `retryPolicy`, `models` | `apiKey`, `apiKeyEnv`, and `baseURL` are not writable through this facade |
| `llm-pi-ai` | `providers.<built-in>.displayName`, `providers.<built-in>.models`, `providers.<built-in>.modelOverrides`, `providers.<built-in>.compat`, `providers.<built-in>.defaultContextWindow`, `providers.<built-in>.defaultMaxTokens`, `providers.<built-in>.defaultInput`, `providers.<built-in>.streamIdleTimeoutMs`, `providers.<built-in>.retryPolicy` | The provider key must already exist in the Host catalog; `api`, `credentialMode`, `apiKeyEnv`, and `baseURL` are immutable |
| `ui-onboarding` | `welcomeNoticeVersion` | Exact current acknowledgement version only |

API keys are excluded from the settings facade. Existing model and web-search
components continue using `SettingsShellOwner.credentialControl`, which stores,
describes, replaces, and removes credentials through the macOS Keychain bridge.

The facade contract is:

- `describeSettings({ namespaces })` requires a non-empty deduplicated list
  drawn from the matrix and returns only those filtered descriptors.
- `mutateSettings({ namespace, ops, expectedRevision })` requires a current
  revision, rejects empty paths, validates every path and value against the
  matrix, delegates schema validation to the owning settings registration, and
  returns only the changed filtered descriptor.
- The settings routes reuse the existing 256-bit bootstrap session carried by
  the `HttpOnly; SameSite=Strict` `openloop_bootstrap` cookie. Every request
  extracts that cookie and calls `runtimeBootstrap.validateBootstrapSession`
  before reading or dispatching settings. The session is launch-local,
  constant-time checked, rotated on Host restart, never exposed to JavaScript,
  and rejected by the generic RPC/Typert dispatchers. External Workbench
  WebViews use a separate origin/session and never receive this cookie.
- The bridge rejects credential-shaped keys at any nesting depth and rejects
  writes of credential references. Filtered descriptors may include an
  immutable `apiKeyEnv` only when it exactly matches a Host-registered
  credential consumer. Models uses that projected reference solely to address
  the Keychain credential control.

All endpoint controls are hidden or read-only in this correction. No runtime
provider/endpoint/credential binding contract changes are required.

`SettingsShellOwner` gains an optional product settings adapter containing:

- a `SettingsScope` factory used by Language, Appearance, Composer Enter, and
  configurable plugin cards
- namespace-filtered `describe` and revision-bound `mutate` used by Models
- projected `listProviders`
- an optional `discoverModels` capability

The shared General, Models, and Plugins contributors use this adapter when
present and retain their existing `connection.api` behavior in the default DSH
profile. `@openloop/settings-foundation` binds its `SettingsScope` objects to
this adapter instead of returning `unavailable`. Existing callers that omit
`expectedRevision` are updated: onboarding reads and retains its descriptor
revision before acknowledgement; provider deletion uses the row's loaded
namespace revision. The Openloop adapter never fabricates a revision.

`listProviders` returns only provider id, display name, active state, settings
namespace/path, whether the route is built-in, and its Host-registered
credential reference. It omits endpoints. `llm.discoverModels` remains
unavailable because it accepts a caller-selected destination, and the discovery
button is hidden when the adapter omits that capability. The Plugins page
initially contains only its configurable tab; plugin inventory remains disabled
because its Host metadata endpoint is outside this correction.

The General page contains Language, Appearance, and Composer Enter behavior.
Permission and Agent Preset remain absent because their Host capabilities are
disabled in this Openloop profile. The local “Open configuration file” action
is not registered.

Credential resolution behavior is not changed in this Settings-only correction.
Credentials entered through restored UI are written only through the Keychain
control and are presented as configured only when that control reports
`source: keychain`. Existing environment and migration fallback behavior
remains outside this scope.

### Failure behavior

- A denied namespace or field returns `SETTINGS_POLICY_DENIED`.
- Invalid values return `SETTINGS_VALIDATION_FAILED`.
- Revision mismatches return `SETTINGS_CONFLICT`.
- Bridge loss returns `SETTINGS_UNAVAILABLE`.
- Each failure remains in the affected form, preserves its draft, and does not
  disable unrelated sections.
- A Keychain action failure remains local to the credential control.
- A stale settings revision reloads that namespace while preserving the draft
  for explicit retry rather than overwriting newer state.
- Multi-operation mutation is atomic; partial field persistence is forbidden.
- If the scoped facade is unavailable, the section shows its real load error;
  the shell must not replace it with a generic “not provided” placeholder.

## Test Strategy

Tests are written before implementation.

1. Shell tests require exactly four Settings sections and reject placeholder
   registration.
2. Workspace client tests require no `settings.section/workspace` registration
   while preserving sidebar and authorization behavior.
3. Bundle tests require the real Settings contributors to be enabled.
4. Bridge and policy tests prove launch-bound main-WebView admission, allowed
   namespace/field mutations, exact filtered responses, and rejection of
   arbitrary HTTP/Typert callers, unreviewed settings methods, namespaces,
   fields, empty paths, endpoint changes, and credential payloads.
5. Shared-component adapter tests prove default DSH still uses
   `connection.api`, while Openloop uses only its injected filtered settings
   and provider adapter.
6. Models and Plugins integration tests prove non-secret edits persist while
   API keys use the Keychain adapter.
7. Two-client tests prove stale revisions cannot overwrite a newer mutation
   and that drafts survive policy, validation, conflict, and transport errors.
8. Browser and real Tauri E2E prove each restored section renders and one
   representative setting per section survives a full App process restart.
9. Secret sentinels are absent from request/response bodies, DOM, browser
   storage, console logs, Host logs, crash artifacts, and settings files.
10. Keychain tests prove a credential entered through restored UI remains
    usable after full restart and never falls back to `settings.mutate`.
11. Sidebar E2E retains authorize, reauthorize, rename, reveal, revoke, and
   session guard behavior after the Settings Workspace section is removed.
12. About update-check and install actions retain regression coverage.
13. Existing credential, Workspace authority, file broker, and release gates
   must remain green.
14. Bundle tests assert that no Workbench contributor or UI package was added.

## Acceptance Criteria

- No Workspace entry appears in Settings.
- Left-sidebar Workspace behavior is unchanged.
- General, Models & Credentials, and Plugins render functional controls rather
  than placeholders.
- Model and plugin non-secret changes persist across App restart.
- API keys never enter settings mutations, browser snapshots, logs, or files.
- About & Updates remains functional.
- No Workbench code or UI is added in this correction.
