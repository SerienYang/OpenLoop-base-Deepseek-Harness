# OpenLoop packages

English | [中文](README.zh.md)

OpenLoop product packages live at `packages/openloop/<name>` and use the
matching private package name `@openloop/<name>`. This is a narrow exception
to the public `@deepseek-ai/dsh-*` release layout; it does not change DSH
package names, publication metadata, or release constraints.

Every manifest must set `"private": true` and declare exactly one compiler
face through `"openloop": { "face": "host" | "client" | "pure" }`. A Cordis
plugin also sets `openloop.cordisPlugin` and declares matching
`@deepseek-ai/cordis` peer and development dependency ranges.

Each package appears exactly once in a root compiler aggregate. `host` and
`pure` packages belong to `tsconfig.host.json`; `client` packages belong to
`tsconfig.client.json`. Pure packages extend the neutral `tsconfig.base.json`
shape and use the Host aggregate as their single repository check owner.
Client projects may reference a pure package from their own project graph, but
the pure package is not also listed in the root Client aggregate.

OpenLoop business packages consume DSH only through package-root or declared
public subpath exports. Private `src`/`lib` paths are forbidden. Compatibility
with supported DSH revisions belongs in `@openloop/adapters`, whose versioned,
side-effect-free contracts translate public Shell, Workspace, settings, and
desktop data without owning persistence or workflow state.

Create packages through the root command:

```sh
pnpm openloop:new-package -- --name <name> --face <host|client|pure>
```

Optional flags are `--client-bundle`, `--bundle-row <openloop-bundle>`, and
`--service <ctx-service-key>`. The scaffolder refuses to replace package-owned
files or duplicate Cordis bundle rows and adds one compiler aggregate
reference.

Focused OpenLoop tests run through `pnpm openloop:gate-test -- <mode>`.
Approved temporary skips live in
`scripts/openloop/test-skip-allowlist.json`; entries require an owner, reason,
and future expiry.
