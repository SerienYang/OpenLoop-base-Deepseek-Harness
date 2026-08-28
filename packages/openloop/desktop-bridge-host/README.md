# @openloop/desktop-bridge-host

English | [中文](README.zh.md)

Private OpenLoop package on the `host` compiler face.

This package owns the version 1 `browserApiPolicy` Cordis service used by the
OpenLoop desktop profile. Base DSH does not mount the service and keeps its
existing API behavior.

`openloop-browser-api.json` is the reviewed, deny-by-default source of truth.
It separately lists legacy `/api/<method>` names, Typert Remote endpoints,
payload rules, and envelope-free physical routes. Names are exact: the policy
does not trim, lowercase, or translate dots and slashes.

The same live service is consulted before legacy payload dispatch, Typert
descriptor or receiver lookup, HTTP transport objects, and WebSocket
downlinks. Its target-only preflight rejects a method before the HTTP bridge
buffers its body; admitted methods still pass the payload-aware check after
decoding. `session.create` requires an own `workspaceId` and permits only the
optional `sessionId` and `agentPreset` fields. Unknown methods, endpoints,
routes, manifest fields, and duplicate entries are rejected. All legacy
credential methods, including `credentials.describe`, remain outside the
browser allowlist.

The first OpenLoop profile denies the generic settings and credential planes.
Those methods can address arbitrary namespaces, provider endpoints, credential
references, and shell defaults. Their upstream Client owners are disabled
until later tasks provide purpose-built Host facades for approved settings
flows. The upstream workspace management owner is disabled for the same
reason. The Openloop client runtime adapter uses only the versioned
`openloopDesktop/*` Workspace facade; every legacy `workspace.*` method stays
denied, including startup and reconnect.

OpenLoop makes both browser dispatchers require this service. If the provider
starts unloading before their route effects have finished disposing, they
continue to claim and reject requests instead of temporarily falling back to
the unfiltered DSH behavior.

The first OpenLoop profile does not load third-party Client plugins. Its
composition disables both `cordis-client-runner` and `ui-cordis`, and every
`dynamicCordisRunner/*` browser endpoint remains denied. Static, signed built-in
Client plugins continue to load through the normal roster.

`scripts/openloop/browser-api-drift.spec.ts` checks that roster and the policy
in both directions. Legacy calls come from TypeScript-resolved
`IApiClient` signatures. Typert endpoints come exclusively from the existing
`WorkspaceTypertGenerator` descriptors selected by `dsh-api-remotes`; direct
`*.remote.<namespace>.<method>()` calls are recognized from source so the gate
also works without generated build output, while resolved local Remote
interfaces cover delegated calls. The roster comes from the three composed
signed bundle patches plus each `dsh.client` manifest. Connection's two
downlinks and respond route, and the session-log GET/HEAD download, are the
only explicit transport catalog because those browser primitives have no
shared generated descriptor. The client-only fixture is excluded because it
never crosses the Host bridge. Computed API method access is unsupported and
fails the collector rather than escaping the catalog. The test never writes or
expands the runtime allowlist.
