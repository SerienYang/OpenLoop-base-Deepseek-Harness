# @openloop/sandbox-workspace

[English](README.md) | 中文

该 Host 包将当前 Workspace 进程执行能力明确标记为 `disabled`。Desktop Bridge
目前无法传递所需的 descriptor 状态，因此不能把基于 descriptor 的 `fchdir`、
policy 与 identity 复检及 `exec` 证明为一个抵抗竞态的完整操作。

该包不注册 `ctx.subprocess`，不提供 path-string fallback，也不启动进程。它通过
诊断与 invariant 明确记录当前发布版的 fail-closed 状态，直至原生契约能够强制
执行完整链路。
