# @openloop/sandbox-workspace

English | [中文](README.zh.md)

This Host package publishes the current Workspace process capability as
`disabled`. The desktop bridge cannot yet transfer the descriptor state needed
to prove descriptor-anchored `fchdir`, policy and identity rechecks, and
`exec` as one race-resistant operation.

The package does not register `ctx.subprocess`, provide a path-string fallback,
or start processes. Its diagnostic and invariant make that fail-closed release
state explicit until the native contract can enforce the complete chain.
