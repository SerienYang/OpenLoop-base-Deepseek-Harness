# @openloop/bundle

[English](README.md) | 中文

这是位于 `host` 编译面的私有 OpenLoop 包。

本包是官方 DSH Web bundle 之上的唯一 OpenLoop 组合层。OpenLoop profile
依次应用 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`，再应用本包的
`cordis.patch.yml`。

该补丁会关闭上游 Web 运行时供人阅读的 URL 行，使桌面 Host 仅通过 stdout
接收 readiness JSON。由于按 ID 定位的补丁会替换整个配置对象，该覆盖还会重述
`surfaceContext` 和由调用参数派生的 `trustedHosts`。后续 OpenLoop 产品能力必须
通过此补丁添加；不得为了 OpenLoop 组合去修改 `packages/bundle/web-app`。

该补丁还会挂载 `@openloop/desktop-bridge-host`，作为唯一的
`browserApiPolicy` 所有者。`connection` 与 `typert-gateway` 两个条目都将该
服务声明为 required injection，因此 policy 卸载时浏览器分派器会暂停，而不会
出现 fail-open 窗口。此依赖只存在于 OpenLoop 层；默认 DSH Web bundle 不变。

首发 profile 会禁用继承来的 `cordis-client-runner` 与 `ui-cordis` 两行，因此
只加载静态签名的 Client roster。它还会禁用首版 policy 未开放其宽泛 Host 调用的
上游设置、权限、agent-preset 与 Workspace Client owner。后续任务用专用 Host
facade 替代前，这些界面不会加载。Openloop Desktop Bridge client 会提供由
profile 选择的 runtime adapter，因此共享 client runtime 不会构造 legacy
Workspace runtime，也不会调用任何 `workspace.*` 方法。

## 内置提供方

该补丁还会添加以下 `llm-pi-ai` 提供方预设：

- 提供方 ID：`volcengine-agent-plan`
- 显示名称：`火山方舟 Agent Plan`
- 端点：`https://ark.cn-beijing.volces.com/api/plan/v3`
- 协议：OpenAI Responses
- 凭据引用：`VOLCENGINE_ARK_AGENT_PLAN_API_KEY`
- 凭据模式：`bearer`
- 模型：[Agent Plan 官方 OpenCode 配置](https://docs.volcengine.com/docs/82379/2373741?lang=zh)
  发布的 13 个文本生成模型 ID

模型选择器按精确模型 ID 切换，并使用各目录条目声明的上下文、输出及图片输入能力。
`ark-code-latest` 仍作为控制台托管别名提供。

Agent Plan 密钥与普通方舟密钥、Coding Plan 密钥互不通用；请将 Agent Plan
密钥存入上述凭据引用。

`ensureOpenloopProfile()` 仅在 `package.json` 不存在时创建 `openloop` profile。
该清单一旦存在，profile 和所有同级文件即归用户所有，本包不会再改动其字节。
但 Openloop runtime 只接受精确的 shipped bundle 元组；profile patch 文件只能
替换既有、非保护、非 group row 的 `config`。新增 row、未知 id、拓扑字段，以及
对 policy、transport、dynamic Client 与 bootstrap row 的任何修改都会被拒绝。
