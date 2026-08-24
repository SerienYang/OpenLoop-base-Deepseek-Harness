# Openloop Chat Text Zoom Design

## Goal

Add macOS text zoom shortcuts for the conversation transcript:

- `Command + Plus` and `Command + Equal` increase transcript text size.
- `Command + Minus` decreases transcript text size.
- `Command + 0` restores the default size.
- The selected size survives an application restart.

The sidebar, session header, composer, global controls, and message action
buttons must keep their existing dimensions.

## Ownership

Openloop owns the feature as a Cordis browser plugin under
`packages/openloop/chat-zoom`. The package is a private Client-face package and
is registered in `packages/openloop/bundle/cordis.patch.yml`.

The plugin owns:

- keyboard interpretation;
- the bounded zoom model;
- synchronization with the durable Host settings document;
- publishing the active scale to the document;
- lifecycle cleanup during Cordis disposal or HMR.

DSH remains the owner of transcript rendering. DSH receives only neutral,
default-safe CSS consumption points for transcript typography. These points
have a fallback scale of `1` and contain no Openloop state, persistence, or
keyboard logic. This keeps the product behavior in Openloop while avoiding
brittle selectors, DOM traversal, `MutationObserver`, and whole-WebView zoom.

## Zoom Model

The supported levels are:

`80%, 90%, 100%, 110%, 120%, 130%, 140%, 150%, 160%`

The default is `100%`. Increase and decrease operations clamp at the nearest
boundary. Reset always selects `100%`.

The persisted representation is an integer percentage in the Host-owned user
settings namespace `openloop-chat-zoom`, field `percent`. The schema accepts
only the supported levels and defaults to `100`. The browser binds that
namespace through `ctx.settingsScope`; it does not use `localStorage`, because
the loopback runtime may bind a different port on each launch and browser
storage is origin-scoped.

The browser applies a shortcut change immediately, then writes it through the
settings scope. Host reads that settle later reconcile the browser state.
Missing, malformed, or unavailable Host state falls back to `100%`. Following
the existing `SettingsScopeController` contract, a rejected write triggers a
Host recovery read; the browser then rolls back to the last durable value
rather than maintaining a second optimistic overlay.

## Keyboard Contract

The browser plugin installs one `keydown` listener on `document` while its
Cordis fiber is active.

It handles only events where:

- `metaKey` is true;
- `ctrlKey` and `altKey` are false;
- the key is `+`, `=`, `-`, `_`, or `0`.

`Shift` is accepted for `+` and `_`, because those characters share the
equal/minus physical keys on common keyboards. Input focus does not disable
the shortcut, matching normal macOS zoom behavior.

For recognized shortcuts the plugin calls `preventDefault()` so WebKit cannot
perform whole-page zoom. Unrecognized modifier combinations and ordinary
typing remain untouched.

## Presentation Contract

The plugin publishes the selected scale as
`--openloop-chat-text-scale` on `document.documentElement`. Before its first
write it captures any pre-existing inline value. Disposal restores that exact
value instead of unconditionally deleting another owner's property.

`ChatView.module.css` maps the product variable to a transcript-local
`--dsh-chat-text-scale` on `.column`. Shared primitives consume only the local
variable with a fallback of `1`, so the same Markdown components used outside
the transcript do not scale. The implementation explicitly covers:

- `MessageItem.module.css`: user/steering bubble text and transcript
  retry/error/compaction copy;
- `AssistantMarkdown.module.css`: assistant body and stopped marker;
- `ReasoningRow.module.css`: summary and expanded reasoning body;
- `ChatView.module.css`: running-turn, history, and load-error text;
- `MarkdownText.module.css`: body, headings, lists, tables, and inline code;
- `CodeBlock.module.css`: fenced-code `<pre>` content only.

Only typography values change: `font-size` and the corresponding `line-height`.
Container width, padding, gaps, icon size, image size, action button size,
sidebar geometry, header geometry, and composer geometry do not multiply by
the scale. The following are explicitly excluded: `MessageIconActions`,
code-block `.banner`, `.infostring`, `.action`, and `.copyButton`, attachment
chrome, the composer subtree, session header, sidebar, and details panel.

Text-bearing one-line transcript rows may grow vertically to fit their scaled
line height. Fixed `height: 24px` declarations on reasoning, compaction, and
similar text rows become `min-height: 24px`; text containers must not clip
vertically. Their icons, disclosure controls, and horizontal measurements stay
fixed. Existing ellipsis behavior remains only where the computed row height
can contain the scaled line box.

Where an existing rule uses a `font:` shorthand, the scaled `font-size` and
`line-height` declarations appear after the shorthand so they win the cascade.
The DSH CSS declarations use:

```css
calc(<base-size> * var(--openloop-chat-text-scale, 1))
```

The variable fallback preserves byte-equivalent visual behavior in ordinary
DSH builds where the Openloop plugin is absent.

## Package And Bundle Shape

Create the package through the repository scaffolder:

```sh
pnpm openloop:new-package -- \
  --name chat-zoom \
  --face client \
  --client-bundle \
  --bundle-row bundle
```

The generated bundle row registers `@openloop/chat-zoom` once. As with DSH's
`ui-theme` package, the default package entry is the Host half and the
`./client` export is the browser half:

- `src/settings.ts`: namespace, supported-value schema, and shared settings
  type;
- `src/index.ts`: registers the durable schema through the optional Host
  `settings` service; it does not declare a new service;
- `src/zoom.ts`: levels, validation, clamp/step/reset, and shortcut decoding;
- `src/client/index.ts`: binds `settingsScope`, applies immediate browser
  state, publishes CSS, registers the document listener, and owns disposal.

The browser entry declares `connection`, `remote`, and `settingsScope`
injections, matching the existing Host-settings transport. The package adds
the required settings and schema dependencies but no Tauri capability and no
security-sensitive Host command.

## Failure Handling

- Invalid Host state falls back to `100%` without throwing.
- Unavailable Host persistence keeps the default; a rejected write rolls back
  to the latest durable Host value without breaking the plugin.
- A missing document root is treated as a no-op presentation target in
  non-browser test environments.
- Repeated plugin activation after HMR must not accumulate listeners.
- Listener registration, settings subscription, and CSS publication are all
  owned by `ctx.effect(...)`.
- Cordis disposal removes the exact listener and restores the prior inline CSS
  property value.

## Verification

Follow test-first development.

Focused unit tests prove:

- every supported shortcut maps to the correct operation;
- unrelated keys and modifier combinations are ignored;
- stepping clamps at `80%` and `160%`;
- reset returns `100%`;
- valid Host state restores and invalid Host state falls back safely;
- failed Host writes trigger a recovery read and roll back to durable state;
- handled events prevent WebKit default zoom;
- disposal followed by reactivation leaves exactly one listener and restores
  the prior CSS property between activations.

Repository contract tests prove:

- the package is a Client-face private Cordis browser bundle;
- `tsconfig.client.json` contains the package exactly once;
- `@openloop/bundle` depends on the package;
- `cordis.patch.yml` registers exactly one `chat-zoom` row;
- DSH without the Openloop variable retains scale `1`;
- action button dimensions and non-conversation layout declarations remain
  unchanged.

An Openloop composition integration test presses every shortcut and asserts
computed typography changes for user text, Markdown headings, tables, fenced
code, reasoning, and status text. The same test asserts unchanged computed
dimensions for the sidebar, session header, composer, message action buttons,
images, and code-block banner/copy controls. At `160%`, reasoning and
compaction text rows must report a client height at least as large as their
computed line height and must not clip the line box.

A relaunch integration test starts two runtime instances on different
loopback ports against the same temporary user-settings document. The second
instance must restore the first instance's selected percentage, and
`Command + 0` must persist `100%` for a third launch.

Run the focused Openloop gate tests, relevant DSH client tests, typecheck,
lint, client catalog verification, bundle build, and repository layout
verification before completion.
