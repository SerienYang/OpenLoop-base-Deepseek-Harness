# @openloop/build-contract

Private OpenLoop package on the `host` compiler face.

This package defines the strict Schemastery contracts for OpenLoop core build
manifests and post-build artifact manifests. It does not declare a Cordis
service.

The core manifest pins product and DSH identity plus compatibility/data
versions. The artifact manifest binds required and optional packaged outputs
to the SHA-256 of the exact core manifest bytes. Call
`parseOpenloopBuildManifest()` or `parseOpenloopArtifactManifest()` on
untrusted JSON values; both parsers reject missing, invalid, and unknown
fields.
