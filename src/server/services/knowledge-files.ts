import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import type { SkillFileDto } from "../../shared/types";

const defaultSkillFiles = [
  {
    path: "skills/project.md",
    title: "Project",
    body: "# Project\n\nDescribe the product, architecture, conventions, and important constraints.\n"
  },
  {
    path: "skills/build.md",
    title: "Build",
    body: "# Build\n\nDocument install, dev, build, test, lint, and verification commands.\n"
  },
  {
    path: "skills/review.md",
    title: "Review",
    body: "# Review\n\nDocument review standards, common pitfalls, and required evidence.\n"
  },
  {
    path: "skills/qa.md",
    title: "QA",
    body: "# QA\n\nDocument UI checks, smoke tests, screenshots, and acceptance workflows.\n"
  },
  {
    path: "memory/loop-notes.md",
    title: "Loop Notes",
    body: "# Loop Notes\n\nCapture reusable lessons from completed loop runs.\n"
  }
];

function knowledgeRoot(repoPath: string): string {
  return join(repoPath, ".oneteam");
}

function safeKnowledgePath(relativePath: string): string {
  const normalized = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!/^(skills|memory)[/\\][a-zA-Z0-9._-]+\.md$/.test(normalized)) {
    throw new Error("Knowledge path must be under skills/ or memory/ and end with .md.");
  }
  return normalized;
}

export async function ensureKnowledgeFiles(repoPath: string): Promise<void> {
  await ensureOneteamIgnored(repoPath);
  const root = knowledgeRoot(repoPath);
  await mkdir(join(root, "skills"), { recursive: true });
  await mkdir(join(root, "memory"), { recursive: true });
  for (const file of defaultSkillFiles) {
    const path = join(root, file.path);
    try {
      await stat(path);
    } catch {
      await writeFile(path, file.body, "utf8");
    }
  }
}

async function ensureOneteamIgnored(repoPath: string): Promise<void> {
  const excludePath = join(repoPath, ".git", "info", "exclude");
  const current = await readFile(excludePath, "utf8").catch(() => null);
  if (current === null || current.split(/\r?\n/).some((line) => line.trim() === ".oneteam/")) {
    return;
  }
  const next = `${current.trimEnd()}\n.oneteam/\n`;
  await writeFile(excludePath, next, "utf8").catch(() => undefined);
}

export async function listKnowledgeFiles(repoPath: string): Promise<SkillFileDto[]> {
  await ensureKnowledgeFiles(repoPath);
  return readKnowledgeFiles(repoPath);
}

export async function readKnowledgeFiles(repoPath: string): Promise<SkillFileDto[]> {
  const root = knowledgeRoot(repoPath);
  const items: SkillFileDto[] = [];
  for (const folder of ["skills", "memory"]) {
    const names = await readdir(join(root, folder)).catch(() => []);
    for (const name of names.filter((item) => item.endsWith(".md")).sort()) {
      const relativePath = `${folder}/${name}`;
      const absolutePath = join(root, relativePath);
      const [body, stats] = await Promise.all([readFile(absolutePath, "utf8"), stat(absolutePath)]);
      items.push({
        path: relativePath,
        title: titleFromPath(relativePath),
        body,
        updatedAt: stats.mtime.toISOString()
      });
    }
  }
  return items;
}

export async function writeKnowledgeFile(repoPath: string, relativePath: string, body: string): Promise<SkillFileDto> {
  await ensureKnowledgeFiles(repoPath);
  const safePath = safeKnowledgePath(relativePath);
  const absolutePath = join(knowledgeRoot(repoPath), safePath);
  await writeFile(absolutePath, body, "utf8");
  const stats = await stat(absolutePath);
  return {
    path: safePath,
    title: titleFromPath(safePath),
    body,
    updatedAt: stats.mtime.toISOString()
  };
}

export async function appendLoopMemoryNote(
  repoPath: string,
  input: {
    title: string;
    body: string;
    tags: string[];
  }
): Promise<void> {
  await ensureKnowledgeFiles(repoPath);
  const path = join(knowledgeRoot(repoPath), "memory", "loop-notes.md");
  const current = await readFile(path, "utf8").catch(() => "# Loop Notes\n");
  const tags = input.tags.length ? `\nTags: ${input.tags.join(", ")}` : "";
  const entry = [`## ${input.title}`, "", input.body || "No summary.", tags, ""].join("\n");
  await writeFile(path, `${current.trimEnd()}\n\n${entry}`, "utf8");
}

function titleFromPath(path: string): string {
  return basename(path, ".md")
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
