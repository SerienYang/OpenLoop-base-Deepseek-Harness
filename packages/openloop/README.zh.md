# OpenLoop 包

[English](README.md) | 中文

OpenLoop 产品包位于 `packages/openloop/<name>`，并使用对应的私有包名
`@openloop/<name>`。这是对公开 `@deepseek-ai/dsh-*` 发布布局的严格限定例外；
它不会改变 DSH 的包名、发布元数据或发布约束。

每个清单都必须设置 `"private": true`，并通过
`"openloop": { "face": "host" | "client" | "pure" }` 声明且仅声明一个编译面。
Cordis 插件还需设置 `openloop.cordisPlugin`，并声明范围一致的
`@deepseek-ai/cordis` peer 和开发依赖。

每个包在根编译聚合中只出现一次。`host` 和 `pure` 包归入
`tsconfig.host.json`；`client` 包归入 `tsconfig.client.json`。Pure 包继承中立的
`tsconfig.base.json` 结构，并由 Host 聚合作为其唯一的仓库检查所有者。
Client 项目可以在自身项目图中引用 pure 包，但不能再把该 pure 包列入根 Client
聚合。

通过根命令创建包：

```sh
pnpm openloop:new-package -- --name <name> --face <host|client|pure>
```

可选参数包括 `--client-bundle`、`--bundle-row <openloop-bundle>` 和
`--service <ctx-service-key>`。脚手架会拒绝覆盖包自有文件或创建重复的 Cordis
bundle 行，并且只添加一个编译聚合引用。

OpenLoop 聚焦测试通过 `pnpm openloop:gate-test -- <mode>` 运行。
获批的临时跳过项位于 `scripts/openloop/test-skip-allowlist.json`；每条记录都必须
包含负责人、原因和未来的到期日期。
