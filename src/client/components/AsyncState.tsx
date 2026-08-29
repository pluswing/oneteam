import { CircleAlert, Inbox, LoaderCircle, RotateCcw } from "lucide-react";

export type AsyncStateKind = "loading" | "empty" | "error" | "retrying";

export function AsyncState(props: {
  kind: AsyncStateKind;
  message: string;
  compact?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const Icon = props.kind === "error"
    ? CircleAlert
    : props.kind === "empty"
      ? Inbox
      : props.kind === "retrying"
        ? RotateCcw
        : LoaderCircle;

  return (
    <div
      aria-live={props.kind === "loading" || props.kind === "retrying" ? "polite" : undefined}
      className={`async-state async-state-${props.kind}${props.compact ? " compact" : ""}`}
      role={props.kind === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className={props.kind === "loading" || props.kind === "retrying" ? "async-state-spinner" : undefined} size={20} />
      <span>{props.message}</span>
      {props.actionLabel && props.onAction ? (
        <button className="secondary-button" onClick={props.onAction} type="button">{props.actionLabel}</button>
      ) : null}
    </div>
  );
}
