# @openloop/file-broker

[English](README.md) | 中文

这是位于 `host` 编译面的私有 OpenLoop 包。

该 Host-only 包负责校验规范化的 Workspace 相对路径，并通过不透明的原生 handle
提供有边界的读取、列目录、创建和原子写入操作。原生 broker 始终从已保留且验证过的
Workspace descriptor 解析路径；调用方既不提供也不会收到规范路径或 descriptor。
