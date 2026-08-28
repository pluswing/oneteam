export type DiffLineKind = "context" | "addition" | "deletion" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type ParsedDiff = {
  hunks: DiffHunk[];
  binary: boolean;
};

export type SplitDiffRow = {
  left: DiffLine | null;
  right: DiffLine | null;
};

export type DiffWordSegment = {
  value: string;
  changed: boolean;
};

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiffPatch(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const rawLine of patch.split("\n")) {
    const hunkMatch = rawLine.match(hunkHeaderPattern);
    if (hunkMatch) {
      oldLineNumber = Number(hunkMatch[1]);
      newLineNumber = Number(hunkMatch[2]);
      current = {
        header: rawLine,
        oldStart: oldLineNumber,
        newStart: newLineNumber,
        lines: []
      };
      hunks.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("\\")) {
      current.lines.push({ kind: "meta", content: rawLine, oldLineNumber: null, newLineNumber: null });
      continue;
    }

    if (rawLine.startsWith("+")) {
      current.lines.push({
        kind: "addition",
        content: rawLine.slice(1),
        oldLineNumber: null,
        newLineNumber
      });
      newLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      current.lines.push({
        kind: "deletion",
        content: rawLine.slice(1),
        oldLineNumber,
        newLineNumber: null
      });
      oldLineNumber += 1;
      continue;
    }

    current.lines.push({
      kind: "context",
      content: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
      oldLineNumber,
      newLineNumber
    });
    oldLineNumber += 1;
    newLineNumber += 1;
  }

  return {
    hunks,
    binary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(patch)
  };
}

function flushChangedLines(rows: SplitDiffRow[], deletions: DiffLine[], additions: DiffLine[]): void {
  const count = Math.max(deletions.length, additions.length);
  for (let index = 0; index < count; index += 1) {
    rows.push({ left: deletions[index] ?? null, right: additions[index] ?? null });
  }
  deletions.length = 0;
  additions.length = 0;
}

export function buildSplitDiffRows(lines: DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  const deletions: DiffLine[] = [];
  const additions: DiffLine[] = [];

  for (const line of lines) {
    if (line.kind === "deletion") {
      deletions.push(line);
      continue;
    }
    if (line.kind === "addition") {
      additions.push(line);
      continue;
    }
    flushChangedLines(rows, deletions, additions);
    rows.push(line.kind === "context" ? { left: line, right: line } : { left: line, right: null });
  }
  flushChangedLines(rows, deletions, additions);
  return rows;
}

function tokenize(value: string): string[] {
  return value.match(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu) ?? [];
}

function appendSegment(segments: DiffWordSegment[], value: string, changed: boolean): void {
  if (!value) {
    return;
  }
  const previous = segments.at(-1);
  if (previous?.changed === changed) {
    previous.value += value;
    return;
  }
  segments.push({ value, changed });
}

export function diffWordSegments(
  before: string,
  after: string
): { before: DiffWordSegment[]; after: DiffWordSegment[] } {
  const left = tokenize(before);
  const right = tokenize(after);
  const common = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      common[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? common[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(common[leftIndex + 1][rightIndex], common[leftIndex][rightIndex + 1]);
    }
  }

  const beforeSegments: DiffWordSegment[] = [];
  const afterSegments: DiffWordSegment[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      appendSegment(beforeSegments, left[leftIndex], false);
      appendSegment(afterSegments, right[rightIndex], false);
      leftIndex += 1;
      rightIndex += 1;
    } else if (common[leftIndex + 1][rightIndex] >= common[leftIndex][rightIndex + 1]) {
      appendSegment(beforeSegments, left[leftIndex], true);
      leftIndex += 1;
    } else {
      appendSegment(afterSegments, right[rightIndex], true);
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    appendSegment(beforeSegments, left[leftIndex], true);
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    appendSegment(afterSegments, right[rightIndex], true);
    rightIndex += 1;
  }

  return { before: beforeSegments, after: afterSegments };
}

function pathHash(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function diffFileAnchor(path: string): string {
  return `diff-file-${pathHash(path)}`;
}

export function diffAnchorMatchesPath(anchor: string, path: string): boolean {
  const hash = pathHash(path);
  return anchor === `diff-file-${hash}` || anchor.startsWith(`diff-${hash}-`);
}

export function diffLineAnchor(path: string, side: "L" | "R", lineNumber: number): string {
  return `diff-${pathHash(path)}-${side}${lineNumber}`;
}
