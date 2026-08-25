# @openloop/bundle

English | [中文](README.zh.md)

Private OpenLoop package on the `host` compiler face.

This package is the only OpenLoop composition layer on top of the official DSH
Web bundle. The OpenLoop profile applies `@deepseek-ai/dsh-base`, then
`@deepseek-ai/dsh-web-app`, then this package's `cordis.patch.yml`.

The patch disables the upstream Web runtime's human-readable URL line so the
desktop Host receives readiness JSON as the only stdout protocol. Because an
ID-targeted patch replaces the whole config object, the override also restates
`surfaceContext` and the invocation-derived `trustedHosts`. Add future OpenLoop
product features through this patch; never modify `packages/bundle/web-app` for
OpenLoop composition.

The patch also mounts `@openloop/desktop-bridge-host` as the sole
`browserApiPolicy` owner. Both the `connection` and `typert-gateway` rows
required-inject that service, so unloading the policy suspends the browser
dispatchers instead of opening a fail-open window. This dependency exists only
in the OpenLoop layer; the default DSH Web bundle remains unchanged.

The first-release profile disables the inherited `cordis-client-runner` and
`ui-cordis` rows, so only the static signed Client roster is loaded. It also
disables the upstream settings, permission, agent-preset, and workspace Client
owners whose broad Host calls are outside the first policy. Those surfaces
remain absent until dedicated Host facades replace them in later tasks; the
runtime keeps the read-only `workspace.list` baseline needed during startup.

`ensureOpenloopProfile()` creates the `openloop` profile only when its
`package.json` is absent. Once that manifest exists, the profile and all sibling
files are user-owned and this package leaves their bytes unchanged. The
Openloop runtime nevertheless accepts only the exact shipped bundle tuple and
allows that profile's patch file to replace `config` on an existing,
non-protected, non-group row. It rejects inserts, unknown ids, topology fields,
and every change to the policy, transport, dynamic-Client, and bootstrap rows.
