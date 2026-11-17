import { readFileSync } from "node:fs";
import type { CiContext } from "@overturn-ai/shared";

/** The default branch is only in the event payload, never in a plain variable. */
function githubDefaultBranch(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      repository?: { default_branch?: unknown };
    };
    const b = payload.repository?.default_branch;
    return typeof b === "string" ? b : null;
  } catch {
    return null; // a missing or unreadable payload is not worth failing a replay over
  }
}

/**
 * Where this command is running, when it is running in CI. Read from the environment, so a repo
 * that already runs `overturn replay` in a workflow reports it without changing anything.
 *
 * The question it answers is whether the gate is wired into the way the team ships — a replay on
 * pull requests against the default branch, there week after week — or whether someone ran it once
 * by hand. Nothing here identifies a person.
 */
export function ciContext(env: NodeJS.ProcessEnv = process.env): CiContext | undefined {
  if (env.GITHUB_ACTIONS === "true") {
    const repo = env.GITHUB_REPOSITORY ?? null;
    return {
      provider: "github",
      repo,
      event: env.GITHUB_EVENT_NAME ?? null,
      // GITHUB_BASE_REF is set on pull_request events only; on a push, the branch is the ref.
      baseRef: env.GITHUB_BASE_REF || env.GITHUB_REF_NAME || null,
      defaultBranch: githubDefaultBranch(env.GITHUB_EVENT_PATH),
      runUrl:
        repo && env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL
          ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
          : null,
    };
  }
  if (env.GITLAB_CI === "true") {
    return {
      provider: "gitlab",
      repo: env.CI_PROJECT_PATH ?? null,
      event: env.CI_PIPELINE_SOURCE ?? null,
      baseRef: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.CI_COMMIT_REF_NAME || null,
      defaultBranch: env.CI_DEFAULT_BRANCH ?? null,
      runUrl: env.CI_PIPELINE_URL ?? null,
    };
  }
  // Every other runner sets CI=true and little else that is portable.
  if (env.CI === "true" || env.CI === "1") return { provider: "unknown" };
  return undefined;
}
