# @openloop/adapters

English | [中文](README.zh.md)

Private OpenLoop package on the `pure` compiler face. It translates supported
DSH public Shell, Workspace, settings, and desktop shapes into versioned
Openloop contracts.

The adapters are side-effect-free and own no persistence, workflow, or Cordis
service state.

`tsconfig.json` is the pure production build and must not reference Client
projects. `tsconfig.contracts.json` separately compiles the current DSH public
types and saved historical declarations against the adapter inputs:

```sh
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsc -b packages/openloop/adapters/tsconfig.contracts.json
```

The root `pnpm run typecheck` runs these in this order after the Host check.
The offline `git show` evidence and its per-contract SHA/path/hash manifest
live under `tests/fixtures/`.
