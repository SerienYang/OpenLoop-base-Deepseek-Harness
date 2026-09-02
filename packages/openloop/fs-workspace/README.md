# @openloop/fs-workspace

English | [中文](README.zh.md)

Private OpenLoop Host plugin implementing the DSH `FileSystem` service over
`@openloop/file-broker`.

The provider maps registered Workspace paths to opaque, process-local
capability keys. Model-visible paths stay Workspace-relative. Every metadata,
read, list, write, and edit operation uses native broker handles; the package
does not import Node filesystem or subprocess modules.
