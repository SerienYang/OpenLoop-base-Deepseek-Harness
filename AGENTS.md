# OpenLoop Engineering Rules

OpenLoop is an Apple Silicon macOS desktop product built on DeepSeek Harness.
DeepSeek Harness and Cordis remain the Agent and plugin runtime. OpenLoop adds
the Tauri Host, desktop product shell, security policy, lifecycle, recovery,
updates, and product plugins.

## Repository boundaries

- Keep upstream DSH code in its existing `apps/`, `packages/`, `native/`,
  `python/`, `vendor/`, `patches/`, and `examples/` paths.
- Put OpenLoop applications in `apps/openloop-*`.
- Put OpenLoop packages in `packages/openloop/*`.
- Put the bundled runtime closure in `runtime/openloop/`.
- Put OpenLoop build, policy, signing, and update tools in
  `scripts/openloop/`.
- Put product brand assets in `assets/brand/`.
- Do not add a second plugin runtime. Cordis owns plugin loading, dependency
  injection, events, services, and lifecycle.

## Security ownership

- The Tauri Host owns permissions, credentials, Workspace authorization,
  update verification, recovery, dirty state, and Workbench tab lifecycle.
- Plugins may request Host operations but cannot approve permissions, replace
  Host confirmation UI, hide dirty state, or discard unsaved content.
- API keys are write-only from browser UI. Plaintext credentials may only
  travel through the trusted Tauri and DSH Host credential path for one
  request.
- Remote pages and untrusted previews never receive OpenLoop system APIs.
- Never commit `.env` files, credentials, certificates, signing keys, updater
  private keys, logs, installers, build output, or user data.

## Required commands

Use the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm run knip
pnpm run typecheck
pnpm run lint
pnpm run verify-client-catalog
pnpm run verify-cordis-inspect-catalog
pnpm run verify-session-event-types
pnpm run verify-third-party-notices
pnpm run verify-translation-pairing
pnpm run build
pnpm run test
pnpm exec vitest run scripts/openloop/repository-layout.spec.ts
uv run --python 3.10 --group test --project python/sdk pytest
pnpm --dir native/landlock-run test
pnpm run verify-runtime-closure
pnpm run verify-dsh-package-licenses
```

Run focused tests during development. Run the complete matrix above before a
repository-layout or release change is declared complete.

## Change discipline

- Add behavior tests before production code and observe the expected failure.
- Keep DSH upstream changes separate from OpenLoop product changes.
- Import across packages by package name, not by relative traversal.
- Register every Cordis contribution with a disposer.
- Keep Host and Client compiler faces explicit.
- Use exact file paths in tests; zero executed tests is a failure.
- Do not use `.only` or unapproved skips.
- Keep generated binaries and installers out of Git.

## GitHub publishing

- `main` is the long-lived product branch.
- DSH upgrades enter through an immutable approved SHA and compatibility
  checks.
- Candidate App bundles stay inside the CI runner and are deleted after
  verification.
- Only verified release assets are attached to GitHub Releases.
- Never force-push `main`.
