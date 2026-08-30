# @openloop/shell

Private Openloop package on the `client` compiler face and the sole `root`
Slot owner in the Openloop profile.

The frame keeps the DSH sidebar, conversation, details, and overlay contracts
while supplying Openloop's neutral semantic palette. It also preserves the
existing `ctx.layout` actions and theme-to-document projection. The default
DSH profile does not load this package.
