# OpenLoop Brand Assets

This directory contains the public source assets for the OpenLoop product
identity.

## Inventory

| File | Role | Source status |
|---|---|---|
| `openloop-icon.svg` | Master OpenLoop loop mark | Editable vector source |
| `openloop-dsh-hero.svg` | README hero artwork | Editable vector source |
| `openloop-dsh-hero.png` | Rendered README hero | Generated presentation asset |
| `openloop.tokens.json` | Brand and semantic color definitions | Design-token source of truth |

The loop mark is the current brand master, not a complete macOS application
icon set. Tauri `.icns` and platform-sized icon outputs will be generated when
the desktop application package is introduced.

## Design Tokens

`openloop.tokens.json` follows the
[DTCG Format Module 2025.10](https://www.designtokens.org/tr/2025.10/format/)
and uses the recommended `.tokens.json` extension.

The file has three layers:

1. `color.palette` contains concrete sRGB values.
2. `color.brand` defines stable OpenLoop ink, paper, line, and muted aliases.
3. `color.semantic.light` and `color.semantic.dark` define matching
   application roles for both themes.

Product code should consume semantic aliases. Brand artwork may consume brand
aliases. Concrete palette values are implementation primitives and should not
be referenced directly by product UI.

## Color Policy

- OpenLoop remains monochrome in both Light and Dark themes.
- Focus, active, selected, and informational states use neutral contrast,
  borders, and structure instead of a brand accent color.
- Green, amber, and red are reserved for success, warning, and danger.
- Color must not be the only signal for status or security-sensitive UI.
- Plugins cannot restyle trusted Host permission, recovery, or dirty-state
  confirmations outside the Host-selected theme.

## Current Boundary

This version defines color foundations only. Typography, spacing, elevation,
motion, component, and layout tokens will be added with the OpenLoop desktop
shell and reviewed as separate contracts.

Edit SVG sources rather than the rendered PNG. Keep internal explorations,
implementation plans, review reports, and test evidence outside the public
repository.
