import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".tmp/e2e");
const repo = resolve(root, "repo");
const fakeCodex = resolve(root, "fake-codex.mjs");

rmSync(root, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });

writeFileSync(
  resolve(repo, "package.json"),
  JSON.stringify(
    {
      name: "oneteam-e2e-repo",
      private: true,
      scripts: {
        dev: "node -e \"console.log('dev')\"",
        build: "node -e \"console.log('build')\"",
        test: "node -e \"console.log('test')\"",
        lint: "node -e \"console.log('lint')\""
      }
    },
    null,
    2
  )
);
writeFileSync(resolve(repo, "package-lock.json"), "{}\n");
writeFileSync(resolve(repo, "README.md"), "# E2E repository\n");

execFileSync("git", ["init", "-b", "main"], { cwd: repo });
execFileSync("git", ["config", "user.name", "E2E User"], { cwd: repo });
execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });

writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\\n");
  process.exit(0);
}
process.stdout.write("{}\\n");
process.exit(0);
`
);
chmodSync(fakeCodex, 0o755);
