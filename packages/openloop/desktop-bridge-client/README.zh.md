# @openloop/desktop-bridge-client

[English](README.md) | 中文

Openloop 私有 `client` 编译面包。

本包挂载生成的 `openloopDesktop` Remote contribution，并提供由 profile
选择的 `workspaceRuntimeAdapter`。Workspace facade 只使用不透明 Workspace
id 与 Host 安全授权投影。授权操作不接收路径；创建 session 时仅发送
`workspaceId`，以及用户显式选择时的 `agentPreset`。
