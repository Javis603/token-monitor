# Native plugin icons and quota colors

Static manifest metadata supplies native artwork before author UI starts. It does not change plugin identity, register a built-in provider or grant capabilities. Declare optional `presentation` at plugin level; each `limits[]` module can override `icon` and/or `color` independently. An omitted module property inherits the plugin default.

```json
{
  "presentation": {
    "icon": { "native": "codex" },
    "color": { "palette": "codex" }
  },
  "limits": [
    { "id": "team", "name": "Team pool" },
    {
      "id": "personal",
      "name": "Personal pool",
      "presentation": {
        "icon": { "data": "data:image/svg+xml;base64,...", "mode": "mask" },
        "color": { "hex": "#8367db" }
      }
    }
  ]
}
```

Replace the abbreviated image data with a complete base64 image. `icon` chooses exactly one of:

- `{ "native": "codex" }`: an existing native mark. Accepted IDs come from `MARK_IDS` in `src/shared/vendorPresentation.js`. The host uses its bundled SVG and adaptive `currentColor` treatment, without copying artwork into the plugin.
- `{ "data": "data:image/png;base64,...", "mode": "image" }`: static PNG, preserving artwork colors. `image` is the default mode.
- `{ "data": "data:image/svg+xml;base64,...", "mode": "image" }`: static SVG, preserving artwork colors.
- `{ "data": "data:image/svg+xml;base64,...", "mode": "mask" }`: SVG alpha mask, tinted with the surrounding native text/icon color. Author fill colors do not survive mask mode. PNG mask mode is not supported.

Quota `color` chooses exactly one of `{ "palette": "codex" }` or `{ "hex": "#8367db" }`. Palette IDs come from `VENDOR_IDS` in the same native catalog. References resolve against the current App palette, including user vendor-color overrides and live previews; they do not capture today's default hex. Custom colors use six-digit HEX. Without a color declaration, native quotas use the existing default. This does not add plugin entries to the App's vendor-color picker.

Icons and quota colors are independent: a native mark remains adaptive, while bars use the resolved quota color. A multicolor image retains its own pixels. Native Limits and plugin management/import/catalog displays consume this metadata through the shared icon renderer. Existing plugin navigation consumers receive the same plugin default; this does not add quota modules to Home, Notch, Dock or other quota pickers.

## Static image boundary

`identityIcon` also accepts the same PNG/SVG base64 data URLs, as plugin-wide identity artwork. Explicit `presentation.icon` takes precedence. If that artwork cannot decode, the host tries `identityIcon`, then its existing named-icon/dot fallback. Remote URLs, package paths and inline SVG DOM are not accepted.

Each image is at most 64 KiB. PNG remains static RGB/RGBA, at most 256 × 256 pixels. SVG uses a deliberately limited drawing dialect, not arbitrary SVG sanitization:

- A single `svg` root with `xmlns="http://www.w3.org/2000/svg"` and a positive `viewBox`; optional numeric width/height are at most 256.
- Geometry: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`. At most 256 elements and 16 nesting levels.
- Geometry coordinates, standard numeric transforms, opacity, fill/stroke and line attributes are supported. Paint uses HEX, `black`, `white`, `transparent`, `none` or `currentColor`. Convert other named colors to HEX.
- No XML declarations, comments, entities, text/fonts, styles/classes, event handlers, animation, scripts, embedded content, links, `use`, definitions/gradients, filters or external resources. Outline text and flatten unsupported artwork before export, or use PNG.

Unsupported syntax rejects the manifest/catalog metadata rather than being silently stripped. Accepted SVG is loaded only as an image or CSS mask, never inserted with `innerHTML`, `object` or an iframe. Image decode failures still use the fallback. These presentation rules do not sandbox trusted plugin code running under the user's OS account.
