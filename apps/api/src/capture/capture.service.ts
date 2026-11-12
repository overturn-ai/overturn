import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  type CaptureCreate,
  type CaptureResult,
  type CaptureStats,
  type CaptureStatsQuery,
  captureAnswerValue,
  captureSystemPrompt,
  type DraftOrigin,
  diffCaptureAnswers,
  extractAnswer,
  projectSettingsSchema,
  reasonCodeLabel,
  renderCaptureContext,
  SUITE_EXCLUDED_REASON_CODES,
} from "@overturn-ai/shared";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { CorrectionsService } from "../corrections/corrections.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { corrections, projects, runs, steps } from "../db/schema";
import { IngestService } from "../ingest/ingest.service";

/**
 * Capture is the correction made where the expert already works: the draft the AI (or a
 * junior) produced, what the expert actually sent, and why. It lands as a recorded run with
 * one model step (so the suite can replay it against any model) plus the correction that
 * freezes the case. The drafting agent never has to be instrumented.
 */
@Injectable()
export class CaptureService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ingest: IngestService,
    private readonly corrections: CorrectionsService,
  ) {}

  async create(projectId: string, input: CaptureCreate): Promise<CaptureResult> {
    const diff = diffCaptureAnswers(input.draft, input.sent);
    const draftValue = captureAnswerValue(input.draft);
    const sentValue = captureAnswerValue(input.sent);

    const { runId, stepId } = await this.resolveRun(projectId, input, draftValue);

    const kind = diff.changed ? "edit" : "approve";
    const result = await this.corrections.create(projectId, {
      runId,
      stepId,
      kind,
      correctedOutput: diff.changed ? sentValue : undefined,
      note: input.reason ?? null,
      reasonCode: input.reasonCode ?? null,
      secondsToSend: input.secondsToSend ?? null,
      actor: input.actor ?? null,
      source: "capture",
    });

    return {
      runId,
      stepId,
      kind,
      changed: diff.changed,
      changedFields: diff.changedFields,
      correction: result.correction,
      case: result.case,
      deduplicated: result.deduplicated,
    };
  }

  /**
   * The scorecard a claims leader reads: how many drafts went out untouched, who is fixing
   * the rest, and why. Only captures count (source = capture), so SDK/UI corrections on
   * instrumented agents do not dilute it.
   */
  async stats(projectId: string, q: CaptureStatsQuery): Promise<CaptureStats> {
    const since = new Date(Date.now() - q.days * 86_400_000);
    const base = [
      eq(corrections.projectId, projectId),
      eq(corrections.source, "capture"),
      gte(corrections.createdAt, since),
      ...(q.agent ? [eq(runs.agent, q.agent)] : []),
    ];
    const where = [...base, ...(q.origin === "all" ? [] : [sql`${DRAFT_ORIGIN} = ${q.origin}`])];
    const edited = sql<number>`count(*) filter (where ${corrections.kind} = 'edit')::int`;
    const count = sql<number>`count(*)::int`;

    const [totals] = await this.db
      .select({ captures: count, edited, experts: sql<number>`count(distinct ${corrections.actor})::int` })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(and(...where));
    // Per-expert is credit only (fixes kept), and only when the admin turned it on. This query
    // must never select a rate, `edited` as a share, or `secondsToSend`: a per-person untouched
    // rate or a per-person stopwatch is exactly what turns the people correcting the AI into
    // the people being measured by it (docs/decisions.md).
    const byExpert = (await this.showByExpert(projectId))
      ? await this.db
          .select({ actor: corrections.actor, fixesKept: edited })
          .from(corrections)
          .innerJoin(runs, eq(runs.id, corrections.runId))
          .where(and(...where, eq(corrections.kind, "edit")))
          .groupBy(corrections.actor)
          .orderBy(desc(edited))
          .limit(50)
      : [];
    // Time from draft to send, as a team-level distribution over untouched sends: never grouped by actor.
    const bucket = sql<string>`case
      when ${corrections.secondsToSend} < 10 then '<10s'
      when ${corrections.secondsToSend} < 60 then '10-60s'
      when ${corrections.secondsToSend} < 300 then '1-5m'
      else '5m+' end`;
    const timeRows = await this.db
      .select({ label: bucket, count })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(and(...where, eq(corrections.kind, "approve"), sql`${corrections.secondsToSend} is not null`))
      .groupBy(bucket);
    const order = ["<10s", "10-60s", "1-5m", "5m+"];
    const timeToSend = {
      timed: timeRows.reduce((n, r) => n + r.count, 0),
      buckets: order.map((label) => ({ label, count: timeRows.find((r) => r.label === label)?.count ?? 0 })),
    };
    // The code when the expert picked one, else the note: a team on the picker gets a clean table.
    const reason = sql<string>`coalesce(${corrections.reasonCode}, lower(trim(${corrections.note})))`;
    const byReasonRows = await this.db
      .select({ reason, count })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(
        and(
          ...where,
          sql`(${corrections.reasonCode} is not null or (${corrections.note} is not null and trim(${corrections.note}) <> ''))`,
        ),
      )
      .groupBy(reason)
      .orderBy(desc(count))
      .limit(15);
    const byReason = byReasonRows.map((r) => ({
      reason: r.reason,
      label: reasonCodeLabel(r.reason) ?? r.reason,
      count: r.count,
      excluded: SUITE_EXCLUDED_REASON_CODES.includes(r.reason),
    }));
    const source = sql<string>`coalesce(${runs.metadata} ->> 'capture', 'custom')`;
    const bySource = await this.db
      .select({ source, count })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(and(...where))
      .groupBy(source)
      .orderBy(desc(count));
    const byOrigin = await this.db
      .select({ origin: sql<DraftOrigin>`${DRAFT_ORIGIN}`, captures: count, edited })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(and(...base))
      .groupBy(sql`${DRAFT_ORIGIN}`)
      .orderBy(sql`${DRAFT_ORIGIN}`);
    const byAgent = await this.db
      .select({ agent: runs.agent, captures: count, edited })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(and(...where))
      .groupBy(runs.agent)
      .orderBy(desc(count))
      .limit(20);
    const week = sql<Date>`date_trunc('week', ${corrections.createdAt})`;
    const weekly = await this.db
      .select({ weekStart: week, captures: count, edited })
      .from(corrections)
      .innerJoin(runs, eq(runs.id, corrections.runId))
      .where(and(...where))
      .groupBy(week)
      .orderBy(asc(week));

    const captures = totals?.captures ?? 0;
    const editedN = totals?.edited ?? 0;
    const rate = (c: number, e: number) => (c === 0 ? 0 : (c - e) / c);
    return {
      days: q.days,
      origin: q.origin,
      captures,
      untouched: captures - editedN,
      edited: editedN,
      untouchedRate: rate(captures, editedN),
      experts: totals?.experts ?? 0,
      byExpert,
      timeToSend,
      byReason,
      bySource,
      byOrigin,
      byAgent,
      weekly: weekly.map((w) => ({ ...w, weekStart: new Date(w.weekStart).toISOString() })),
    };
  }

  private async showByExpert(projectId: string): Promise<boolean> {
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const parsed = projectSettingsSchema.safeParse(p?.settings ?? {});
    return parsed.success ? parsed.data.capture.showByExpert : false;
  }

  /**
   * The run the correction attaches to: the drafting agent's own run when it recorded one
   * (draftRunId, or the latest run on this externalId whose answer is this draft), else a
   * run synthesized from the thread and the draft.
   */
  private async resolveRun(
    projectId: string,
    input: CaptureCreate,
    draftValue: unknown,
  ): Promise<{ runId: string; stepId: string }> {
    if (input.draftRunId) {
      const found = await this.lastModelStep(projectId, input.draftRunId);
      if (!found) throw new NotFoundException(`Run ${input.draftRunId} not found or has no model step`);
      return found;
    }

    const candidates = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.externalId, input.externalId),
          eq(runs.agent, input.agent),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(5);
    for (const c of candidates) {
      const found = await this.lastModelStep(projectId, c.id);
      if (!found) continue;
      if (sameAnswer(found.answer, draftValue)) return found;
    }

    return this.synthesize(projectId, input, draftValue);
  }

  private async lastModelStep(
    projectId: string,
    runId: string,
  ): Promise<{ runId: string; stepId: string; answer: unknown } | null> {
    const [run] = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.id, runId)))
      .limit(1);
    if (!run) return null;
    const rows = await this.db.select().from(steps).where(eq(steps.runId, runId)).orderBy(asc(steps.seq));
    const step = [...rows].reverse().find((s) => s.kind === "llm_call");
    if (!step) return null;
    return { runId, stepId: step.id, answer: extractAnswer(step.output) };
  }

  private async synthesize(
    projectId: string,
    input: CaptureCreate,
    draftValue: unknown,
  ): Promise<{ runId: string; stepId: string }> {
    const runId = uuidv7();
    const stepId = uuidv7();
    const now = new Date().toISOString();
    const fields = input.draft.fields;
    const content = typeof draftValue === "string" ? draftValue : JSON.stringify(draftValue);
    await this.ingest.ingest(projectId, {
      v: 1,
      runs: [
        {
          id: runId,
          externalId: input.externalId,
          agent: input.agent,
          status: "completed",
          input: {
            source: input.source,
            externalId: input.externalId,
            subject: input.subject ?? null,
            context: input.context,
            ...(fields ? { fields } : {}),
            ...(input.url ? { url: input.url } : {}),
          },
          output: draftValue as never,
          metadata: { ...(input.metadata ?? {}), capture: input.source },
          tags: [`capture:${input.source}`, ...(input.tags ?? []), ...originTag(input)],
          startedAt: now,
          endedAt: now,
        },
      ],
      steps: [
        {
          id: stepId,
          runId,
          seq: 0,
          kind: "llm_call",
          name: "draft",
          model: input.draftModel ?? null,
          provider: input.draftProvider ?? null,
          input: {
            messages: [
              { role: "system", content: captureSystemPrompt(input.agent, input.source) },
              {
                role: "user",
                content: renderCaptureContext(input.context, { subject: input.subject, fields }),
              },
            ],
            ...(fields ? { response_format: { type: "json_object" } } : {}),
          },
          output: { message: { role: "assistant", content }, finish_reason: "stop" },
          startedAt: now,
          endedAt: now,
        },
      ],
    });
    return { runId, stepId };
  }
}

/**
 * Where the draft came from, as SQL over the run. The Zendesk app tags the run `draft:inserted`
 * (an assist or macro put it in the composer), `draft:preloaded` (it was there when the ticket
 * opened), `draft:recorded` (the drafting agent's own SDK run) or `draft:manual` (the expert
 * marked the text by hand). A run that was not synthesized by capture was recorded by the agent,
 * so it is AI too. Everything else is unknown: the scorecard never guesses.
 */
const DRAFT_ORIGIN = sql<DraftOrigin>`case
  when ${runs.tags} && array['draft:inserted','draft:preloaded','draft:recorded','draft:ai']::text[] then 'ai'
  when 'draft:manual' = any(${runs.tags}) then 'manual'
  when ${runs.metadata} ->> 'capture' is null then 'ai'
  else 'unknown' end`;

/** An API caller that names the drafting model has told us an AI wrote it; tag it so the scorecard can filter. */
function originTag(input: CaptureCreate): string[] {
  const hasOrigin = (input.tags ?? []).some((t) => t.startsWith("draft:"));
  if (hasOrigin) return [];
  return input.draftModel || input.draftProvider ? ["draft:ai"] : [];
}

function sameAnswer(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim() : JSON.stringify(sortKeys(v));
  return norm(a) === norm(b);
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, sortKeys(o[k])]),
  );
}
