# @openloop/desktop-bridge-host

[English](README.md) | 中文

这是位于 `host` 编译面的私有 OpenLoop 包。

本包是 OpenLoop 桌面 profile 中版本 1 `browserApiPolicy` Cordis 服务的唯一
生命周期所有者。默认 DSH 不挂载该服务，因此保留既有 API 行为。

`openloop-browser-api.json` 是经人工审查、默认拒绝的事实来源，分别列出 legacy
`/api/<method>` 名称、Typert Remote endpoint、payload 规则及无信封物理路由。
名称必须精确匹配；policy 不会 trim、转小写，也不会转换点号与斜线。

legacy payload 分派、Typert descriptor 或 receiver 查找、HTTP transport 业务
对象和 WebSocket downlink 都会读取同一个实时 service，并在业务执行前检查。仅按
target 的预检会在 HTTP bridge 缓冲请求体前拒绝方法；获准的方法在解码后仍需通过
payload 检查。`session.create` 必须具有 own `workspaceId`，且只能额外携带可选的
`sessionId` 和 `agentPreset`。未知方法、endpoint、路由、manifest 字段及重复条目
都会被拒绝。所有 legacy credential 方法（包括 `credentials.describe`）均不在
浏览器 allowlist 中。

OpenLoop 首发 profile 拒绝通用设置面与凭据面。这些方法可寻址任意 namespace、
模型提供方 endpoint、凭据引用和 shell 默认值；在后续任务为获准的设置流程提供
专用 Host facade 之前，对应的上游 Client owner 均保持禁用。上游 Workspace 管理
owner 同样禁用。Openloop client runtime adapter 只使用版本化
`openloopDesktop/*` Workspace facade；所有 legacy `workspace.*` 方法在启动和
重连期间也保持拒绝。

OpenLoop 会让两个浏览器 dispatcher 都 required-inject 此服务。如果 provider
已开始卸载而路由 effect 尚未完成清理，dispatcher 仍会认领并拒绝请求，不会短暂
回退到未过滤的 DSH 行为。

OpenLoop 首发 profile 不加载第三方 Client 插件。组合会禁用
`cordis-client-runner` 和 `ui-cordis`，所有 `dynamicCordisRunner/*` 浏览器
endpoint 均保持拒绝。静态签名的内置 Client 插件仍通过正常 roster 加载。

`scripts/openloop/browser-api-drift.spec.ts` 会双向核对该 roster 与 policy。
legacy 调用来自 TypeScript 解析后的 `IApiClient` signature。Typert endpoint 只以
`dsh-api-remotes` 所选择、由现有 `WorkspaceTypertGenerator` 生成的 descriptor
为准；源码中的 `*.remote.<namespace>.<method>()` 直接调用通过 AST 识别，因此
没有生成构建产物时门禁仍可运行，委托式调用则由可解析的包内 Remote interface
补充覆盖。roster 来自三个 signed bundle patch 的最终组合及各包的 `dsh.client`
manifest。Connection 的两条 downlink、respond 路由，以及 session-log 的 GET/HEAD
下载是唯一显式维护的 transport catalog，因为这些浏览器原语没有共享的生成
descriptor。client-only fixture 不跨越 Host bridge，因此不参与扫描。computed API
方法访问不受支持，会让 collector 直接失败，而不是绕过 catalog。该测试不会写入或
扩张运行时 allowlist。
