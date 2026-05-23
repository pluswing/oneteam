import { describe, expect, it } from "vitest";
import { parseRoute, routeToPath, viewForRoute } from "../client/routes";

describe("client routes", () => {
  it("maps list and detail routes to stable paths", () => {
    expect(routeToPath({ name: "issues" })).toBe("/issues");
    expect(routeToPath({ name: "issue", issueId: 1 })).toBe("/issues/1");
    expect(routeToPath({ name: "pullRequests" })).toBe("/pulls");
    expect(routeToPath({ name: "pullRequest", pullRequestId: 2 })).toBe("/pulls/2");
    expect(routeToPath({ name: "pullRequestConflicts", pullRequestId: 2 })).toBe("/pulls/2/conflicts");
    expect(routeToPath({ name: "agentJobs" })).toBe("/jobs");
    expect(routeToPath({ name: "agentJob", jobId: 3 })).toBe("/jobs/3");
    expect(routeToPath({ name: "repository" })).toBe("/repository");
    expect(routeToPath({ name: "settings" })).toBe("/settings");
  });

  it("parses detail routes into their owning views", () => {
    expect(parseRoute("/issues/1")).toEqual({ name: "issue", issueId: 1 });
    expect(viewForRoute(parseRoute("/issues/1"))).toBe("issues");
    expect(parseRoute("/pulls/2/conflicts")).toEqual({ name: "pullRequestConflicts", pullRequestId: 2 });
    expect(viewForRoute(parseRoute("/pulls/2/conflicts"))).toBe("pullRequests");
    expect(parseRoute("/jobs/3")).toEqual({ name: "agentJob", jobId: 3 });
    expect(viewForRoute(parseRoute("/jobs/3"))).toBe("agentJobs");
  });
});
