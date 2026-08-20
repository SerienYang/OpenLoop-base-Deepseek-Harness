# @openloop/build-contract

[English](README.md) | 中文

这是位于 `host` 编译面的私有 OpenLoop 包。

本包为 OpenLoop 核心构建清单和构建后产物清单定义严格的 Schemastery
约定，不声明 Cordis 服务。

核心清单固定产品与 DSH 身份，以及兼容性和数据版本。产物清单则把必需和可选的
打包输出绑定到核心清单精确字节的 SHA-256：

```ts
interface OpenloopArtifactManifest {
  coreManifestSha256: string
  artifacts: {
    sidecar: string
    runtimeSbom: string
    web: string
    bundleGraph: string
    app?: string
    dmg?: string
    updater?: string
    ffmpeg?: string
    ffprobe?: string
  }
}
```

每个摘要都必须是由 64 个小写十六进制字符组成的字符串。构建生成器只接受
`sourceType` 为 `release`、`tag` 或 `approved_commit` 的已批准上游基线；
它会把 `sourceRef` 保留为 `dshTag`，并要求完整的小写 commit，以及有效且不晚于
当前时间的 `approvedAt` 和 `capturedAt` 时间戳。

对不受信任的 JSON 值调用 `parseOpenloopBuildManifest()` 或
`parseOpenloopArtifactManifest()`；两个解析器都会拒绝缺失、无效和未知字段。
