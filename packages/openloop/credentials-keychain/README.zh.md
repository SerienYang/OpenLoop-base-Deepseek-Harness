# @openloop/credentials-keychain

[English](README.md) | 中文

这是位于 `host` 编译面的私有 OpenLoop 包。它在 Openloop profile 中负责
`ctx.credentials`、`ctx.credentialConsumers` 和
`ctx.openloopCredentialOperations` 服务。

每次操作都会重新解析凭据，并采用固定优先级：

```text
inherited process environment (read-only)
> authenticated Host-only Keychain bridge
> optional legacy file source (read-only)
```

provider 不缓存或记录凭据值与引用。Bridge 返回值只解码一次，随后立即清空可变字节
数组和解码时的临时副本。由于直接调用 `CredentialProvider.set()` 或 `unset()` 会
失败，`CredentialProvider.describe()` 始终报告 `writable: false`。Openloop 的
浏览器安全 facade 单独报告可写状态。由于 Task 1.4 的原生替换 sheet 与删除确认尚未
安装，Keychain 和未配置 reference 当前均报告 `writable: false`；mutation preflight
会在两个占位 action 运行前拒绝请求。

Keychain item 使用 Tauri Host 按发布通道选择的 service，account 固定为
`credential:<CREDENTIAL_REFERENCE>`。provider id 不参与存储身份，因此多个模型
路线和插件可以共享同一引用。Openloop reference 必须是最长 128 字节的 ASCII shell
标识符；该产品级限制会在读取环境、registry 或 Bridge 前检查，且不改变基础 DSH 的
校验规则。存储和解析出的 secret 上限为 8 KiB，确保其十进制 JSON 字节数组表示始终
能装入经过认证的 64 KiB Bridge 响应帧。

Host-only consumer registry 为 DeepSeek、pi-ai 模型路线、DeepSeek Web Search 和
MCP server 提供固定注册方法，并检查 owner id 冲突。删除计划是每次新建、冻结且顺序
确定的快照，其中本地化 key 由 Host 指定。浏览器删除请求只携带 credential
reference，不能提供消费者名称或确认文案。每次单项注册和批量替换都会在发布前以原子
方式校验：一份计划最多包含 255 个 consumer，UTF-8 JSON 最多为 56 KiB，为经过认证的
Bridge 信封预留 8 KiB。移除 consumer 注册不会修改 Keychain。DeepSeek 与 Web Search
通过单 owner 原子 handle 替换 reference，因此容量检查失败时会保留此前的 reference。
当 registry 在插件加载时已经存在，DeepSeek、pi-ai、Web Search 和使用 credential 的
MCP 会先同步注册，再发布模型 provider、搜索 provider、连接或工具。

MCP stdio 的 `env` 保持字面量配置。Streamable HTTP 可以显式配置
`credentialHeaders`；每次请求会对每个不同的 reference 解析一次，并将同一快照复用于
对应 header，同时响应请求取消。网络发送前会校验 header 名称和值，并拒绝与字面量
header 或 MCP 协议保留 header 冲突。带凭据请求的非成功响应会先剥离为仅含状态码的
响应，再交给 MCP SDK。
