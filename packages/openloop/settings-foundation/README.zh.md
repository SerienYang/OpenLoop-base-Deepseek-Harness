# @openloop/settings-foundation

[English](README.md) | 中文

Openloop 专用的浏览器底座，为需要 `settingsScope` 服务的 DSH Client
提供依赖。

每个绑定的 scope 都只存在于进程内，状态为不可用且只读。本包不注入
connection 或 Remote 服务，也不会调用 legacy `settings.*` Host API。因此，
locale、theme 与 conversation 可以保留浏览器默认值，同时 legacy settings UI
继续处于禁用状态。
