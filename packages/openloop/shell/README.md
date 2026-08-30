# @openloop/shell

Private Openloop package on the `client` compiler face and the sole `root`
Slot owner in the Openloop profile.

The frame keeps the DSH sidebar, conversation, details, and overlay contracts,
and owns one root-scoped `workbench` Slot for the trusted WorkbenchHost. Its
theme override is generated from `assets/brand/openloop.tokens.json`, including
both Light and Dark values. The shell also preserves the existing `ctx.layout`
actions and theme-to-document projection. The default DSH profile does not
load this package.
