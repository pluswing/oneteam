import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

export type DeclaredRuntime = { name: string; version: string; manifestPath: string };
type RequiredRuntime = { name: string; manifestPath: string; declarationPaths: string[]; declaredVersion?: string; conflict: boolean };
type RuntimeDeclaration = { name: string; version: string | null; manifestPath: string };
const versionFiles: Record<string, string> = { ".nvmrc": "nodejs", ".node-version": "nodejs", ".python-version": "python", ".ruby-version": "ruby", ".php-version": "php", ".bun-version": "bun" };
const toolNames: Record<string, string> = { nodejs: "nodejs", node: "nodejs", python: "python", ruby: "ruby", php: "php", golang: "go", go: "go", rust: "rust", bun: "bun" };
const fixedVersion = (value: string): string | null => /^(?:v)?\d+\.\d+\.\d+$/.test(value) ? value.replace(/^v/, "") : null;
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Vulnerability scan cancelled."); };

function requiredRuntime(manifestPath: string): string | null {
  const file = path.posix.basename(manifestPath);
  if (/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file)) return "nodejs";
  if (/^bun\.lockb?$/.test(file)) return "bun";
  if (/^(?:pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|pylock(?:\.[\w.-]+)?\.toml|requirements(?:[._-][\w.-]+)?\.txt)$/.test(file)) return "python";
  if (/^composer\.(?:json|lock)$/.test(file)) return "php";
  if (/^Gemfile(?:\.lock)?$/.test(file)) return "ruby";
  if (/^go\.(?:mod|sum)$/.test(file)) return "go";
  if (/^Cargo\.(?:toml|lock)$/.test(file)) return "rust";
  return null;
}

/** Read declarations only. The OneTeam process/host interpreter is never project runtime evidence. */
export async function inspectDeclaredRuntimes(repoPath: string, manifests: string[], options: { signal?: AbortSignal } = {}): Promise<{
  candidates: DeclaredRuntime[]; required: RequiredRuntime[]; warnings: string[]; sources: string[];
}> {
  abort(options.signal);
  const root = await realpath(repoPath);
  const declarations: RuntimeDeclaration[] = [];
  const requests: Array<Pick<RequiredRuntime, "name" | "manifestPath">> = [];
  const packageRuntimeHints = new Map<string, { node: boolean; bun: boolean }>();
  const warnings = new Set<string>();
  const unreadablePaths = new Set<string>();
  const sources: string[] = [];
  const directories = new Set<string>(["."]);
  for (const manifest of manifests) {
    const normalized = manifest.replaceAll("\\", "/");
    if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) continue;
    const runtime = requiredRuntime(normalized);
    if (runtime) requests.push({ name: runtime, manifestPath: normalized });
    let directory = path.posix.dirname(normalized);
    for (let depth = 0; depth < 8 && directory !== "." && directories.size < 100; depth++) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const read = async (relative: string): Promise<string | null> => {
    let handle;
    try {
      abort(options.signal);
      const absolute = path.resolve(root, relative);
      if (!absolute.startsWith(`${root}${path.sep}`) || await realpath(absolute) !== absolute) throw new Error("Unsafe runtime declaration");
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 || await realpath(absolute) !== absolute) throw new Error("Invalid runtime declaration");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > stat.size) throw new Error("Runtime declaration changed");
      sources.push(relative);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch (error) {
      abort(options.signal);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadablePaths.add(relative);
        warnings.add(`サポート期限の確認に使うランタイム指定を安全に読み取れませんでした: ${relative}。`);
      }
      return null;
    } finally { await handle?.close(); }
  };
  const add = (name: string, value: string, manifestPath: string) => {
    const version = fixedVersion(value);
    declarations.push({ name, version, manifestPath });
    if (!version) warnings.add(`サポート期限の確認に必要な ${name} の固定パッチ版を確認できませんでした: ${manifestPath}。範囲指定・移動タグ・ホスト環境からは対象バージョンを推測しません。`);
  };
  for (const directory of directories) {
    abort(options.signal);
    for (const [file, runtime] of Object.entries(versionFiles)) {
      const relative = path.posix.join(directory, file);
      const content = await read(relative);
      if (content === null) {
        if (unreadablePaths.has(relative)) {
          declarations.push({ name: runtime, version: null, manifestPath: relative });
          requests.push({ name: runtime, manifestPath: relative });
        }
        continue;
      }
      requests.push({ name: runtime, manifestPath: relative });
      const values = content.split(/\r?\n/).map((line) => line.replace(/\s*#.*$/, "").trim()).filter(Boolean);
      if (values.length === 1) add(runtime, values[0], relative);
      else add(runtime, "", relative);
    }
    const toolPath = path.posix.join(directory, ".tool-versions");
    const tools = await read(toolPath);
    if (unreadablePaths.has(toolPath)) for (const name of new Set(Object.values(toolNames))) declarations.push({ name, version: null, manifestPath: toolPath });
    for (const line of tools?.split(/\r?\n/) ?? []) {
      const [tool, ...versions] = line.replace(/\s*#.*$/, "").trim().split(/\s+/);
      const runtime = Object.hasOwn(toolNames, tool) ? toolNames[tool] : null;
      if (!runtime) continue;
      requests.push({ name: runtime, manifestPath: toolPath });
      if (!versions.length) add(runtime, "", toolPath);
      for (const version of versions) add(runtime, version, toolPath);
    }
    const manifestPath = path.posix.join(directory, "package.json");
    const content = await read(manifestPath);
    if (content !== null) {
      requests.push({ name: "nodejs", manifestPath });
      try {
        const metadata = JSON.parse(content) as { volta?: { node?: unknown }; engines?: { node?: unknown; bun?: unknown }; packageManager?: unknown };
        if (typeof metadata?.volta?.node === "string") add("nodejs", metadata.volta.node, manifestPath);
        packageRuntimeHints.set(manifestPath, {
          node: typeof metadata?.engines?.node === "string" || typeof metadata?.packageManager === "string" && /^(?:npm|pnpm|yarn)@/.test(metadata.packageManager),
          bun: typeof metadata?.engines?.bun === "string" || typeof metadata?.packageManager === "string" && metadata.packageManager.startsWith("bun@")
        });
      } catch { warnings.add(`サポート期限の確認に使うパッケージ設定を読み取れませんでした: ${manifestPath}。`); }
    }
  }
  const key = (name: string, directory: string) => JSON.stringify([name, directory]);
  const groups = new Map<string, RuntimeDeclaration[]>();
  for (const declaration of declarations) {
    const groupKey = key(declaration.name, path.posix.dirname(declaration.manifestPath));
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), declaration]);
  }
  const nearestDeclarations = (request: Pick<RequiredRuntime, "name" | "manifestPath">): RuntimeDeclaration[] | null => {
    let directory = path.posix.dirname(request.manifestPath);
    for (;;) {
      const nearest = groups.get(key(request.name, directory));
      if (nearest) return nearest;
      if (directory === ".") return null;
      directory = path.posix.dirname(directory);
    }
  };
  // npm packages are also consumed by Bun. A package.json alone must not
  // invent a Node runtime requirement when this workspace explicitly uses Bun.
  const scopedRequests = requests.flatMap((request) => {
    const hints = packageRuntimeHints.get(request.manifestPath);
    if (!hints || request.name !== "nodejs") return [request];
    const bun = hints.bun || Boolean(nearestDeclarations({ ...request, name: "bun" }));
    const node = hints.node || Boolean(nearestDeclarations(request));
    return bun ? [...(node ? [request] : []), { ...request, name: "bun" }] : [request];
  });
  const conflict = (entries: RuntimeDeclaration[]) => entries.some((entry) => entry.version === null) || new Set(entries.map((entry) => entry.version)).size > 1;
  const required: RequiredRuntime[] = [...new Map(scopedRequests.map((request) => [JSON.stringify(request), request])).values()].map((request) => {
    const nearest = nearestDeclarations(request);
    if (!nearest) return { ...request, declarationPaths: [], conflict: false };
    const conflicted = conflict(nearest);
    if (conflicted && nearest.filter((entry) => entry.version !== null).length > 1) warnings.add(`サポート期限の確認に使う ${request.name} の指定が競合しています（対象: ${request.manifestPath}）。実行対象のバージョンを確定して再検査してください。`);
    return { ...request, declarationPaths: nearest.map((entry) => entry.manifestPath), ...(conflicted ? {} : { declaredVersion: nearest[0].version! }), conflict: conflicted };
  });
  const candidates: DeclaredRuntime[] = declarations.flatMap((entry) => entry.version && !conflict(groups.get(key(entry.name, path.posix.dirname(entry.manifestPath)))!)
    ? [{ ...entry, version: entry.version }] : []);
  return { candidates, required, warnings: [...warnings], sources: [...new Set(sources)] };
}
