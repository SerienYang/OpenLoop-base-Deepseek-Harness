# Workspace isolation feasibility spike

## Result

The descriptor-relative Workspace approach and a narrow Seatbelt profile are
feasible on the tested host. This is spike code only. The production broker,
authorization lifecycle, and process supervision remain Desktop Core work.

Test host:

- macOS 26.5.1, build 25F80
- Apple Silicon (`arm64`)
- `/usr/bin/sandbox-exec` present
- Test toolchain: `rustc 1.97.1`; crate MSRV remains Rust 1.88

## Descriptor-relative Workspace access

`WorkspaceRoot` opens the selected root once and retains its directory
descriptor. Each relative path component is opened from the preceding
descriptor with `openat`, `O_DIRECTORY` where applicable, and `O_NOFOLLOW`.
The final read uses `O_NONBLOCK` and `O_NOFOLLOW`, then accepts only a regular
file whose link count is exactly one. This prevents FIFO blocking and rejects
special or multiply linked inodes.

Writes never open an existing target with `O_TRUNC`. The target is first
opened nonblocking with `O_NOFOLLOW` and, when present, must be a regular file
whose link count is exactly one. The implementation then creates a
cryptographically random temporary name in the same parent directory with
`O_CREAT | O_EXCL | O_NOFOLLOW`, writes the complete replacement, and uses
`renameat` to atomically replace the target directory entry. Every write or
rename error attempts to unlink the temporary file. If an attacker swaps the
checked target for an external hardlink, `renameat` replaces only the
Workspace directory entry and never truncates the external inode.

No file operation uses a canonicalized path followed by an ordinary
path-based open.

The spike rejects before any file operation:

- empty and absolute paths;
- empty, `.` and `..` components;
- case-insensitive `%2e`, `%2f`, and `%5c` sequences.

The real fixtures proved:

- reads and writes inside Workspace succeed;
- an existing regular file is updated by inode-replacing atomic rename;
- reads and writes reject a Workspace hardlink to a sibling private secret,
  and the private inode remains unchanged;
- FIFO and directory reads and writes fail without blocking;
- first-, second-, and third-level parent symlinks are rejected;
- reads and creates through a final symlink are rejected;
- replacing the root path after it is opened does not redirect the held
  descriptor to the replacement symlink.

## Seatbelt profile

The following is the complete profile printed by a successful test on this
host. The two `.tmpE8CiHJ` paths were the exact, short-lived fixture paths for
that run. The implementation resolves `/var` to its kernel path
`/private/var` only when rendering the Seatbelt policy; Workspace file access
continues to use descriptors.

```scheme
(version 1)
(deny default)
(allow process-exec
    (literal "/bin/sh" "/bin/bash"))
(allow sysctl-read
    (sysctl-name "security.mac.lockdown_mode_state" "kern.bootargs"))
(allow file-read-metadata
    (literal "/var" "/bin/bash" "/private/var/select/sh")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpE8CiHJ/workspace")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpE8CiHJ/task-temp"))
(allow file-read-data
    (literal "/" "/bin/sh" "/bin/bash")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpE8CiHJ/workspace")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpE8CiHJ/task-temp"))
(allow file-write*
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpE8CiHJ/workspace")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpE8CiHJ/task-temp"))
```

There is no unfiltered metadata permission. Real-host reduction produced the
three metadata literals above:

- without `/private/var/select/sh`, shell startup reported
  `Error opening /private/var/select/sh: Operation not permitted`;
- after adding the selector, `/var/folders/.../workspace/readable.txt` was
  still denied until the `/var` symlink literal was allowed;
- `/bin/sh` metadata was removable, while removing `/bin/bash` terminated the
  shell with no exit code or stderr.

The two exact sysctls, the root directory data read, and the `/bin/bash`
re-exec remain required by `/bin/sh` startup on this macOS build. Workspace
and task-temp metadata are limited to their canonical subpaths.

Observed process results:

- Workspace read/write: allowed.
- Task temp read/write: allowed.
- Sibling private fixture read: exit 1, `Operation not permitted`.
- Home write: the identical path was created and removed outside Seatbelt,
  then the sandboxed write exited 1 with `Operation not permitted`.
- A copy of `/usr/bin/true` in Workspace executed successfully outside
  Seatbelt, then nested execution exited 126 with `Operation not permitted`.

## Commands and evidence

RED, before exporting or implementing `spikes`:

```sh
pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test workspace_spike
```

The command exited 1 while compiling the integration test:
`could not find spikes in openloop_desktop_lib`.

GREEN through the repository gate:

```sh
pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test workspace_spike
```

Result: 13 passed, 0 failed, 0 ignored.

The requested nocapture command currently fails in the existing gate wrapper
before Cargo starts:

```sh
pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test workspace_spike -- --nocapture
```

Result: exit 1, `unknown option --`. The Task 13 change does not widen scope
to alter `scripts/openloop/run-gate-tests.mjs`. Equivalent gate evidence was
captured with:

```sh
RUST_TEST_NOCAPTURE=1 pnpm openloop:gate-test -- cargo --manifest apps/openloop-desktop/src-tauri/Cargo.toml --test workspace_spike
cargo test --manifest-path apps/openloop-desktop/src-tauri/Cargo.toml --test workspace_spike -- --nocapture
```

Both commands ran all 13 tests successfully and printed the profile and
denial results above.

## Limitations

Apple documents `sandbox-exec` as deprecated and directs applications to App
Sandbox. This spike therefore demonstrates current-host behavior only and is
not a production support commitment.

The process profile supports only the tested `/bin/sh` to `/bin/bash` startup
chain and shell builtins. Arbitrary external executables, nested toolchains,
PTY/login-shell behavior, XPC helpers, networking, process-fork policy, signal
management, and descendant lifecycle supervision are not supported or
validated. The copied `/usr/bin/true` test isolates `process-exec` as the
missing permission because Workspace file data is allowed and the same copied
binary succeeds outside Seatbelt.
