import { Check, ChevronDown, ChevronUp, FileCode2, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { PullRequestFindingDto, RepositoryFileChangeDto } from "../../shared/types";
import { api } from "../api";
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
  type DiffWordSegment
} from "../diff-parser";
import { t } from "../i18n";
import { highlightDiffSyntax } from "../diff-syntax";

type DiffView = "unified" | "split";
const initialDiffRenderLines = 1_000;
const diffRenderIncrement = 1_000;
const maximumDiffRenderLines = 5_000;

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

function LineNumber(props: { path: string; side: "L" | "R"; value: number | null }) {
  if (props.value === null) {
    return <span aria-hidden="true" />;
  }
  const anchor = diffLineAnchor(props.path, props.side, props.value);
  return (
    <a aria-label={`${props.side === "L" ? t("pullRequests.oldLine") : t("pullRequests.newLine")} ${props.value}`} href={`#${anchor}`} id={anchor}>
      {props.value}
    </a>
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

function InlineFindingRows(props: { colSpan: number; findings: PullRequestFindingDto[] }) {
  if (!props.findings.length) return null;
  return (
    <tr className="diff-finding-row">
      <td colSpan={props.colSpan}>
        {props.findings.map((finding) => <FindingCard finding={finding} key={finding.id} />)}
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

function UnifiedDiff(props: { findings: PullRequestFindingDto[]; focus: DiffLineFocus | null; path: string; patch: string }) {
  const { parsed, limited, lineLimit, setLineLimit } = useRenderedDiff(props.patch, props.focus);
  if (parsed.binary) {
    return <div className="diff-notice">{t("pullRequests.binaryDiff")}</div>;
  }
  if (!parsed.hunks.length) {
    return <div className="diff-notice">{t("pullRequests.noVisibleDiff")}</div>;
  }
  return (
    <div className="diff-table-scroll">
      <table className="diff-table diff-unified">
        <tbody>
          {limited.hunks.map((hunk, hunkIndex) => (
            <Fragment key={`${hunk.header}-${hunkIndex}`}>
              <tr className="diff-hunk-row">
                <td colSpan={3}>{hunk.header}</td>
              </tr>
              {hunk.lines.map((line, lineIndex) => {
                const lineFindings = findingsForLine(props.findings, line);
                return (
                  <Fragment key={`${hunkIndex}-${lineIndex}`}>
                    <tr className={`diff-line diff-line-${line.kind}`}>
                      <td className="diff-line-number"><LineNumber path={props.path} side="L" value={line.oldLineNumber} /></td>
                      <td className="diff-line-number"><LineNumber path={props.path} side="R" value={line.newLineNumber} /></td>
                      <td className="diff-code">
                        <code><span className="diff-prefix" aria-hidden="true">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}</span><SyntaxLine content={line.content} path={props.path} /></code>
                      </td>
                    </tr>
                    <InlineFindingRows colSpan={3} findings={lineFindings} />
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
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

function SplitDiff(props: { findings: PullRequestFindingDto[]; focus: DiffLineFocus | null; path: string; patch: string }) {
  const { parsed, limited, lineLimit, setLineLimit } = useRenderedDiff(props.patch, props.focus);
  if (parsed.binary) {
    return <div className="diff-notice">{t("pullRequests.binaryDiff")}</div>;
  }
  if (!parsed.hunks.length) {
    return <div className="diff-notice">{t("pullRequests.noVisibleDiff")}</div>;
  }
  return (
    <div className="diff-table-scroll">
      <table className="diff-table diff-split">
        <tbody>
          {limited.hunks.map((hunk, hunkIndex) => (
            <Fragment key={`${hunk.header}-${hunkIndex}`}>
              <tr className="diff-hunk-row"><td colSpan={4}>{hunk.header}</td></tr>
              {buildSplitDiffRows(hunk.lines).map((row, rowIndex) => {
                const lineFindings = props.findings.filter((finding) => {
                  if (finding.line === null) return false;
                  return finding.side === "L"
                    ? row.left?.oldLineNumber === finding.line
                    : row.right?.newLineNumber === finding.line;
                });
                return (
                <Fragment key={`${hunkIndex}-${rowIndex}`}>
                <tr className="diff-split-row">
                  <td className={`diff-line-number diff-line-${row.left?.kind ?? "empty"}`}>
                    <LineNumber path={props.path} side="L" value={row.left?.oldLineNumber ?? null} />
                  </td>
                  <td className={`diff-code diff-line-${row.left?.kind ?? "empty"}`}>
                    <code>{row.left ? <><span className="diff-prefix" aria-hidden="true">{row.left.kind === "deletion" ? "-" : " "}</span>{splitContent(row.left, row.right, "before", props.path)}</> : null}</code>
                  </td>
                  <td className={`diff-line-number diff-line-${row.right?.kind ?? "empty"}`}>
                    <LineNumber path={props.path} side="R" value={row.right?.newLineNumber ?? null} />
                  </td>
                  <td className={`diff-code diff-line-${row.right?.kind ?? "empty"}`}>
                    <code>{row.right ? <><span className="diff-prefix" aria-hidden="true">{row.right.kind === "addition" ? "+" : " "}</span>{splitContent(row.right, row.left, "after", props.path)}</> : null}</code>
                  </td>
                </tr>
                <InlineFindingRows colSpan={4} findings={lineFindings} />
                </Fragment>
              );})}
            </Fragment>
          ))}
        </tbody>
      </table>
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
  const [viewedPaths, setViewedPaths] = useState<Set<string>>(() => readViewedPaths(viewedStorageKey));
  const [selectedFile, setSelectedFile] = useState<RepositoryFileChangeDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diffCache = useRef(new Map<string, RepositoryFileChangeDto>());

  useEffect(() => {
    setViewedPaths(readViewedPaths(viewedStorageKey));
  }, [viewedStorageKey]);

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
              </div>
              <div className="diff-file-actions">
                <span className="diff-file-stats"><span className="addition">+{currentSummary.additions}</span><span className="deletion">−{currentSummary.deletions}</span></span>
                <button aria-keyshortcuts="k" aria-label={t("pullRequests.previousFile")} disabled={selectedIndex <= 0} onClick={() => moveSelection(-1)} title={`${t("pullRequests.previousFile")} (k)`} type="button"><ChevronUp size={16} /></button>
                <button aria-keyshortcuts="j" aria-label={t("pullRequests.nextFile")} disabled={selectedIndex < 0 || selectedIndex >= props.files.length - 1} onClick={() => moveSelection(1)} title={`${t("pullRequests.nextFile")} (j)`} type="button"><ChevronDown size={16} /></button>
                <label className="diff-viewed-toggle"><input checked={viewedPaths.has(currentSummary.path)} onChange={toggleViewed} type="checkbox" />{t("pullRequests.markViewed")}</label>
              </div>
            </header>
          ) : null}
          {loading ? <div className="diff-notice">{t("pullRequests.loadingDiff")}</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          {displayedFindings.length ? (
            <div className="diff-finding-overview" aria-label={t("pullRequests.findings")}>
              {displayedFindings.map((finding) => (
                <FindingCard finding={finding} key={finding.id} onOpen={finding.line ? () => openFinding(finding) : undefined} />
              ))}
            </div>
          ) : null}
          {!loading && !error && selectedFile?.patch !== undefined ? (
            view === "unified"
              ? <UnifiedDiff findings={displayedFindings} focus={focusedFinding?.line ? { side: focusedFinding.side, line: focusedFinding.line } : null} patch={selectedFile.patch} path={selectedFile.path} />
              : <SplitDiff findings={displayedFindings} focus={focusedFinding?.line ? { side: focusedFinding.side, line: focusedFinding.line } : null} patch={selectedFile.patch} path={selectedFile.path} />
          ) : null}
          {!currentSummary && !props.files.length ? <div className="empty-state">{t("pullRequests.noFiles")}</div> : null}
        </div>
      </div>
    </section>
  );
}
