export type ImportantDiffReference = {
  path: string;
  side: "L" | "R";
  line: number;
  kind: "addition" | "deletion";
};

export function extractImportantDiffReferences(patch: string, limit = 8): ImportantDiffReference[] {
  if (!patch || limit <= 0) return [];
  const additions = new Map<string, ImportantDiffReference>();
  const deletions = new Map<string, ImportantDiffReference>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      newPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = parsePatchPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = parsePatchPath(line.slice(4));
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (newPath && substantive(line.slice(1)) && !additions.has(newPath)) {
        additions.set(newPath, { path: newPath, side: "R", line: newLine, kind: "addition" });
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      if (oldPath && substantive(line.slice(1)) && !deletions.has(oldPath)) {
        deletions.set(oldPath, { path: oldPath, side: "L", line: oldLine, kind: "deletion" });
      }
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  const paths = Array.from(new Set([...additions.keys(), ...deletions.keys()]));
  return paths
    .map((path) => additions.get(path) ?? deletions.get(path))
    .filter((reference): reference is ImportantDiffReference => Boolean(reference))
    .slice(0, Math.floor(limit));
}

function substantive(line: string): boolean {
  return line.trim().length > 0;
}

function parsePatchPath(value: string): string | null {
  const path = value.trim();
  if (path === "/dev/null") return null;
  const decoded = decodeQuotedPath(path);
  return decoded.startsWith("a/") || decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}

function decodeQuotedPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}
