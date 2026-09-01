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

## Built-in provider

The patch also adds this `llm-pi-ai` provider preset:

- Provider ID: `volcengine-agent-plan`
- Display name: `火山方舟 Agent Plan`
- Endpoint: `https://ark.cn-beijing.volces.com/api/plan`
- Credential reference: `VOLCENGINE_ARK_AGENT_PLAN_API_KEY`
- Credential mode: `bearer`
- Model: `ark-code-latest`

Agent Plan keys are distinct from ordinary Ark keys and Coding Plan keys; store
an Agent Plan key under the credential reference above.

`ensureOpenloopProfile()` creates the `openloop` profile only when its
`package.json` is absent. Once that manifest exists, the profile and all sibling
files are user-owned and this package leaves their bytes unchanged.
