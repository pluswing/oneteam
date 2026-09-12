import ReactMarkdown from "react-markdown";
import type { CommentBodyFormat } from "../../shared/types";
import { isSafeImageDimension, isSafeRichTextUrl, sanitizeRichTextStyle } from "../html-sanitizer-policy";

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

const globalAttributes = new Set(["aria-label", "title"]);

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
      const style = sanitizeRichTextStyle(value);
      if (style) {
        element.setAttribute("style", style);
      } else {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (name === "href" && tagName === "a") {
      if (!isSafeRichTextUrl(value, "link", window.location.origin)) {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (name === "src" && tagName === "img") {
      if (!isSafeRichTextUrl(value, "image", window.location.origin)) {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (tagName === "img" && name === "alt") {
      continue;
    }
    if (tagName === "img" && ["height", "width"].includes(name)) {
      if (!isSafeImageDimension(value)) element.removeAttribute(attribute.name);
      continue;
    }
    if (globalAttributes.has(name)) {
      continue;
    }
    element.removeAttribute(attribute.name);
  }
  if (tagName === "a" && element.hasAttribute("href")) {
    element.setAttribute("rel", "noreferrer noopener");
  }
  if (tagName === "img" && element.hasAttribute("src")) {
    element.setAttribute("loading", "lazy");
    element.setAttribute("decoding", "async");
    element.setAttribute("referrerpolicy", "no-referrer");
  }
}
