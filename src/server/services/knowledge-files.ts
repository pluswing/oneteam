import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SkillFileDto } from "../../shared/types";

const exec = promisify(execFile);
export const initialKnowledge = "# Project knowledge\n\nFollow the repository instructions and the current Issue.\nReusable lessons from completed development loops will appear here.\n";
export function knowledgeHash(body: string | null): string | null { return body === null ? null : createHash("sha256").update(body).digest("hex"); }

export async function ensureKnowledgeFiles(repoPath: string): Promise<void> {
  const root = join(repoPath, ".oneteam");
  await assertDirectory(root);
  await mkdir(root, { recursive: true });
  const path = await knowledgePath(repoPath, "AGENTS.md");
  try { await writeFile(path, initialKnowledge, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  try {
    const location = (await exec("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoPath })).stdout.trim();
    const exclude = isAbsolute(location) ? location : resolve(repoPath, location);
    const current = await readFile(exclude, "utf8").catch(missing);
    if (!current?.split(/\r?\n/).some((line) => line.trim() === ".oneteam/")) {
      await mkdir(dirname(exclude), { recursive: true });
      await writeFile(exclude, `${current?.trimEnd() ?? ""}\n.oneteam/\n`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error as { cmd?: string }).cmd) throw error;
  }
}

export function validateKnowledgePath(path: string, report = false): void {
  if (!/^(AGENTS\.md|knowledge\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md)$/.test(path) && !(report && /^retrospectives\/loop-\d+\.md$/.test(path))) {
    throw new Error("Knowledge changes must target AGENTS.md or a Markdown file directly inside knowledge/.");
  }
}

export async function knowledgePath(repoPath: string, path: string, report = false): Promise<string> {
  validateKnowledgePath(path, report);
  const root = join(repoPath, ".oneteam");
  await assertDirectory(root);
  if (path.includes("/")) await assertDirectory(join(root, dirname(path)));
  const absolute = join(root, path);
  const stats = await lstat(absolute).catch(missing);
  if (stats && (!stats.isFile() || stats.isSymbolicLink())) throw new Error(`Knowledge file must not be a symlink or directory: ${path}`);
  return absolute;
}

export async function readKnowledgeBody(repoPath: string, path: string, report = false): Promise<string | null> {
  return readFile(await knowledgePath(repoPath, path, report), "utf8").catch(missing);
}

export async function replaceKnowledgeBody(repoPath: string, path: string, body: string | null, report = false): Promise<void> {
  const absolute = await knowledgePath(repoPath, path, report);
  if (body === null) { await unlink(absolute).catch(missing); return; }
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx" });
    await knowledgePath(repoPath, path, report);
    await rename(temporary, absolute);
  } finally { await unlink(temporary).catch(missing); }
}

export async function listKnowledgeFiles(repoPath: string): Promise<SkillFileDto[]> { return readKnowledgeFiles(repoPath); }

export async function readKnowledgeFiles(repoPath: string): Promise<SkillFileDto[]> {
  const root = join(repoPath, ".oneteam");
  await assertDirectory(root);
  const paths = ["AGENTS.md"];
  await assertDirectory(join(root, "knowledge"));
  for (const name of await readdir(join(root, "knowledge")).catch((error: unknown) => { missing(error); return []; })) {
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(name)) paths.push(`knowledge/${name}`);
  }
  const files: SkillFileDto[] = [];
  for (const path of paths.sort((a, b) => a.localeCompare(b))) {
    const body = await readKnowledgeBody(repoPath, path);
    if (body !== null) files.push({ path, body, title: basename(path, ".md"), updatedAt: (await lstat(join(root, path))).mtime.toISOString() });
  }
  // Legacy skills stay readable, but the append-only memory log is not a prompt input.
  await assertDirectory(join(root, "skills"));
  for (const name of await readdir(join(root, "skills")).catch((error: unknown) => { missing(error); return []; })) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(name)) continue;
    const path = join(root, "skills", name);
    const stats = await lstat(path);
    if (stats.isFile() && !stats.isSymbolicLink()) files.push({ path: `skills/${name}`, title: basename(name, ".md"), body: await readFile(path, "utf8"), updatedAt: stats.mtime.toISOString() });
  }
  return files;
}

export async function writeKnowledgeFile(repoPath: string, relativePath: string, body: string): Promise<SkillFileDto> {
  await replaceKnowledgeBody(repoPath, relativePath, body);
  return { path: relativePath, title: basename(relativePath, ".md"), body, updatedAt: new Date().toISOString() };
}

/** Legacy history writer. New development loops use retrospective revisions. */
export async function appendLoopMemoryNote(repoPath: string, input: { title: string; body: string; tags: string[] }): Promise<void> {
  await ensureKnowledgeFiles(repoPath);
  const root = join(repoPath, ".oneteam");
  await assertDirectory(root);
  await assertDirectory(join(root, "memory"));
  await mkdir(join(root, "memory"), { recursive: true });
  const path = join(root, "memory/loop-notes.md");
  const stats = await lstat(path).catch(missing);
  if (stats?.isSymbolicLink()) throw new Error("Memory file must not be a symlink.");
  const current = await readFile(path, "utf8").catch(missing) ?? "# Legacy Loop Notes\n";
  await writeFile(path, `${current.trimEnd()}\n\n## ${input.title}\n\n${input.body}\n\nTags: ${input.tags.join(", ")}\n`);
}

async function assertDirectory(path: string): Promise<void> {
  const stats = await lstat(path).catch(missing);
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) throw new Error(`Knowledge directory must not be a symlink: ${path}`);
}
function missing(error: unknown): null { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
