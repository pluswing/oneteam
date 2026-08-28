const commitHashPattern = /^[0-9a-f]{7,64}$/i;

export function repositoryCommitAnchor(hash: string): string | null {
  const normalized = hash.trim().toLowerCase();
  return commitHashPattern.test(normalized) ? `commit-${normalized}` : null;
}

export function repositoryCommitPath(hash: string): string | null {
  const anchor = repositoryCommitAnchor(hash);
  return anchor ? `/repository#${anchor}` : null;
}
