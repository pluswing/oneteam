import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@libsql/client";

const exec = promisify(execFile);
type Manifest = { version: 1; id: string; state: "initializing" | "ready" };

export async function inspectWorkspace(path: string): Promise<{ repoPath: string; name: string; defaultBranch: string }> {
  const repoPath = await realpath(resolve(path));
  if (!(await lstat(repoPath)).isDirectory()) throw new Error("Choose a repository folder.");
  let root: string;
  try { root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath })).stdout.trim(); }
  catch { throw new Error("This folder is not a Git repository. Initialize Git and create the first commit before opening it."); }
  if (await realpath(root) !== repoPath) throw new Error(`Open the repository root: ${root}`);
  try { await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoPath }); }
  catch { throw new Error("Create the first Git commit before opening this repository."); }
  let defaultBranch = "";
  try { defaultBranch = (await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoPath })).stdout.trim().replace(/^origin\//, ""); }
  catch { /* Local repositories have no remote default. */ }
  if (!defaultBranch) {
    try { defaultBranch = (await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoPath })).stdout.trim(); }
    catch { throw new Error("Check out a branch before opening this repository."); }
  }
  return { repoPath, name: basename(repoPath), defaultBranch };
}

export async function prepareWorkspace(repoPath: string): Promise<Manifest> {
  const root = join(repoPath, ".oneteam");
  const stats = await lstat(root).catch(missing);
  if (stats?.isSymbolicLink() || (stats && !stats.isDirectory())) throw new Error(".oneteam must be a real directory inside this repository.");
  for (const [name, directory] of [["data", true], ["data/oneteam.db", false], ["workspace.json", false], ["runtime.lock", false], ["backups", true]] as const) {
    const entry = await lstat(join(root, name)).catch(missing);
    if (entry && (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()))) throw new Error(`.oneteam/${name} must not be a link or a special file.`);
  }
  const path = join(root, "workspace.json");
  const raw = await readFile(path, "utf8").catch(missing);
  if (raw !== null) {
    let manifest: Manifest;
    try { manifest = JSON.parse(raw) as Manifest; } catch { throw new Error(".oneteam/workspace.json is invalid; restore it from a backup."); }
    if (manifest.version !== 1 || !manifest.id || !["ready", "initializing"].includes(manifest.state)) throw new Error("This .oneteam format is not supported by this version of OneTeam.");
    if (manifest.state === "ready" && !(await lstat(join(root, "data/oneteam.db")).catch(missing))) throw new Error("The workspace database is missing. Restore .oneteam/data/oneteam.db from a backup.");
    return manifest;
  }
  if (stats && !(await lstat(join(root, "data/oneteam.db")).catch(missing))) {
    throw new Error("Existing .oneteam has no database or initialization record. Restore its database or move it aside before initializing.");
  }
  await mkdir(root, { recursive: true });
  const manifest: Manifest = { version: 1, id: randomUUID(), state: "initializing" };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export async function completeWorkspace(repoPath: string): Promise<void> {
  const path = join(repoPath, ".oneteam/workspace.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
  if (manifest.state === "ready") return;
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...manifest, state: "ready" }, null, 2)}\n`);
  await rename(temp, path);
}

/** Called before schema migration; VACUUM captures a consistent SQLite snapshot. */
export async function backupBeforeLoopMigration(client: Client, databaseUrl: string): Promise<void> {
  if (!databaseUrl.startsWith("file:")) return;
  const tables = await client.execute("select name from sqlite_master where type = 'table' and name = 'schema_migrations'");
  if (!tables.rows.length) return;
  const applied = await client.execute("select id from schema_migrations where id = '0016_development_loops'");
  if (applied.rows.length) return;
  const root = dirname(dirname(resolve(databaseUrl.slice(5))));
  const backup = join(root, "backups", `before-loop-v2-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backup, { recursive: true });
  await client.execute({ sql: "vacuum into ?", args: [join(backup, "oneteam.db")] });
  for (const name of ["skills", "memory", "knowledge", "AGENTS.md", "workspace.json"]) {
    const source = join(root, name);
    if (await lstat(source).catch(missing)) await cp(source, join(backup, name), { recursive: true, dereference: false });
  }
}

export async function acquireWorkspaceLock(repoPath: string): Promise<() => Promise<void>> {
  const path = join(repoPath, ".oneteam/runtime.lock");
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, token });
  try { await writeFile(path, body, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: { pid?: number } = {};
    try { owner = JSON.parse(await readFile(path, "utf8")) as { pid?: number }; } catch { /* Incomplete lock stays protected briefly. */ }
    let live = false;
    if (owner.pid) {
      try { process.kill(owner.pid, 0); live = true; }
      catch (probe) { live = (probe as NodeJS.ErrnoException).code !== "ESRCH"; }
    } else live = Date.now() - (await lstat(path)).mtimeMs < 30_000;
    if (live) throw new Error("This folder is already open in another OneTeam runtime.");
    await unlink(path);
    await writeFile(path, body, { flag: "wx" });
  }
  return async () => {
    if (await readFile(path, "utf8").catch(missing) === body) await unlink(path);
  };
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}
