import ReactMarkdown from "react-markdown";

export function MarkdownContent(props: { content: string; className?: string }) {
  return (
    <div className={["markdown-body", props.className].filter(Boolean).join(" ")}>
      <ReactMarkdown>{props.content}</ReactMarkdown>
    </div>
  );
}
