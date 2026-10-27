import type { Repositories } from "../db/repositories";

// The execution record can finish before the worker has retained its worktree
// and applied the stop. A restart must wait for that entire lifecycle.
const activeJobs = new WeakMap<Repositories, Map<string, Promise<void>>>();
const key = (projectId: string, jobId: number) => `${projectId}:${jobId}`;
export async function trackJobWork(repos: Repositories, projectId: string, jobId: number, run: () => Promise<void>): Promise<void> {
  let jobs = activeJobs.get(repos);
  if (!jobs) { jobs = new Map(); activeJobs.set(repos, jobs); }
  const id = key(projectId, jobId);
  const pending = Promise.resolve().then(run);
  jobs.set(id, pending);
  try { await pending; } finally { if (jobs.get(id) === pending) jobs.delete(id); }
}

export async function waitForJobWork(repos: Repositories, projectId: string, jobId: number, timeoutMs: number): Promise<boolean> {
  const pending = activeJobs.get(repos)?.get(key(projectId, jobId));
  if (!pending) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending.then(() => true, () => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
