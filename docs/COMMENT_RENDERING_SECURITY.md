# Comment rendering security policy

OneTeam stores Agent and system reports as Markdown by default. Raw HTML is supported only for structured reports and is sanitized in the renderer before it enters the DOM.

## Policy

- Executable and document-level elements such as `script`, `style`, `iframe`, `object`, `embed`, `link`, and `meta` are removed with their contents.
- Elements outside the formatting allowlist are unwrapped. Event handlers, IDs, application CSS classes, and `data-*` attributes are removed.
- Links may use local paths, page anchors, HTTP(S), or `mailto:`. URLs containing credentials, control characters, backslashes, or executable protocols are rejected.
- Images may use only same-origin HTTP(S) resources. Remote and `data:` images are rejected to avoid tracking and active SVG payloads. Accepted images are lazy-loaded with no referrer, and explicit dimensions are capped at 2,000 pixels.
- Inline CSS uses a presentation-only property allowlist. Resource functions, CSS escapes, custom properties, fixed positioning, oversized dimensions, and other injection-capable syntax are removed.

The pure URL, CSS, and image-dimension policy has unit coverage. The browser smoke test verifies the final DOM boundary, including removal of executable elements and unsafe attributes.
