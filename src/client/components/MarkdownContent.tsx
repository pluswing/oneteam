import ReactMarkdown from "react-markdown";
import type { CommentBodyFormat } from "../../shared/types";

export function MarkdownContent(props: { content: string; className?: string; format?: CommentBodyFormat }) {
  if (props.format === "html") {
    return (
      <div
        className={["markdown-body", "html-body", props.className].filter(Boolean).join(" ")}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(props.content) }}
      />
    );
  }

  return (
    <div className={["markdown-body", props.className].filter(Boolean).join(" ")}>
      <ReactMarkdown>{props.content}</ReactMarkdown>
    </div>
  );
}

const allowedTags = new Set([
  "a",
  "article",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul"
]);

const globalAttributes = new Set(["aria-label", "class", "title"]);
const allowedStyleProperties = new Set([
  "background",
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

function sanitizeHtml(input: string): string {
  const template = document.createElement("template");
  template.innerHTML = input;
  sanitizeChildren(template.content);
  return template.innerHTML;
}

function sanitizeChildren(parent: ParentNode): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as HTMLElement;
    const tagName = element.tagName.toLowerCase();
    if (!allowedTags.has(tagName)) {
      if (["script", "style", "iframe", "object", "embed", "link", "meta"].includes(tagName)) {
        element.remove();
        continue;
      }
      element.replaceWith(...Array.from(element.childNodes));
      sanitizeChildren(parent);
      continue;
    }

    sanitizeAttributes(element, tagName);
    sanitizeChildren(element);
  }
}

function sanitizeAttributes(element: HTMLElement, tagName: string): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;

    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "style") {
      const style = sanitizeStyle(value);
      if (style) {
        element.setAttribute("style", style);
      } else {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (name === "href" && tagName === "a") {
      if (isSafeUrl(value)) {
        element.setAttribute("rel", "noreferrer noopener");
      } else {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (name === "src" && tagName === "img") {
      if (!isSafeUrl(value)) {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (tagName === "img" && ["alt", "height", "width"].includes(name)) {
      continue;
    }
    if (globalAttributes.has(name) || name.startsWith("data-")) {
      continue;
    }
    element.removeAttribute(attribute.name);
  }
}

function sanitizeStyle(value: string): string {
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator === -1) {
        return false;
      }
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const cssValue = declaration.slice(separator + 1).trim().toLowerCase();
      return (
        allowedStyleProperties.has(property) &&
        !cssValue.includes("url(") &&
        !cssValue.includes("expression") &&
        !cssValue.includes("javascript:") &&
        !cssValue.includes("@import") &&
        !cssValue.includes("<") &&
        !cssValue.includes(">")
      );
    })
    .join("; ");
}

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return true;
  }
  try {
    const url = new URL(trimmed, window.location.origin);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}
