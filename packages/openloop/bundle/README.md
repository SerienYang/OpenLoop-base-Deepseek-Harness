# @openloop/bundle

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

`ensureOpenloopProfile()` creates the `openloop` profile only when its
`package.json` is absent. Once that manifest exists, the profile and all sibling
files are user-owned and this package leaves their bytes unchanged.
