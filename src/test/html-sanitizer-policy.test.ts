import { describe, expect, it } from "vitest";
import {
  isSafeImageDimension,
  isSafeRichTextUrl,
  sanitizeRichTextStyle
} from "../client/html-sanitizer-policy";

const origin = "http://127.0.0.1:4579";

describe("HTML comment sanitizer policy", () => {
  it("allows navigational links but rejects executable and credential-bearing URLs", () => {
    expect(isSafeRichTextUrl("/issues/1#comment-2", "link", origin)).toBe(true);
    expect(isSafeRichTextUrl("https://example.com/report", "link", origin)).toBe(true);
    expect(isSafeRichTextUrl("mailto:owner@example.com", "link", origin)).toBe(true);
    expect(isSafeRichTextUrl("javascript:alert(1)", "link", origin)).toBe(false);
    expect(isSafeRichTextUrl("https://user:secret@example.com", "link", origin)).toBe(false);
    expect(isSafeRichTextUrl("\\\\example.com/tracker", "link", origin)).toBe(false);
  });

  it("allows only same-origin image resources", () => {
    expect(isSafeRichTextUrl("/api/artifacts/42", "image", origin)).toBe(true);
    expect(isSafeRichTextUrl("https://example.com/tracker.png", "image", origin)).toBe(false);
    expect(isSafeRichTextUrl("data:image/svg+xml,<svg/>", "image", origin)).toBe(false);
    expect(isSafeRichTextUrl("javascript:alert(1)", "image", origin)).toBe(false);
  });

  it("retains bounded presentation styles and drops layout or resource injection", () => {
    expect(
      sanitizeRichTextStyle(
        "color: #0969da; display: grid; margin: 8px; position: fixed; background-image: url(https://example.com/a); width: 99999px; border: 1px solid #ddd"
      )
    ).toBe("color: #0969da; display: grid; margin: 8px; border: 1px solid #ddd");
    expect(sanitizeRichTextStyle("background-color: red; color: u\\72l(https://example.com/a); --secret: red")).toBe(
      "background-color: red"
    );
  });

  it("bounds explicit image dimensions", () => {
    expect(isSafeImageDimension("640")).toBe(true);
    expect(isSafeImageDimension("2000")).toBe(true);
    expect(isSafeImageDimension("0")).toBe(false);
    expect(isSafeImageDimension("2001")).toBe(false);
    expect(isSafeImageDimension("100%")).toBe(false);
  });
});
