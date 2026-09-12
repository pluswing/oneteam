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

export function parseDiffLineAnchor(anchor: string, path: string): { side: "L" | "R"; line: number } | null {
  const prefix = `diff-${pathHash(path)}-`;
  if (!anchor.startsWith(prefix)) return null;
  const match = anchor.slice(prefix.length).match(/^([LR])(\d+)$/);
  if (!match) return null;
  const line = Number(match[2]);
  return Number.isSafeInteger(line) && line > 0 ? { side: match[1] as "L" | "R", line } : null;
}
