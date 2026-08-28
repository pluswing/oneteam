export type RichTextUrlKind = "link" | "image";

const allowedStyleProperties = new Set([
  "background-color",
  "border",
  "border-color",
  "border-left",
  "border-radius",
  "color",
  "display",
  "font-size",
  "font-style",
  "font-weight",
  "gap",
  "grid-template-columns",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-top",
  "max-width",
  "padding",
  "text-align",
  "width"
]);

const unsafeCssSyntax = /[\\{}<>@]|\/\*|\*\/|(?:url|image|image-set|expression|var)\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i;
const dimensionPattern = /(-?\d*\.?\d+)\s*(px|em|rem|%|ch|vh|vw)/gi;

export function sanitizeRichTextStyle(value: string): string {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator === -1) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const cssValue = declaration.slice(separator + 1).trim();
      return allowedStyleProperties.has(property) && isSafeCssValue(property, cssValue);
    })
    .join("; ");
}

export function isSafeRichTextUrl(value: string, kind: RichTextUrlKind, baseOrigin: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\";
  })) return false;
  if (kind === "link" && trimmed.startsWith("#")) return true;

  try {
    const base = new URL(baseOrigin);
    const url = new URL(trimmed, base);
    if (url.username || url.password) return false;
    if (kind === "image") {
      return ["http:", "https:"].includes(url.protocol) && url.origin === base.origin;
    }
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isSafeImageDimension(value: string): boolean {
  return /^\d{1,4}$/.test(value) && Number(value) > 0 && Number(value) <= 2_000;
}

function isSafeCssValue(property: string, value: string): boolean {
  if (!value || value.length > 200 || unsafeCssSyntax.test(value)) return false;
  if (property === "display" && !["block", "flex", "grid", "inline", "inline-block"].includes(value.toLowerCase())) {
    return false;
  }
  if (property === "text-align" && !["left", "right", "center", "start", "end"].includes(value.toLowerCase())) {
    return false;
  }
  if (property === "font-style" && !["normal", "italic", "oblique"].includes(value.toLowerCase())) return false;
  if (
    property === "font-weight" &&
    !["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900"].includes(
      value.toLowerCase()
    )
  ) {
    return false;
  }

  dimensionPattern.lastIndex = 0;
  for (const match of value.matchAll(dimensionPattern)) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const maximum = unit === "px" ? 2_000 : unit === "ch" ? 200 : 100;
    if (!Number.isFinite(amount) || amount < 0 || amount > maximum) return false;
  }
  return true;
}
