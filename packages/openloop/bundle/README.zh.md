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

`ensureOpenloopProfile()` 仅在 `package.json` 不存在时创建 `openloop` profile。
该清单一旦存在，profile 和所有同级文件即归用户所有，本包不会再改动其字节。
