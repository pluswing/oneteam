import { Check, ChevronDown, ChevronUp, FileCode2, Plus, Search } from "lucide-react";
import { Fragment, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  PullRequestFindingDto,
  PullRequestLineCommentDto,
  RepositoryFileChangeDto
} from "../../shared/types";
import { api } from "../api";
import { MarkdownContent } from "./MarkdownContent";
import {
  buildSplitDiffRows,
  diffAnchorMatchesPath,
  diffFileAnchor,
  diffLineAnchor,
  diffWordSegments,
  limitDiffHunks,
  parseDiffPatch,
  type DiffLineFocus,
  type DiffLine,
  type SplitDiffRow,
  type DiffWordSegment
} from "../diff-parser";
import { calculateDiffVirtualRange, type DiffVirtualRange } from "../diff-virtualization";
import { t } from "../i18n";
import { AsyncState } from "./AsyncState";
import { highlightDiffSyntax } from "../diff-syntax";
import { formatDateTime } from "../formatters";

type DiffView = "unified" | "split";
type LineCommentPosition = { path: string; line: number; side: "L" | "R" };
const initialDiffRenderLines = 1_000;
const diffRenderIncrement = 1_000;
const maximumDiffRenderLines = 5_000;
const diffVirtualizationThreshold = 300;
const diffVirtualRowHeight = 24;
const diffVirtualOverscan = 30;
const diffVirtualDefaultViewportHeight = 480;

function storageKey(projectId: string, pullRequestId: number): string {
  return `oneteam:diff-viewed:${projectId}:${pullRequestId}`;
}

function readViewedPaths(key: string): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeViewedPaths(key: string, paths: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(paths)));
  } catch {
    // The diff remains usable when storage is unavailable or full.
  }
}

function fileStatusLabel(status: string): string {
  if (status.startsWith("A")) return t("pullRequests.diffStatusAdded");
  if (status.startsWith("D")) return t("pullRequests.diffStatusDeleted");
  if (status.startsWith("R")) return t("pullRequests.diffStatusRenamed");
  if (status.startsWith("C")) return t("pullRequests.diffStatusCopied");
  return t("pullRequests.diffStatusModified");
}

function fileStatusClass(status: string): string {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R") || status.startsWith("C")) return "renamed";
  return "modified";
}

function LineNumber(props: {
  onComment: (position: LineCommentPosition) => void;
  path: string;
  side: "L" | "R";
  value: number | null;
}) {
  if (props.value === null) {
    return <span aria-hidden="true" />;
  }
  const anchor = diffLineAnchor(props.path, props.side, props.value);
  const lineLabel = `${props.side === "L" ? t("pullRequests.oldLine") : t("pullRequests.newLine")} ${props.value}`;
  return (
    <span className="diff-line-number-content">
      <button
        aria-label={`${t("pullRequests.commentOnLine")} ${lineLabel}`}
        className="diff-add-comment"
        onClick={() => props.onComment({ path: props.path, side: props.side, line: props.value! })}
        title={t("pullRequests.commentOnLine")}
        type="button"
      >
        <Plus aria-hidden="true" size={13} />
      </button>
      <a aria-label={lineLabel} href={`#${anchor}`} id={anchor}>{props.value}</a>
    </span>
  );
}

function WordSegments(props: { segments: DiffWordSegment[] }) {
  return (
    <>
      {props.segments.map((segment, index) => (
        <span className={segment.changed ? "diff-word-changed" : undefined} key={`${index}-${segment.value}`}>
          {segment.value}
        </span>
      ))}
    </>
  );
}

function SyntaxLine(props: { content: string; path: string }) {
  const tokens = highlightDiffSyntax(props.path, props.content);
  return (
    <>
      {tokens.map((token, index) => (
        <span className={token.kind === "plain" ? undefined : `syntax-${token.kind}`} key={`${index}-${token.value}`}>
          {token.value}
        </span>
      ))}
    </>
  );
}

function findingLineLabel(finding: PullRequestFindingDto): string {
  return finding.line ? `${finding.side}${finding.line}` : t("pullRequests.fileFinding");
}

function FindingCard(props: { finding: PullRequestFindingDto; onOpen?: () => void }) {
  const content = (
    <>
      <span className={`diff-finding-severity severity-${props.finding.severity}`}>{props.finding.severity}</span>
      <span className="diff-finding-source">{props.finding.source} #{props.finding.agentJobId}</span>
      <strong>{props.finding.title}</strong>
      {props.finding.body ? <span className="diff-finding-body">{props.finding.body}</span> : null}
      <span className={`diff-finding-status status-${props.finding.status}`}>
        {props.finding.status === "resolved" ? t("pullRequests.findingResolved") : t("pullRequests.findingOpen")}
      </span>
      <span className="diff-finding-line">{findingLineLabel(props.finding)}</span>
    </>
  );
  return props.onOpen ? (
    <button className={`diff-finding-card status-${props.finding.status}`} onClick={props.onOpen} type="button">
      {content}
    </button>
  ) : (
    <div className={`diff-finding-card status-${props.finding.status}`}>{content}</div>
  );
}

function LineCommentCard(props: { comment: PullRequestLineCommentDto }) {
  return (
    <article className="diff-line-comment" id={`diff-comment-${props.comment.id}`}>
      <header>
        <strong>{t("pullRequests.you")}</strong>
        <span>{formatDateTime(props.comment.createdAt)}</span>
        <a href={`#${diffLineAnchor(props.comment.path, props.comment.side, props.comment.line)}`}>
          {props.comment.side}{props.comment.line}
        </a>
      </header>
      <MarkdownContent content={props.comment.body} format={props.comment.bodyFormat} />
    </article>
  );
}

function LineCommentComposer(props: { onCancel: () => void; onSubmit: (body: string) => Promise<void> }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const value = body.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSubmit(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("pullRequests.lineCommentFailed"));
      setSaving(false);
    }
  }

  return (
    <form className="diff-line-comment-form" onSubmit={(event) => void submit(event)}>
      <textarea
        autoFocus
        disabled={saving}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit();
        }}
        placeholder={t("pullRequests.lineCommentPlaceholder")}
        rows={3}
        value={body}
      />
      {error ? <div className="diff-line-comment-error" role="alert">{error}</div> : null}
      <div className="diff-line-comment-actions">
        <span>{t("pullRequests.markdownSupported")}</span>
        <button className="secondary-button" disabled={saving} onClick={props.onCancel} type="button">
          {t("actions.cancel")}
        </button>
        <button className="primary-button" disabled={saving || !body.trim()} type="submit">
          {saving ? t("pullRequests.savingComment") : t("pullRequests.addLineComment")}
        </button>
      </div>
    </form>
  );
}

function InlineDiscussionRows(props: {
  colSpan: number;
  comments: PullRequestLineCommentDto[];
  draft: boolean;
  findings: PullRequestFindingDto[];
  onCancelComment: () => void;
  onSubmitComment: (body: string) => Promise<void>;
}) {
  if (!props.findings.length && !props.comments.length && !props.draft) return null;
  return (
    <tr className="diff-discussion-row">
      <td colSpan={props.colSpan}>
        <div className="diff-discussion-stack">
          {props.findings.map((finding) => <FindingCard finding={finding} key={finding.id} />)}
          {props.comments.map((comment) => <LineCommentCard comment={comment} key={comment.id} />)}
          {props.draft ? <LineCommentComposer onCancel={props.onCancelComment} onSubmit={props.onSubmitComment} /> : null}
        </div>
      </td>
    </tr>
  );
}

function findingsForLine(findings: PullRequestFindingDto[], line: DiffLine): PullRequestFindingDto[] {
  return findings.filter((finding) =>
    finding.line !== null &&
    (finding.side === "L" ? line.oldLineNumber === finding.line : line.newLineNumber === finding.line)
  );
}

function lineCommentsForLine(comments: PullRequestLineCommentDto[], line: DiffLine): PullRequestLineCommentDto[] {
  return comments.filter((comment) =>
    comment.side === "L" ? line.oldLineNumber === comment.line : line.newLineNumber === comment.line
  );
}

function positionMatchesLine(position: LineCommentPosition | null, line: DiffLine): boolean {
  if (!position) return false;
  return position.side === "L" ? line.oldLineNumber === position.line : line.newLineNumber === position.line;
}

type DiffDiscussionProps = {
  comments: PullRequestLineCommentDto[];
  draft: LineCommentPosition | null;
  findings: PullRequestFindingDto[];
  focus: DiffLineFocus | null;
  onCancelComment: () => void;
  onStartComment: (position: LineCommentPosition) => void;
  onSubmitComment: (body: string) => Promise<void>;
  path: string;
  patch: string;
};

function useRenderedDiff(patch: string, focus: DiffLineFocus | null) {
  const parsed = useMemo(() => parseDiffPatch(patch), [patch]);
  const [lineLimit, setLineLimit] = useState(initialDiffRenderLines);
  useEffect(() => setLineLimit(initialDiffRenderLines), [patch]);
  const limited = useMemo(() => limitDiffHunks(parsed.hunks, lineLimit, focus), [focus, lineLimit, parsed.hunks]);
  return { parsed, limited, lineLimit, setLineLimit };
}

function DiffRenderFooter(props: {
  lineLimit: number;
  renderedLines: number;
  setLineLimit: (value: number) => void;
  totalLines: number;
  truncated: boolean;
}) {
  if (!props.truncated) return null;
  const canRenderMore = props.lineLimit < maximumDiffRenderLines;
  return (
    <div className="diff-render-footer">
      <span>
        {t("pullRequests.renderedDiffLines")} {props.renderedLines.toLocaleString()} / {props.totalLines.toLocaleString()}
      </span>
      {canRenderMore ? (
        <button
          className="secondary-button"
          onClick={() => props.setLineLimit(Math.min(props.lineLimit + diffRenderIncrement, maximumDiffRenderLines))}
          type="button"
        >
          {t("pullRequests.renderMoreDiff")}
        </button>
      ) : (
        <span>{t("pullRequests.diffRenderLimitReached")}</span>
      )}
    </div>
  );
}

function DiffHunkHeader(props: {
  collapsed: boolean;
  colSpan: number;
  header: string;
  onToggle: () => void;
}) {
  return (
    <tr className="diff-hunk-row">
      <td colSpan={props.colSpan}>
        <button aria-expanded={!props.collapsed} onClick={props.onToggle} type="button">
          <ChevronDown aria-hidden="true" className={props.collapsed ? "collapsed" : ""} size={14} />
          <span>{props.header}</span>
          <span className="diff-hunk-action">
            {props.collapsed ? t("pullRequests.expandHunk") : t("pullRequests.collapseHunk")}
          </span>
        </button>
      </td>
    </tr>
  );
}

function useCollapsedHunks(patch: string) {
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsedHunks(new Set()), [patch]);
  function toggleHunk(key: string): void {
    setCollapsedHunks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  return { collapsedHunks, toggleHunk };
}

function useVirtualDiffRows(itemCount: number, resetKey: string, focusIndex: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<DiffVirtualRange>(() => calculateDiffVirtualRange({
    itemCount,
    scrollTop: 0,
    viewportHeight: diffVirtualDefaultViewportHeight,
    estimatedRowHeight: diffVirtualRowHeight,
    overscan: diffVirtualOverscan
  }));
  const virtualized = itemCount > diffVirtualizationThreshold;

  function updateRange(element = scrollRef.current): void {
    if (!element) return;
    setRange(calculateDiffVirtualRange({
      itemCount,
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight || diffVirtualDefaultViewportHeight,
      estimatedRowHeight: diffVirtualRowHeight,
      overscan: diffVirtualOverscan
    }));
  }

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = 0;
    setRange(calculateDiffVirtualRange({
      itemCount,
      scrollTop: 0,
      viewportHeight: element?.clientHeight || diffVirtualDefaultViewportHeight,
      estimatedRowHeight: diffVirtualRowHeight,
      overscan: diffVirtualOverscan
    }));
  }, [resetKey]);

  useEffect(() => {
    if (!virtualized) return;
    updateRange();
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateRange(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [itemCount, virtualized]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!virtualized || !element || focusIndex < 0) return;
    element.scrollTop = Math.max(0, focusIndex * diffVirtualRowHeight - element.clientHeight / 2);
    updateRange(element);
  }, [focusIndex, virtualized]);

  return {
    scrollRef,
    virtualized,
    range: virtualized ? range : {
      start: 0,
      end: itemCount,
      beforeHeight: 0,
      afterHeight: 0
    },
    updateRange
  };
}

function DiffVirtualSpacer(props: { colSpan: number; height: number }) {
  if (props.height <= 0) return null;
  return (
    <tr aria-hidden="true" className="diff-virtual-spacer">
      <td colSpan={props.colSpan} style={{ height: props.height }} />
    </tr>
  );
}

function DiffVirtualizationStatus(props: { range: DiffVirtualRange; total: number; virtualized: boolean }) {
  if (!props.virtualized) return null;
  return (
    <div aria-live="polite" className="diff-virtual-status">
      {t("pullRequests.virtualizedDiffRows")} {props.range.start + 1}–{props.range.end} / {props.total.toLocaleString()}
    </div>
  );
}

type UnifiedVirtualItem =
  | { kind: "hunk"; key: string; header: string; hunkKey: string }
  | { kind: "line"; key: string; line: DiffLine };

function UnifiedDiff(props: DiffDiscussionProps) {
  const { parsed, limited, lineLimit, setLineLimit } = useRenderedDiff(props.patch, props.focus);
  const { collapsedHunks, toggleHunk } = useCollapsedHunks(props.patch);
  const items = useMemo(() => limited.hunks.flatMap<UnifiedVirtualItem>((hunk, hunkIndex) => {
    const hunkKey = `${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`;
    return [
      { kind: "hunk", key: `hunk:${hunkKey}`, header: hunk.header, hunkKey },
      ...(collapsedHunks.has(hunkKey) ? [] : hunk.lines.map((line, lineIndex) => ({
        kind: "line" as const,
        key: `line:${hunkKey}:${lineIndex}`,
        line
      })))
    ];
  }), [collapsedHunks, limited.hunks]);
  const focus = props.focus;
  const focusIndex = focus ? items.findIndex((item) => item.kind === "line" && (
    focus.side === "L" ? item.line.oldLineNumber === focus.line : item.line.newLineNumber === focus.line
  )) : -1;
  const virtual = useVirtualDiffRows(items.length, props.patch, focusIndex);
  if (parsed.binary) {
    return <div className="diff-notice">{t("pullRequests.binaryDiff")}</div>;
  }
  if (!parsed.hunks.length) {
    return <div className="diff-notice">{t("pullRequests.noVisibleDiff")}</div>;
  }
  return (
    <div className="diff-table-region">
      <div className="diff-table-scroll" onScroll={() => virtual.updateRange()} ref={virtual.scrollRef}>
        <table className="diff-table diff-unified">
          <tbody>
            <DiffVirtualSpacer colSpan={3} height={virtual.range.beforeHeight} />
            {items.slice(virtual.range.start, virtual.range.end).map((item) => {
              if (item.kind === "hunk") {
                return <DiffHunkHeader collapsed={collapsedHunks.has(item.hunkKey)} colSpan={3} header={item.header} key={item.key} onToggle={() => toggleHunk(item.hunkKey)} />;
              }
              const lineFindings = findingsForLine(props.findings, item.line);
              const lineComments = lineCommentsForLine(props.comments, item.line);
              return (
                  <Fragment key={item.key}>
                    <tr className={`diff-line diff-line-${item.line.kind}`}>
                      <td className="diff-line-number"><LineNumber onComment={props.onStartComment} path={props.path} side="L" value={item.line.oldLineNumber} /></td>
                      <td className="diff-line-number"><LineNumber onComment={props.onStartComment} path={props.path} side="R" value={item.line.newLineNumber} /></td>
                      <td className="diff-code">
                        <code><span className="diff-prefix" aria-hidden="true">{item.line.kind === "addition" ? "+" : item.line.kind === "deletion" ? "-" : " "}</span><SyntaxLine content={item.line.content} path={props.path} /></code>
                      </td>
                    </tr>
                    <InlineDiscussionRows
                      colSpan={3}
                      comments={lineComments}
                      draft={props.draft?.path === props.path && positionMatchesLine(props.draft, item.line)}
                      findings={lineFindings}
                      onCancelComment={props.onCancelComment}
                      onSubmitComment={props.onSubmitComment}
                    />
                  </Fragment>
              );
            })}
            <DiffVirtualSpacer colSpan={3} height={virtual.range.afterHeight} />
          </tbody>
        </table>
      </div>
      <DiffVirtualizationStatus range={virtual.range} total={items.length} virtualized={virtual.virtualized} />
      <DiffRenderFooter
        lineLimit={lineLimit}
        renderedLines={limited.renderedLines}
        setLineLimit={setLineLimit}
        totalLines={limited.totalLines}
        truncated={limited.truncated}
      />
    </div>
  );
}

function splitContent(line: DiffLine | null, other: DiffLine | null, side: "before" | "after", path: string) {
  if (!line) {
    return null;
  }
  if (other && line.kind === "deletion" && other.kind === "addition") {
    const segments = diffWordSegments(line.content, other.content);
    return <WordSegments segments={segments[side]} />;
  }
  return <SyntaxLine content={line.content} path={path} />;
}

function SplitDiff(props: DiffDiscussionProps) {
  const { parsed, limited, lineLimit, setLineLimit } = useRenderedDiff(props.patch, props.focus);
  const { collapsedHunks, toggleHunk } = useCollapsedHunks(props.patch);
  type SplitVirtualItem =
    | { kind: "hunk"; key: string; header: string; hunkKey: string }
    | { kind: "line"; key: string; row: SplitDiffRow };
  const items = useMemo(() => limited.hunks.flatMap<SplitVirtualItem>((hunk, hunkIndex) => {
    const hunkKey = `${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`;
    return [
      { kind: "hunk", key: `hunk:${hunkKey}`, header: hunk.header, hunkKey },
      ...(collapsedHunks.has(hunkKey) ? [] : buildSplitDiffRows(hunk.lines).map((row, rowIndex) => ({
        kind: "line" as const,
        key: `line:${hunkKey}:${rowIndex}`,
        row
      })))
    ];
  }), [collapsedHunks, limited.hunks]);
  const focus = props.focus;
  const focusIndex = focus ? items.findIndex((item) => item.kind === "line" && (
    focus.side === "L" ? item.row.left?.oldLineNumber === focus.line : item.row.right?.newLineNumber === focus.line
  )) : -1;
  const virtual = useVirtualDiffRows(items.length, props.patch, focusIndex);
  if (parsed.binary) {
    return <div className="diff-notice">{t("pullRequests.binaryDiff")}</div>;
  }
  if (!parsed.hunks.length) {
    return <div className="diff-notice">{t("pullRequests.noVisibleDiff")}</div>;
  }
  return (
    <div className="diff-table-region">
      <div className="diff-table-scroll" onScroll={() => virtual.updateRange()} ref={virtual.scrollRef}>
        <table className="diff-table diff-split">
          <tbody>
            <DiffVirtualSpacer colSpan={4} height={virtual.range.beforeHeight} />
            {items.slice(virtual.range.start, virtual.range.end).map((item) => {
              if (item.kind === "hunk") {
                return <DiffHunkHeader collapsed={collapsedHunks.has(item.hunkKey)} colSpan={4} header={item.header} key={item.key} onToggle={() => toggleHunk(item.hunkKey)} />;
              }
              const row = item.row;
                const lineFindings = props.findings.filter((finding) => {
                  if (finding.line === null) return false;
                  return finding.side === "L"
                    ? row.left?.oldLineNumber === finding.line
                    : row.right?.newLineNumber === finding.line;
                });
                const lineComments = props.comments.filter((comment) => comment.side === "L"
                  ? row.left?.oldLineNumber === comment.line
                  : row.right?.newLineNumber === comment.line
                );
                const hasDraft = props.draft?.path === props.path && (props.draft.side === "L"
                  ? row.left?.oldLineNumber === props.draft.line
                  : row.right?.newLineNumber === props.draft.line
                );
                return (
                <Fragment key={item.key}>
                <tr className="diff-split-row">
                  <td className={`diff-line-number diff-line-${row.left?.kind ?? "empty"}`}>
                    <LineNumber onComment={props.onStartComment} path={props.path} side="L" value={row.left?.oldLineNumber ?? null} />
                  </td>
                  <td className={`diff-code diff-line-${row.left?.kind ?? "empty"}`}>
                    <code>{row.left ? <><span className="diff-prefix" aria-hidden="true">{row.left.kind === "deletion" ? "-" : " "}</span>{splitContent(row.left, row.right, "before", props.path)}</> : null}</code>
                  </td>
                  <td className={`diff-line-number diff-line-${row.right?.kind ?? "empty"}`}>
                    <LineNumber onComment={props.onStartComment} path={props.path} side="R" value={row.right?.newLineNumber ?? null} />
                  </td>
                  <td className={`diff-code diff-line-${row.right?.kind ?? "empty"}`}>
                    <code>{row.right ? <><span className="diff-prefix" aria-hidden="true">{row.right.kind === "addition" ? "+" : " "}</span>{splitContent(row.right, row.left, "after", props.path)}</> : null}</code>
                  </td>
                </tr>
                <InlineDiscussionRows
                  colSpan={4}
                  comments={lineComments}
                  draft={hasDraft}
                  findings={lineFindings}
                  onCancelComment={props.onCancelComment}
                  onSubmitComment={props.onSubmitComment}
                />
                </Fragment>
              );
            })}
            <DiffVirtualSpacer colSpan={4} height={virtual.range.afterHeight} />
          </tbody>
        </table>
      </div>
      <DiffVirtualizationStatus range={virtual.range} total={items.length} virtualized={virtual.virtualized} />
      <DiffRenderFooter
        lineLimit={lineLimit}
        renderedLines={limited.renderedLines}
        setLineLimit={setLineLimit}
        totalLines={limited.totalLines}
        truncated={limited.truncated}
      />
    </div>
  );
}

export function DiffViewer(props: {
  projectId: string;
  pullRequestId: number;
  files: RepositoryFileChangeDto[];
  findings: PullRequestFindingDto[];
  lineComments: PullRequestLineCommentDto[];
  sourceCommit: string | null;
  targetCommit: string | null;
}) {
  const viewedStorageKey = storageKey(props.projectId, props.pullRequestId);
  const [selectedPath, setSelectedPath] = useState<string | null>(props.files[0]?.path ?? null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DiffView>("unified");
  const [context, setContext] = useState<"default" | "wide" | "full">("default");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [showResolvedFindings, setShowResolvedFindings] = useState(false);
  const [focusedFinding, setFocusedFinding] = useState<PullRequestFindingDto | null>(null);
  const [draftComment, setDraftComment] = useState<LineCommentPosition | null>(null);
  const [lineComments, setLineComments] = useState(props.lineComments);
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(() => readViewedPaths(viewedStorageKey));
  const [selectedFile, setSelectedFile] = useState<RepositoryFileChangeDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diffCache = useRef(new Map<string, RepositoryFileChangeDto>());

  useEffect(() => {
    setViewedPaths(readViewedPaths(viewedStorageKey));
  }, [viewedStorageKey]);

  useEffect(() => {
    setLineComments(props.lineComments);
  }, [props.lineComments]);

  useEffect(() => {
    setDraftComment(null);
  }, [props.sourceCommit, props.targetCommit, selectedPath]);

  useEffect(() => {
    if (!selectedPath || !props.files.some((file) => file.path === selectedPath)) {
      setSelectedPath(props.files[0]?.path ?? null);
    }
  }, [props.files, selectedPath]);

  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    const linkedFile = anchor ? props.files.find((file) => diffAnchorMatchesPath(anchor, file.path)) : undefined;
    if (linkedFile) {
      setSelectedPath(linkedFile.path);
    }
  }, [props.files]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }
    const anchor = window.location.hash.slice(1);
    if (!anchor || !diffAnchorMatchesPath(anchor, selectedFile.path)) {
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [selectedFile]);

  useEffect(() => {
    if (!selectedPath || !props.sourceCommit || !props.targetCommit) {
      setSelectedFile(null);
      return;
    }
    const cacheKey = [props.sourceCommit, props.targetCommit, selectedPath, context, ignoreWhitespace].join(":");
    const cached = diffCache.current.get(cacheKey);
    if (cached) {
      setSelectedFile(cached);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    void api
      .getPullRequestFileDiff(props.projectId, props.pullRequestId, selectedPath, {
        context,
        ignoreWhitespace,
        signal: controller.signal,
        sourceCommit: props.sourceCommit,
        targetCommit: props.targetCommit
      })
      .then((file) => {
        if (!controller.signal.aborted) {
          if (diffCache.current.size >= 30) {
            const oldestKey = diffCache.current.keys().next().value;
            if (oldestKey) {
              diffCache.current.delete(oldestKey);
            }
          }
          diffCache.current.set(cacheKey, file);
          setSelectedFile(file);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : t("pullRequests.diffLoadFailed"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [context, ignoreWhitespace, props.projectId, props.pullRequestId, props.sourceCommit, props.targetCommit, selectedPath]);

  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? props.files.filter((file) => `${file.previousPath ?? ""} ${file.path}`.toLocaleLowerCase().includes(normalized))
      : props.files;
  }, [props.files, query]);
  const selectedIndex = props.files.findIndex((file) => file.path === selectedPath);
  const currentSummary = selectedIndex >= 0 ? props.files[selectedIndex] : null;
  const viewedCount = props.files.filter((file) => viewedPaths.has(file.path)).length;
  const displayedFindings = props.findings.filter((finding) =>
    (showResolvedFindings || finding.status === "open") &&
    currentSummary &&
    (finding.path === currentSummary.path || finding.path === currentSummary.previousPath)
  );
  const revisionLineComments = lineComments.filter((comment) =>
    comment.sourceCommit === props.sourceCommit && comment.targetCommit === props.targetCommit
  );
  const displayedLineComments = revisionLineComments.filter((comment) =>
    currentSummary && (comment.path === currentSummary.path || comment.path === currentSummary.previousPath)
  );
  const openFindingCount = props.findings.filter((finding) => finding.status === "open").length;
  const resolvedFindingCount = props.findings.length - openFindingCount;

  useEffect(() => {
    function handleKeyboardNavigation(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) {
        return;
      }
      const offset = event.key.toLowerCase() === "j" ? 1 : event.key.toLowerCase() === "k" ? -1 : 0;
      const next = offset ? props.files[selectedIndex + offset] : null;
      if (next) {
        event.preventDefault();
        selectFile(next.path);
      }
    }
    window.addEventListener("keydown", handleKeyboardNavigation);
    return () => window.removeEventListener("keydown", handleKeyboardNavigation);
  }, [props.files, selectedIndex]);

  function selectFile(path: string): void {
    setFocusedFinding(null);
    setDraftComment(null);
    setSelectedPath(path);
    const anchor = diffFileAnchor(path);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${anchor}`);
  }

  function moveSelection(offset: number): void {
    const next = props.files[selectedIndex + offset];
    if (next) {
      selectFile(next.path);
    }
  }

  function toggleViewed(): void {
    if (!selectedPath) return;
    setViewedPaths((current) => {
      const next = new Set(current);
      if (next.has(selectedPath)) next.delete(selectedPath);
      else next.add(selectedPath);
      writeViewedPaths(viewedStorageKey, next);
      return next;
    });
  }

  function openFinding(finding: PullRequestFindingDto): void {
    if (!currentSummary || finding.line === null) return;
    const anchor = diffLineAnchor(currentSummary.path, finding.side, finding.line);
    setFocusedFinding(finding);
    setContext("full");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${anchor}`);
    window.requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "center" }));
  }

  function startLineComment(position: LineCommentPosition): void {
    setDraftComment(position);
    const anchor = diffLineAnchor(position.path, position.side, position.line);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${anchor}`);
  }

  async function submitLineComment(body: string): Promise<void> {
    if (!draftComment || !props.sourceCommit || !props.targetCommit) {
      throw new Error(t("pullRequests.diffRefreshRequired"));
    }
    const comment = await api.createPullRequestLineComment(props.projectId, props.pullRequestId, {
      body,
      ...draftComment,
      sourceCommit: props.sourceCommit,
      targetCommit: props.targetCommit
    });
    setLineComments((current) => [...current.filter((candidate) => candidate.id !== comment.id), comment]);
    setDraftComment(null);
  }

  return (
    <section className="diff-viewer" aria-label={t("pullRequests.filesChanged")}>
      <div className="diff-toolbar">
        <div className="diff-progress">
          <strong>{props.files.length} {t("pullRequests.files")}</strong>
          <span>{viewedCount}/{props.files.length} {t("pullRequests.viewed")}</span>
          <span className="diff-progress-track" aria-hidden="true"><span style={{ width: `${props.files.length ? (viewedCount / props.files.length) * 100 : 0}%` }} /></span>
        </div>
        <div className="diff-toolbar-actions">
          <div className="segmented-control" aria-label={t("pullRequests.diffLayout")}>
            <button className={view === "unified" ? "active" : ""} onClick={() => setView("unified")} type="button">{t("pullRequests.unified")}</button>
            <button className={view === "split" ? "active" : ""} onClick={() => setView("split")} type="button">{t("pullRequests.split")}</button>
          </div>
          <label className="diff-context-control">
            <span>{t("pullRequests.context")}</span>
            <select onChange={(event) => setContext(event.target.value as "default" | "wide" | "full")} value={context}>
              <option value="default">{t("pullRequests.contextDefault")}</option>
              <option value="wide">{t("pullRequests.contextWide")}</option>
              <option value="full">{t("pullRequests.contextFull")}</option>
            </select>
          </label>
          <label className="diff-checkbox"><input checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} type="checkbox" />{t("pullRequests.ignoreWhitespace")}</label>
          {resolvedFindingCount ? <label className="diff-checkbox"><input checked={showResolvedFindings} onChange={(event) => setShowResolvedFindings(event.target.checked)} type="checkbox" />{t("pullRequests.showResolvedFindings")}</label> : null}
        </div>
      </div>
      <div className="diff-workspace">
        <aside className="diff-file-panel">
          <label className="diff-search">
            <Search aria-hidden="true" size={15} />
            <span className="sr-only">{t("pullRequests.searchFiles")}</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder={t("pullRequests.searchFiles")} type="search" value={query} />
          </label>
          <div className="diff-file-list">
            {filteredFiles.map((file) => (
              <button className={file.path === selectedPath ? "active" : ""} key={file.path} onClick={() => selectFile(file.path)} type="button">
                <span className={`diff-file-status status-${fileStatusClass(file.status)}`} title={fileStatusLabel(file.status)}>{file.status.charAt(0)}</span>
                <span className="diff-file-name"><span>{file.path}</span>{file.previousPath ? <small>{file.previousPath}</small> : null}</span>
                <span className="diff-file-stats"><span className="addition">+{file.additions}</span><span className="deletion">−{file.deletions}</span></span>
                <span className="diff-file-indicators">
                  {props.findings.some((finding) => finding.status === "open" && (finding.path === file.path || finding.path === file.previousPath)) ? (
                    <span className="diff-finding-count" title={t("pullRequests.openFindings")}>
                      {props.findings.filter((finding) => finding.status === "open" && (finding.path === file.path || finding.path === file.previousPath)).length}
                    </span>
                  ) : null}
                  {revisionLineComments.some((comment) => comment.path === file.path || comment.path === file.previousPath) ? (
                    <span className="diff-comment-count" title={t("pullRequests.lineComments")}>
                      {revisionLineComments.filter((comment) => comment.path === file.path || comment.path === file.previousPath).length}
                    </span>
                  ) : null}
                  {viewedPaths.has(file.path) ? <Check aria-label={t("pullRequests.viewed")} className="diff-viewed-icon" size={15} /> : null}
                </span>
              </button>
            ))}
            {!filteredFiles.length ? <div className="diff-file-empty">{t("pullRequests.noMatchingFiles")}</div> : null}
          </div>
        </aside>
        <div className="diff-file-content">
          {currentSummary ? (
            <header className="diff-file-header" id={diffFileAnchor(currentSummary.path)}>
              <div className="diff-file-title">
                <FileCode2 aria-hidden="true" size={16} />
                <div><strong>{currentSummary.path}</strong>{currentSummary.previousPath ? <small>{currentSummary.previousPath} → {currentSummary.path}</small> : null}</div>
                <span className={`diff-status-label status-${fileStatusClass(currentSummary.status)}`}>{fileStatusLabel(currentSummary.status)}</span>
                {currentSummary.binary ? <span className="diff-binary-label">{t("pullRequests.binary")}</span> : null}
                {displayedFindings.length ? <span className="diff-header-finding-count">{displayedFindings.length} {t("pullRequests.findings")}</span> : null}
                {displayedLineComments.length ? <span className="diff-header-comment-count">{displayedLineComments.length} {t("pullRequests.lineComments")}</span> : null}
              </div>
              <div className="diff-file-actions">
                <span className="diff-file-stats"><span className="addition">+{currentSummary.additions}</span><span className="deletion">−{currentSummary.deletions}</span></span>
                <button aria-keyshortcuts="k" aria-label={t("pullRequests.previousFile")} disabled={selectedIndex <= 0} onClick={() => moveSelection(-1)} title={`${t("pullRequests.previousFile")} (k)`} type="button"><ChevronUp size={16} /></button>
                <button aria-keyshortcuts="j" aria-label={t("pullRequests.nextFile")} disabled={selectedIndex < 0 || selectedIndex >= props.files.length - 1} onClick={() => moveSelection(1)} title={`${t("pullRequests.nextFile")} (j)`} type="button"><ChevronDown size={16} /></button>
                <label className="diff-viewed-toggle"><input checked={viewedPaths.has(currentSummary.path)} onChange={toggleViewed} type="checkbox" />{t("pullRequests.markViewed")}</label>
              </div>
            </header>
          ) : null}
          {loading ? <AsyncState compact kind="loading" message={t("pullRequests.loadingDiff")} /> : null}
          {error ? <AsyncState compact kind="error" message={error} /> : null}
          {displayedFindings.length ? (
            <div className="diff-finding-overview" aria-label={t("pullRequests.findings")}>
              {displayedFindings.map((finding) => (
                <FindingCard finding={finding} key={finding.id} onOpen={finding.line ? () => openFinding(finding) : undefined} />
              ))}
            </div>
          ) : null}
          {!loading && !error && selectedFile?.patch !== undefined ? (
            view === "unified"
              ? <UnifiedDiff comments={displayedLineComments} draft={draftComment} findings={displayedFindings} focus={focusedFinding?.line ? { side: focusedFinding.side, line: focusedFinding.line } : null} onCancelComment={() => setDraftComment(null)} onStartComment={startLineComment} onSubmitComment={submitLineComment} patch={selectedFile.patch} path={selectedFile.path} />
              : <SplitDiff comments={displayedLineComments} draft={draftComment} findings={displayedFindings} focus={focusedFinding?.line ? { side: focusedFinding.side, line: focusedFinding.line } : null} onCancelComment={() => setDraftComment(null)} onStartComment={startLineComment} onSubmitComment={submitLineComment} patch={selectedFile.patch} path={selectedFile.path} />
          ) : null}
          {!currentSummary && !props.files.length ? <AsyncState compact kind="empty" message={t("pullRequests.noFiles")} /> : null}
        </div>
      </div>
    </section>
  );
}
