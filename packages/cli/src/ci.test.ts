import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciContext } from "./ci";

function eventPayload(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "ci-")), "event.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("ciContext", () => {
  it("is absent outside CI, so a replay from someone's laptop says so", () => {
    expect(ciContext({})).toBeUndefined();
    expect(ciContext({ CI: "false" })).toBeUndefined();
  });

  it("reads a GitHub pull request, including the default branch from the event payload", () => {
    const ctx = ciContext({
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/support-agent",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
      GITHUB_REF_NAME: "42/merge",
      GITHUB_EVENT_PATH: eventPayload({ repository: { default_branch: "main" } }),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "118",
    });
    expect(ctx).toMatchObject({
      provider: "github",
      repo: "acme/support-agent",
      event: "pull_request",
      // BASE_REF wins on a pull request: the branch being merged into is the one that matters.
      baseRef: "main",
      defaultBranch: "main",
      runUrl: "https://github.com/acme/support-agent/actions/runs/118",
    });
  });

  it("falls back to the branch on a push, where there is no base ref", () => {
    const ctx = ciContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_NAME: "main",
      GITHUB_BASE_REF: "",
    });
    expect(ctx).toMatchObject({ event: "push", baseRef: "main", defaultBranch: null });
  });

  it("survives an unreadable event payload rather than failing the replay", () => {
    const ctx = ciContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
      GITHUB_EVENT_PATH: "/nonexistent/event.json",
    });
    expect(ctx?.defaultBranch).toBeNull();
  });

  it("reads a GitLab merge request", () => {
    expect(
      ciContext({
        GITLAB_CI: "true",
        CI_PROJECT_PATH: "acme/support-agent",
        CI_PIPELINE_SOURCE: "merge_request_event",
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main",
        CI_DEFAULT_BRANCH: "main",
        CI_PIPELINE_URL: "https://gitlab.com/acme/support-agent/-/pipelines/9",
      }),
    ).toMatchObject({ provider: "gitlab", event: "merge_request_event", baseRef: "main" });
  });

  it("says only that it is CI on a runner it does not know", () => {
    // Honest and incomplete beats guessed: this reads as "runs in CI", never as a gate.
    expect(ciContext({ CI: "true" })).toEqual({ provider: "unknown" });
  });
});
