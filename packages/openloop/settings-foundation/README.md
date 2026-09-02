# @openloop/settings-foundation

English | [中文](README.zh.md)

Openloop-only browser foundation for DSH clients that require the
`settingsScope` service.

Every bound scope is process-local, unavailable, and read-only. The package
does not inject a connection or Remote service and never calls the legacy
`settings.*` Host API. Locale, theme, and conversation therefore keep their
browser defaults while the legacy settings UI remains disabled.
