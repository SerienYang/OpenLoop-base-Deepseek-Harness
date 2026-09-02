# @openloop/desktop-bridge-client

English | [中文](README.zh.md)

Private Openloop package on the `client` compiler face.

This package mounts the generated `openloopDesktop` Remote contribution and
provides the profile-selected `workspaceRuntimeAdapter`. Its Workspace facade
uses only opaque Workspace ids and Host-safe grant projections. Authorization
never accepts a path, and session creation sends only `workspaceId` plus an
explicitly selected `agentPreset`.
