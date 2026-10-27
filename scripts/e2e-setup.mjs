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
      dependencies: { "e2e-fixture-package": "fixture-version" },
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
writeFileSync(resolve(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
  "": { dependencies: { "e2e-fixture-package": "fixture-version" } },
  "node_modules/e2e-fixture-package": { version: "fixture-version" }
} }) + "\n");
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

// Browser tests exercise the real monitor lifecycle without downloading tools or databases.
const fakeTrivy = resolve(root, "fake-trivy.mjs");
// A complete synthetic inventory keeps the ordinary workflow fixture separate
// from warning recovery. The vulnerability E2Es supply their own mocked reports.
writeFileSync(fakeTrivy, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ SchemaVersion: 2, Results: [{ Class: "lang-pkgs", Type: "npm", Target: "package-lock.json", Packages: [{ Name: "e2e-fixture-package", Version: "fixture-version" }], Vulnerabilities: [] }] }));\n`);
chmodSync(fakeTrivy, 0o755);
