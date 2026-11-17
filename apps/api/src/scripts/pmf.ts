/**
 * The four PMF numbers, per project, across every project on this database.
 *
 *   pnpm pmf              # all projects
 *   pnpm pmf --json       # same, as JSON
 *   pnpm pmf --weeks 12   # how far back the weekly corrections go
 *
 * Nothing here counts installs, runs ingested or stars. Those are free, and a metric you can
 * inflate by doing nothing is a metric that will eventually lie to you.
 *
 *   gate        Where a replay last ran. "production" means it has been running on pull requests
 *               into the default branch for 30 days or more and ran again in the last 7.
 *   corrections Human corrections per week from week four onward. A customer who stops correcting
 *               has churned whether or not they are paying.
 *   corpus      Active cases. Below the floor they can leave for free; above it, leaving means
 *               abandoning a test suite their own team wrote.
 */
import { parseArgs } from "node:util";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { cases, corrections, projects, replayJobs } from "../db/schema";
import { loadDotEnv } from "../env";

/**
 * Below this the corpus is not a switching cost, and the number has to come from somewhere.
 *
 * A correction is a minute or two of a senior reviewer's attention — reading the agent's output,
 * fixing it, saying why. Two hundred of them is most of a working day of someone expensive, spread
 * over months and impossible to recover, because the cases encode judgements nobody wrote down
 * anywhere else. A competitor can copy the product in a weekend; they cannot hand a customer back
 * their own six months of corrections. That is the whole argument for this number, and it is the
 * argument to check against a real customer rather than the number itself.
 *
 * It is also the point where a replay suite starts catching things: under about fifty cases a
 * regression run mostly passes and tells you nothing.
 *
 * Override with OVERTURN_CORPUS_FLOOR once a customer has shown us where the line actually is.
 */
export const CORPUS_FLOOR = Number(process.env.OVERTURN_CORPUS_FLOOR ?? 200);
/** A gate has to survive a month of someone's pull requests before it counts as production. */
export const PRODUCTION_DAYS = 30;
/** And it has to have run recently, or it is a gate somebody quietly removed. */
export const STALE_DAYS = 7;
/** Two runs a month apart is a trial someone repeated. A gate runs most weeks a team ships. */
export const PRODUCTION_MIN_WEEKS = 3;

export type GateStage = "none" | "manual" | "ci" | "gating" | "production";

export interface ProjectPmf {
  projectId: string;
  name: string;
  gate: {
    stage: GateStage;
    firstGatingAt: string | null;
    lastGatingAt: string | null;
    daysGating: number;
    /** Distinct weeks it ran in, out of the last four. Production needs most of them. */
    recentWeeks: number;
    blockedARelease: boolean;
    repos: string[];
  };
  corrections: {
    /** Corrections a person made, by ISO week, oldest first. */
    weekly: { week: string; corrections: number; people: number }[];
    firstAt: string | null;
    weeksSinceFirst: number;
    /** The honest retention number: the mean of the weeks from week four onward. */
    perWeekFromWeekFour: number | null;
    lastAt: string | null;
  };
  corpus: { activeCases: number; floor: number; overFloor: boolean };
  /** Who may answer the PMF survey: two or more corrections in the last fortnight. */
  eligible: { actor: string; corrections: number }[];
}

const DAY = 86_400_000;
const days = (ms: number) => Math.floor(ms / DAY);

/**
 * Events that can stop a merge. A push-to-main run is a monitor, not a gate: by the time it runs
 * the code is already in. A runner this list does not cover reads as `ci` rather than `gating`,
 * which understates the customer — better than a number that flatters us.
 */
const GATING_EVENTS = new Set(["pull_request", "pull_request_target", "merge_group", "merge_request_event"]);

/**
 * A replay only counts as gating when CI ran it against the branch the team merges into. A replay
 * on a feature branch, or one a person started from the CLI, is someone trying it out.
 *
 * This is self-reported: the CLI fills it in and an API key holder could post anything. That is
 * fine for what it is — a customer faking this is only deceiving us about their own adoption, and
 * nothing is granted on the strength of it.
 */
function isGating(ci: Record<string, unknown> | null): boolean {
  if (!ci) return false;
  const event = typeof ci.event === "string" ? ci.event : "";
  const base = typeof ci.baseRef === "string" ? ci.baseRef : "";
  const dflt = typeof ci.defaultBranch === "string" ? ci.defaultBranch : "";
  if (!GATING_EVENTS.has(event)) return false;
  // No default branch reported (an older CLI, or an unknown runner): take the usual names.
  return dflt ? base === dflt : base === "main" || base === "master";
}

export async function pmf(db: Db, weeks = 12): Promise<ProjectPmf[]> {
  const now = Date.now();
  const since = new Date(now - weeks * 7 * DAY);
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects);
  const out: ProjectPmf[] = [];

  for (const p of rows) {
    const jobs = await db
      .select({ ci: replayJobs.ci, createdAt: replayJobs.createdAt, summary: replayJobs.summary })
      .from(replayJobs)
      .where(and(eq(replayJobs.projectId, p.id), isNotNull(replayJobs.ci)));
    const anyJob = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(replayJobs)
      .where(eq(replayJobs.projectId, p.id));

    const gating = jobs.filter((j) => isGating(j.ci));
    const times = gating.map((j) => j.createdAt.getTime()).sort((a, b) => a - b);
    const first = times[0] ?? null;
    const last = times.at(-1) ?? null;
    const daysGating = first && last ? days(last - first) : 0;
    const fresh = last !== null && days(now - last) <= STALE_DAYS;
    // How many of the trailing four weeks it actually ran in: two runs a month apart is a trial
    // repeated once, and reading that as production is the exact mistake this metric exists to
    // avoid. A real gate leaves a mark most weeks.
    const recentWeeks = new Set(times.filter((t) => days(now - t) <= 28).map((t) => isoWeekOf(t))).size;
    const stage: GateStage =
      gating.length > 0
        ? daysGating >= PRODUCTION_DAYS && fresh && recentWeeks >= PRODUCTION_MIN_WEEKS
          ? "production"
          : "gating"
        : jobs.length > 0
          ? "ci"
          : (anyJob[0]?.n ?? 0) > 0
            ? "manual"
            : "none";

    // A gate that has failed a build is a gate someone had to answer to.
    const blockedARelease = gating.some((j) => {
      const s = j.summary as { gate?: { pass?: unknown } } | null;
      return s?.gate?.pass === false;
    });

    // Only corrections a person made: the app and the capture surfaces (Zendesk writes `capture`).
    // `sdk` and `api` are programmatic, and `implicit` is the opposite of a human act — it is what
    // happens when nobody looked at a run for long enough that it auto-approved.
    const byPerson = and(
      eq(corrections.projectId, p.id),
      isNotNull(corrections.actor),
      sql`${corrections.source} in ('ui','capture')`,
    );
    const week = sql<string>`to_char(date_trunc('week', ${corrections.createdAt}), 'IYYY-"W"IW')`;
    // Two queries on purpose. `weekly` is the display series and honours --weeks; `allWeeks` runs
    // over the customer's whole history, because the average below walks from their first
    // correction. Windowing that one would read every week before the window as a week nobody
    // corrected, so a long-standing customer's retention would fall as --weeks got smaller.
    const counts = (where: ReturnType<typeof and>) =>
      db
        .select({
          week,
          corrections: sql<number>`count(*)::int`,
          people: sql<number>`count(distinct ${corrections.actor})::int`,
        })
        .from(corrections)
        .where(where)
        .groupBy(week)
        .orderBy(week);
    const weekly = await counts(and(byPerson, gte(corrections.createdAt, since)));
    const allWeeks = await counts(byPerson);
    const [span] = await db
      .select({
        firstAt: sql<Date | null>`min(${corrections.createdAt})`,
        lastAt: sql<Date | null>`max(${corrections.createdAt})`,
      })
      .from(corrections)
      .where(byPerson);

    const firstAt = span?.firstAt ? new Date(span.firstAt) : null;
    const weeksSinceFirst = firstAt ? Math.floor(days(now - firstAt.getTime()) / 7) : 0;
    /**
     * The weeks that count: whole weeks, starting three weeks after the first correction. Weeks
     * one to three are the honeymoon, when someone is evaluating and corrects everything.
     *
     * Every one of those weeks counts, including the ones with nothing in them. A team that
     * corrected once in eight weeks has churned, and averaging only the weeks they showed up in
     * would report that as one a week — the metric would be at its most flattering exactly when
     * the customer is leaving. The current week is left out because it has not finished.
     */
    const counted = allWeeks.reduce((m, w) => m.set(w.week, w.corrections), new Map<string, number>());
    const thisWeek = isoWeekOf(now);
    const mature: number[] = [];
    if (firstAt) {
      for (let t = isoWeekStart(...isoWeekParts(firstAt.getTime() + 21 * DAY)); t < now; t += 7 * DAY) {
        const label = isoWeekOf(t);
        if (label === thisWeek) continue;
        mature.push(counted.get(label) ?? 0);
      }
    }
    const perWeekFromWeekFour =
      weeksSinceFirst >= 4 && mature.length > 0
        ? Math.round((mature.reduce((a, n) => a + n, 0) / mature.length) * 10) / 10
        : null;

    // Sean Ellis's rule: ask people who actually use the thing, not people who bought it.
    const fortnight = new Date(now - 14 * DAY);
    const eligible = (
      await db
        .select({ actor: corrections.actor, corrections: sql<number>`count(*)::int` })
        .from(corrections)
        .where(and(byPerson, gte(corrections.createdAt, fortnight)))
        .groupBy(corrections.actor)
        .having(sql`count(*) >= 2`)
        .orderBy(sql`count(*) desc`)
    ).map((r) => ({ actor: r.actor ?? "unknown", corrections: r.corrections }));

    const [corpus] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(eq(cases.projectId, p.id), eq(cases.status, "active")));

    out.push({
      projectId: p.id,
      name: p.name,
      gate: {
        stage,
        firstGatingAt: first ? new Date(first).toISOString() : null,
        lastGatingAt: last ? new Date(last).toISOString() : null,
        daysGating,
        recentWeeks,
        blockedARelease,
        repos: [
          ...new Set(gating.map((j) => (typeof j.ci?.repo === "string" ? j.ci.repo : "")).filter(Boolean)),
        ],
      },
      corrections: {
        weekly,
        firstAt: firstAt?.toISOString() ?? null,
        weeksSinceFirst,
        perWeekFromWeekFour,
        lastAt: span?.lastAt ? new Date(span.lastAt).toISOString() : null,
      },
      corpus: {
        activeCases: corpus?.n ?? 0,
        floor: CORPUS_FLOOR,
        overFloor: (corpus?.n ?? 0) >= CORPUS_FLOOR,
      },
      eligible,
    });
  }
  return out;
}

/** The ISO year and week an instant falls in, in the shape isoWeekStart takes. */
export function isoWeekParts(ms: number): [number, number] {
  const d = new Date(ms);
  const day = d.getUTCDay() || 7;
  // The Thursday of this week decides which ISO year and week number the week belongs to.
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (4 - day) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.round((thursday - Date.UTC(year, 0, 4)) / (7 * DAY)) + 1;
  return [year, week];
}

/** The label Postgres' to_char(..., 'IYYY-"W"IW') produces for an instant. */
export function isoWeekOf(ms: number): string {
  const [y, w] = isoWeekParts(ms);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** Monday of an ISO week, as epoch ms. */
export function isoWeekStart(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  return jan4 - (dow - 1) * DAY + (week - 1) * 7 * DAY;
}

function render(all: ProjectPmf[]): string {
  if (all.length === 0) return "No projects on this database.";
  const lines: string[] = [];
  for (const p of all) {
    const g = p.gate;
    const gate =
      g.stage === "production"
        ? `production — ${g.daysGating}d on ${g.repos.join(", ") || "a repo"}${g.blockedARelease ? ", has blocked a build" : ""}`
        : g.stage === "gating"
          ? `gating — ${g.daysGating}d of ${PRODUCTION_DAYS}, ran in ${g.recentWeeks} of the last 4 weeks (needs ${PRODUCTION_MIN_WEEKS})${g.blockedARelease ? ", has blocked a build" : ""}`
          : g.stage === "ci"
            ? "runs in CI, but not on pull requests into the default branch"
            : g.stage === "manual"
              ? "replays by hand only"
              : "never replayed";
    const c = p.corrections;
    const retention =
      c.perWeekFromWeekFour === null
        ? c.firstAt
          ? `too early — week ${c.weeksSinceFirst + 1}, first correction ${c.firstAt.slice(0, 10)}`
          : "nobody has corrected anything"
        : `${c.perWeekFromWeekFour}/week from week four, last ${c.lastAt?.slice(0, 10)}`;
    const corpus = `${p.corpus.activeCases} active cases ${p.corpus.overFloor ? "— over" : "— under"} the ${CORPUS_FLOOR} floor`;
    lines.push(`${p.name}  (${p.projectId.slice(0, 8)})`);
    lines.push(`  gate        ${gate}`);
    lines.push(`  corrections ${retention}`);
    lines.push(`  corpus      ${corpus}`);
    lines.push(
      `  survey      ${
        p.eligible.length === 0
          ? "nobody eligible — nobody has corrected twice in a fortnight"
          : `${p.eligible.length} eligible: ${p.eligible.map((e) => `${e.actor} (${e.corrections})`).join(", ")}`
      }`,
    );
    lines.push("");
  }
  const production = all.filter((p) => p.gate.stage === "production").length;
  const sticky = all.filter((p) => (p.corrections.perWeekFromWeekFour ?? 0) > 0).length;
  lines.push(
    `${production} of ${all.length} in production · ${sticky} still correcting after week four · ${all.filter((p) => p.corpus.overFloor).length} over the corpus floor`,
  );
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("pmf.ts") || process.argv[1]?.endsWith("pmf.js")) {
  loadDotEnv();
  const { values } = parseArgs({
    options: { json: { type: "boolean" }, weeks: { type: "string" } },
    allowPositionals: false,
  });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const { db, sql } = createDb(url, { max: 1 });
  pmf(db, values.weeks ? Number(values.weeks) : 12)
    .then((all) => console.log(values.json ? JSON.stringify(all, null, 2) : render(all)))
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => sql.end());
}
