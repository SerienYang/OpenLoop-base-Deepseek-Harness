# @openloop/fs-workspace

[English](README.md) | 中文

这是一个私有 OpenLoop Host 插件，基于 `@openloop/file-broker` 实现 DSH
`FileSystem` 服务。

该 provider 将已登记的 Workspace 路径映射为不透明的进程内 capability key。
模型可见路径始终是 Workspace 相对路径。所有元数据、读取、列目录、写入和编辑操作
都通过原生 broker handle 完成；该包不导入 Node 文件系统或子进程模块。
