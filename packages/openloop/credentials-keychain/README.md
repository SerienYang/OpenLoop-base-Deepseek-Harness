# @openloop/credentials-keychain

English | [中文](README.zh.md)

Private OpenLoop package on the `host` compiler face. It owns the
`ctx.credentials`, `ctx.credentialConsumers`, and
`ctx.openloopCredentialOperations` services in the Openloop profile.

Resolution is per operation and follows one fixed order:

```text
inherited process environment (read-only)
> authenticated Host-only Keychain bridge
> optional legacy file source (read-only)
```

The provider never caches or logs a credential value or reference. A bridge
result is decoded once and both its mutable byte array and temporary decode
copy are cleared immediately. `CredentialProvider.describe()` reports
`writable: false` because direct `set()` and `unset()` calls fail closed.
Openloop's browser-safe facade reports writability separately. The macOS Host
reports Keychain and unconfigured references as writable only when both the
same-window native replacement sheet and native deletion confirmation are
installed. Crash-safe legacy credential migration remains a separate task.

Keychain items use the release-channel service selected by the Tauri Host and
the account `credential:<CREDENTIAL_REFERENCE>`. Provider ids are not part of
the stored identity, so model routes and plugins may share one reference.
Openloop references are ASCII shell identifiers of at most 128 bytes, and this
stricter product boundary is checked before environment, registry, or bridge
access without changing base DSH validation. Stored and resolved secrets are
limited to 8 KiB so their decimal JSON byte-array representation always fits
inside the authenticated 64 KiB bridge response frame.

The Host-only consumer registry has fixed registration methods for DeepSeek,
pi-ai model routes, DeepSeek Web Search, and MCP servers. Owner ids are
collision-checked. Deletion plans are fresh, frozen, deterministic snapshots
whose localization keys are chosen by the Host. A browser deletion call sends
only a credential reference; it cannot provide consumer names or confirmation
copy. Every registration and batch replacement is validated atomically before
publication: a plan may contain at most 255 consumers and at most 56 KiB of
UTF-8 JSON, leaving 8 KiB for the authenticated bridge envelope. Removing a
consumer registration never mutates Keychain. DeepSeek and Web Search
reference replacement uses a single-owner atomic handle, so a capacity failure
keeps the prior reference registered. When the registry is already present,
DeepSeek, pi-ai, Web Search, and credential-backed MCP register synchronously
before publishing model providers, search providers, connections, or tools.

MCP stdio `env` remains literal configuration. Streamable HTTP may opt into
`credentialHeaders`; each request resolves every distinct reference once,
reuses that snapshot across mapped headers, honors request cancellation,
validates the header name and value, and rejects collisions with literal or
protocol-owned headers before network dispatch. Credential-backed non-success
responses are stripped to status only before the MCP SDK receives them.
