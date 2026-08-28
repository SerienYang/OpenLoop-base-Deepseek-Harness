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

OpenLoop 业务包只能通过包根或已声明的公开子路径导出来使用 DSH，禁止访问私有
`src`/`lib` 路径。受支持 DSH 版本之间的兼容逻辑归
`@openloop/adapters` 所有；该包以带版本、无副作用的契约转换公开的 Shell、
Workspace、设置与桌面数据，但不负责持久化或工作流状态。

`@openloop/credentials-keychain` 是 Openloop profile 的 Host 凭据 provider。
它依次解析继承的进程环境变量、按发布通道隔离的 macOS Keychain item，以及可选的
只读旧来源。它的 Host-only consumer registry 负责生成原生删除确认所需的展示信息；
浏览器调用方既不能解析明文，也不能提供这些展示信息。

`@openloop/fs-workspace` 是 Openloop profile 的 DSH `FileSystem` provider。
它把已登记 Workspace 路径映射为进程内 capability key，并通过 file broker handle
执行元数据查询、读取、列目录、写入和编辑。

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

## 凭据边界证据

浏览器 E2E fixture 组合发布的 DSH base、Web bundle 与 Openloop patch，并继续以
`runtime/openloop/package.json` 作为模块解析 anchor。测试通过正常 Cordis lifecycle
运行生产 `runtime-bootstrap`、`desktop-bridge-host`、Keychain credential provider、
API proxy、Connection、Typert gateway、desktop Remote 与 `bootstrap-host` 插件。
测试只用一个经过认证的 Unix domain socket 假端点替代 macOS 原生 UDS/Keychain
实现；它不覆盖 Tauri、Security framework 存储或原生 sheet 渲染。

该场景验证 Openloop 浏览器不暴露 DSH 密码输入入口、凭据在假原生端点完成替换前
不会被报告为已配置、页面 bootstrap exchange 与 health acknowledgement 能完成，
并验证真实 Connection/WebServer route 和 Typert gateway 都会拒绝浏览器读取明文
凭据。它还启动默认 DSH Web profile，检查 onboarding、Models、Plugins 与原凭据
服务仍然可用。

```sh
DSH_SNAPSHOT=replay pnpm openloop:gate-test -- web-vitest --file apps/web/tests/openloop-credential-boundary.e2e.ts
```
