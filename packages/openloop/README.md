# OpenLoop packages

OpenLoop product packages live at `packages/openloop/<name>` and use the
matching private package name `@openloop/<name>`. This is a narrow exception
to the public `@deepseek-ai/dsh-*` release layout; it does not change DSH
package names, publication metadata, or release constraints.

Every manifest must set `"private": true` and declare exactly one compiler
face through `"openloop": { "face": "host" | "client" | "pure" }`. A Cordis
plugin also sets `openloop.cordisPlugin` and declares matching
`@deepseek-ai/cordis` peer and development dependency ranges.

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
