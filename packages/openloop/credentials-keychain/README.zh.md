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
浏览器安全 facade 单独报告可写状态：只有原生 Bridge 确认 Keychain 路径可写，且没有
只读环境变量或 legacy 来源遮蔽时，才会报告可写。

Keychain item 使用 Tauri Host 按发布通道选择的 service，account 固定为
`credential:<CREDENTIAL_REFERENCE>`。provider id 不参与存储身份，因此多个模型
路线和插件可以共享同一引用。

Host-only consumer registry 为 DeepSeek、pi-ai 模型路线、DeepSeek Web Search 和
MCP server 提供固定注册方法，并检查 owner id 冲突。删除计划是每次新建、冻结且顺序
确定的快照，其中本地化 key 由 Host 指定。浏览器删除请求只携带 credential
reference，不能提供消费者名称或确认文案。移除 consumer 注册不会修改 Keychain。

MCP stdio 的 `env` 保持字面量配置。Streamable HTTP 可以显式配置
`credentialHeaders`；每次请求都会重新解析引用，并在网络发送前校验 header 名称和值，
同时拒绝与字面量 header 或 MCP 协议保留 header 冲突。
