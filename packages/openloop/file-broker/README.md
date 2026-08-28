# @openloop/file-broker

Private OpenLoop package on the `host` compiler face.

This Host-only package validates normalized Workspace-relative paths and
provides bounded read/list/create/atomic-write operations over opaque native
handles. The native broker resolves every path from the retained verified
Workspace descriptor; callers never provide or receive canonical paths or
descriptors.
