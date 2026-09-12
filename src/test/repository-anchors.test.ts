import { describe, expect, it } from "vitest";
import { repositoryCommitAnchor, repositoryCommitPath } from "../shared/repository-anchors";

describe("repository anchors", () => {
  it("creates stable commit links only for Git object hashes", () => {
    const hash = "A1234567890abcdef1234567890abcdef1234567";
    expect(repositoryCommitAnchor(hash)).toBe(`commit-${hash.toLowerCase()}`);
    expect(repositoryCommitPath(hash)).toBe(`/repository#commit-${hash.toLowerCase()}`);
    expect(repositoryCommitPath("abc123")).toBeNull();
    expect(repositoryCommitPath("abc1234/../../settings")).toBeNull();
    expect(repositoryCommitPath("not-a-commit-reference")).toBeNull();
  });
});
