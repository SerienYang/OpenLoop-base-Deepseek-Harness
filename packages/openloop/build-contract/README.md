# @openloop/build-contract

Private OpenLoop package on the `host` compiler face.

This package defines the strict Schemastery contracts for OpenLoop core build
manifests and post-build artifact manifests. It does not declare a Cordis
service.

The core manifest pins product and DSH identity plus compatibility/data
versions. The artifact manifest binds required and optional packaged outputs
to the SHA-256 of the exact core manifest bytes:

```ts
interface OpenloopArtifactManifest {
  coreManifestSha256: string
  artifacts: {
    sidecar: string
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

Every digest is a lowercase 64-character hexadecimal string. The build
generator accepts approved upstream baselines with `sourceType` `release`,
`tag`, or `approved_commit`; it preserves `sourceRef` as `dshTag` and requires
a full lowercase commit plus valid, non-future `approvedAt` and `capturedAt`
timestamps.

Call
`parseOpenloopBuildManifest()` or `parseOpenloopArtifactManifest()` on
untrusted JSON values; both parsers reject missing, invalid, and unknown
fields.
