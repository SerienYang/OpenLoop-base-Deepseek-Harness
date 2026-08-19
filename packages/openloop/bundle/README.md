# @openloop/bundle

Private OpenLoop package on the `host` compiler face.

This package is the only OpenLoop composition layer on top of the official DSH
Web bundle. The OpenLoop profile applies `@deepseek-ai/dsh-base`, then
`@deepseek-ai/dsh-web-app`, then this package's `cordis.patch.yml`.

The patch starts empty. Add future OpenLoop product features through this patch;
never modify `packages/bundle/web-app` for OpenLoop composition.

`ensureOpenloopProfile()` creates the `openloop` profile only when its
`package.json` is absent. Once that manifest exists, the profile and all sibling
files are user-owned and this package leaves their bytes unchanged.
