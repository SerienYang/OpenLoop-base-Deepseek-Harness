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

`@openloop/shell` is the Openloop profile's single Client `root` owner. It
declares the existing sidebar, conversation, details, and overlay Slots plus
the root-scoped `workbench` Slot for one trusted WorkbenchHost, preserves the
shared `ctx.layout` panel actions and theme projection, and changes no default
DSH profile behavior.

`@openloop/credentials-keychain` is the Openloop profile's Host credential
provider. It resolves inherited process environment values before channel-
isolated macOS Keychain items and an optional read-only legacy source. Its
Host-only consumer registry derives native deletion-confirmation labels;
browser callers can neither resolve plaintext nor supply those labels.

`@openloop/workspace-authority` owns the Host-side Workspace grant, transaction,
generation-conflict, and recovery contracts. Its browser view contains only
the DSH Workspace id, display name, and public state; canonical paths,
filesystem identities, descriptors, and pending grant ids remain Host-only.

`@openloop/file-broker` is the Host-only Workspace file boundary. It accepts
only Workspace ids and normalized relative paths, while native operations walk
from the retained verified root descriptor and return launch-local opaque
handles.

`@openloop/fs-workspace` is the Openloop profile's DSH `FileSystem` provider.
It maps registered Workspace paths to process-local capability keys and routes
metadata, reads, listings, writes, and edits through file-broker handles.

`@openloop/sandbox-workspace` records Workspace process execution as
`disabled` for this release. Openloop registers no `ctx.subprocess`, offers no
path-string fallback, disables local process providers, model tools, code-mode
workers, and workflow workers, and exposes only the `standard` and `code`
system presets after applying the same process-denial patches. The native
`spawnWorkspaceProcess` bridge method continues to fail closed with
`not_implemented`.

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

## Credential boundary evidence

The browser E2E fixture composes the shipped DSH base and Web bundles with the
Openloop patch, using `runtime/openloop/package.json` as its module fallback
anchor. It runs the production runtime-bootstrap, desktop-bridge-host,
Keychain credential provider, API proxy, connection, Typert gateway, desktop
Remote, and bootstrap-host plugins through their normal Cordis lifecycle. An
authenticated fake Unix domain socket endpoint replaces the macOS-native
UDS/Keychain implementation; this scenario does not exercise Tauri, Security
framework storage, or native sheet rendering.

The scenario proves that the Openloop browser exposes none of the DSH
password-entry owners, a credential is not reported configured before the
fake native endpoint completes replacement, the page bootstrap exchange and
health acknowledgement finish, and both the real Connection/WebServer route
and Typert gateway reject browser access to plaintext credential operations.
It also boots the default DSH Web profile to check that its onboarding,
Models, Plugins, and credential service behavior remain available.

```sh
DSH_SNAPSHOT=replay pnpm openloop:gate-test -- web-vitest --file apps/web/tests/openloop-credential-boundary.e2e.ts
```
