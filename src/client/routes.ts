export type View = "issues" | "pullRequests" | "agentJobs" | "repository" | "loops" | "settings";

export type AppRoute =
  | { name: "issues" }
  | { name: "issue"; issueId: number }
  | { name: "pullRequests" }
  | { name: "pullRequest"; pullRequestId: number }
  | { name: "pullRequestConflicts"; pullRequestId: number }
  | { name: "agentJobs" }
  | { name: "agentJob"; jobId: number }
  | { name: "repository" }
  | { name: "loops" }
  | { name: "loop"; loopId: number }
  | { name: "loopRun"; loopRunId: number }
  | { name: "settings" };

export function parseRoute(pathname = window.location.pathname): AppRoute {
  const segments = pathname.split("/").filter(Boolean);
  const [first, second, third] = segments;
  const id = numericSegment(second);

  if (!first || (first === "issues" && id === null)) {
    return { name: "issues" };
  }
  if (first === "issues" && id !== null) {
    return { name: "issue", issueId: id };
  }
  if (first === "pulls" && id === null) {
    return { name: "pullRequests" };
  }
  if (first === "pulls" && id !== null) {
    return third === "conflicts"
      ? { name: "pullRequestConflicts", pullRequestId: id }
      : { name: "pullRequest", pullRequestId: id };
  }
  if (first === "jobs" && id === null) {
    return { name: "agentJobs" };
  }
  if (first === "jobs" && id !== null) {
    return { name: "agentJob", jobId: id };
  }
  if (first === "repository") {
    return { name: "repository" };
  }
  if (first === "loops" && id === null) {
    return { name: "loops" };
  }
  if (first === "loops" && id !== null) {
    return { name: "loop", loopId: id };
  }
  if (first === "loop-runs" && id !== null) {
    return { name: "loopRun", loopRunId: id };
  }
  if (first === "settings") {
    return { name: "settings" };
  }

  return { name: "issues" };
}

export function routeToPath(route: AppRoute): string {
  switch (route.name) {
    case "issues":
      return "/issues";
    case "issue":
      return `/issues/${route.issueId}`;
    case "pullRequests":
      return "/pulls";
    case "pullRequest":
      return `/pulls/${route.pullRequestId}`;
    case "pullRequestConflicts":
      return `/pulls/${route.pullRequestId}/conflicts`;
    case "agentJobs":
      return "/jobs";
    case "agentJob":
      return `/jobs/${route.jobId}`;
    case "repository":
      return "/repository";
    case "loops":
      return "/loops";
    case "loop":
      return `/loops/${route.loopId}`;
    case "loopRun":
      return `/loop-runs/${route.loopRunId}`;
    case "settings":
      return "/settings";
  }
}

export function viewForRoute(route: AppRoute): View {
  if (route.name === "issue") {
    return "issues";
  }
  if (route.name === "pullRequest" || route.name === "pullRequestConflicts") {
    return "pullRequests";
  }
  if (route.name === "agentJob") {
    return "agentJobs";
  }
  if (route.name === "loop" || route.name === "loopRun") {
    return "loops";
  }
  return route.name;
}

export function listRouteForView(view: View): AppRoute {
  if (view === "pullRequests") {
    return { name: "pullRequests" };
  }
  if (view === "agentJobs") {
    return { name: "agentJobs" };
  }
  return { name: view };
}

function numericSegment(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}
