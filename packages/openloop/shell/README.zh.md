# @openloop/shell

[English](README.md) | 中文

这是位于 `client` 编译面的私有 Openloop 包，也是 Openloop profile 中唯一的
`root` Slot owner。

该框架保留 DSH 的 sidebar、conversation、details 和 overlay 契约，并拥有一个
root-scoped `workbench` Slot，用于承载可信的 WorkbenchHost。主题覆盖由
`assets/brand/openloop.tokens.json` 生成，同时包含 Light 与 Dark 取值。Shell
还保留现有的 `ctx.layout` panel action 和主题到文档的投影。默认 DSH profile
不会加载本包。
