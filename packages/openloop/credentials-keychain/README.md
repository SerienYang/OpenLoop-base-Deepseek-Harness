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
result is decoded once and its mutable byte array is cleared immediately.
Direct `CredentialProvider.set()` and `unset()` calls fail closed: Openloop
mutations must use the browser-safe facade backed by native confirmation.

Keychain items use the release-channel service selected by the Tauri Host and
the account `credential:<CREDENTIAL_REFERENCE>`. Provider ids are not part of
the stored identity, so model routes and plugins may share one reference.

The Host-only consumer registry has fixed registration methods for DeepSeek,
pi-ai model routes, DeepSeek Web Search, and MCP servers. Owner ids are
collision-checked. Deletion plans are fresh, frozen, deterministic snapshots
whose localization keys are chosen by the Host. A browser deletion call sends
only a credential reference; it cannot provide consumer names or confirmation
copy. Removing a consumer registration never mutates Keychain.

MCP stdio `env` remains literal configuration. Streamable HTTP may opt into
`credentialHeaders`; each request resolves the referenced credential anew,
validates the header name and value, and rejects collisions with literal or
protocol-owned headers before network dispatch.
