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
The final read or create also uses `openat` and `O_NOFOLLOW`. No file operation
uses a canonicalized path followed by an ordinary path-based open.

The spike rejects before any file operation:

- empty and absolute paths;
- empty, `.` and `..` components;
- case-insensitive `%2e`, `%2f`, and `%5c` sequences.

The real fixtures proved:

- reads and writes inside Workspace succeed;
- first-, second-, and third-level parent symlinks are rejected;
- reads and creates through a final symlink are rejected;
- replacing the root path after it is opened does not redirect the held
  descriptor to the replacement symlink.

## Seatbelt profile

The following is the complete profile printed by the successful test on this
host. The two `.tmpJta232` paths were the exact, short-lived fixture paths for
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
(allow file-read-metadata)
(allow file-read-data
    (literal "/" "/bin/sh" "/bin/bash")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpJta232/workspace")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpJta232/task-temp"))
(allow file-write*
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpJta232/workspace")
    (subpath "/private/var/folders/tp/j03xysx53230stb8k7trm8y00000gn/T/.tmpJta232/task-temp"))
```

The two exact sysctls, the root directory data read, and the `/bin/bash`
re-exec are required by `/bin/sh` startup on this macOS build. Removing the
three broader system-library read rules used during investigation still left
all tests green, so they are not present in the final profile.

Observed process results:

- Workspace read/write: allowed.
- Task temp read/write: allowed.
- Sibling private fixture read: exit 1, `Operation not permitted`.
- Home write: exit 1, `Operation not permitted`.
- Nested `/usr/bin/true`: exit 126, `Operation not permitted`.

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

Result: 7 passed, 0 failed, 0 ignored.

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

Both commands ran all seven tests successfully and printed the profile and
denial results above.

## Limitations

Apple documents `sandbox-exec` as deprecated and directs applications to App
Sandbox. This spike therefore demonstrates current-host behavior only and is
not a production support commitment.

The process profile supports only the tested `/bin/sh` to `/bin/bash` startup
chain and shell builtins. Arbitrary external executables, nested toolchains,
PTY/login-shell behavior, XPC helpers, networking, process-fork policy, signal
management, and descendant lifecycle supervision are not supported or
validated. The explicit `/usr/bin/true` test demonstrates that an unlisted
nested executable is denied.
