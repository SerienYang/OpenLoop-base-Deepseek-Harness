# @openloop/adapters

[English](README.md) | 中文

这是位于 `pure` 编译面的 OpenLoop 私有包。它将受支持 DSH 的公开 Shell、
Workspace、设置和桌面数据结构转换为带版本的 Openloop 契约。

这些适配器无副作用，不负责持久化、工作流或 Cordis 服务状态。

`tsconfig.json` 是纯生产构建，不得引用 Client 项目。
`tsconfig.contracts.json` 单独根据适配器输入编译当前 DSH 公开类型和保存的历史
声明：

```sh
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsc -b packages/openloop/adapters/tsconfig.contracts.json
```

根目录的 `pnpm run typecheck` 会在 Host 检查后按上述顺序运行这些命令。离线
`git show` 证据及其按契约记录的 SHA/路径/hash 清单位于 `tests/fixtures/`。
