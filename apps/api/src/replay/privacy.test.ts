import type { IngestPayload, ReplayJob } from "@overturn-ai/shared";
import { toolFingerprint } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { echoModel, startFakeOpenAI } from "../test/fake-openai";
import { api, startTestApp, type TestContext } from "../test/harness";

// This file boots its own app with an OpenAI key so "openai/" is configured on the server and the
// only thing standing between a replay and the vendor is the project's privacy switch.
let ctx: TestContext;
let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;

beforeAll(async () => {
  fake = await startFakeOpenAI();
  process.env.FAKE_OPENAI_URL = fake.url;
  process.env.LOCAL_MODEL_BASE_URL = fake.url;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
  await fake.close();
});

async function recordRun(externalId: string): Promise<void> {
  const runId = uuidv7();
  const t0 = new Date().toISOString();
  const payload: IngestPayload = {
    v: 1,
    runs: [
      {
        id: runId,
        agent: "privacy-agent",
        externalId,
        status: "completed",
        input: { id: externalId },
        output: { priority: "P1" },
        startedAt: t0,
        endedAt: t0,
      },
    ],
    steps: [
      {
        id: uuidv7(),
        runId,
        seq: 0,
        kind: "tool_call",
        name: "lookup",
        input: { email: "a@b.c" },
        output: { plan: "pro" },
        fingerprint: toolFingerprint("lookup", { email: "a@b.c" }),
        startedAt: t0,
      },
      {
        id: uuidv7(),
        runId,
        seq: 1,
        kind: "llm_call",
        name: "chat.completions",
        model: "fake-triage-v1",
        provider: "openai",
        input: { messages: [{ role: "user", content: externalId }] },
        output: {
          message: { role: "assistant", content: JSON.stringify({ priority: "P1" }) },
          finish_reason: "stop",
        },
        startedAt: t0,
      },
    ],
  };
  const res = await api(ctx, "POST", "/v1/ingest", payload);
  expect(res.status).toBe(202);
  const c = await api(ctx, "POST", "/v1/corrections", {
    runId,
    kind: "approve",
    expected: { priority: "P1" },
  });
  expect(c.status).toBe(201);
}

async function waitForJob(id: string): Promise<ReplayJob> {
  for (let i = 0; i < 100; i++) {
    const j = await api<ReplayJob>(ctx, "GET", `/v1/replays/${id}`);
    if (j.body.status !== "pending" && j.body.status !== "running") return j.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not finish");
}

describe("settings.privacy.hostedModelCalls", () => {
  it("defaults on; off refuses openai/ with a message naming the switch, local/ still replays", async () => {
    await recordRun("priv-1");
    const project = await api<{ settings: { privacy: { hostedModelCalls: boolean } } }>(
      ctx,
      "GET",
      "/v1/project",
    );
    expect(project.body.settings.privacy.hostedModelCalls).toBe(true);

    // on: the hosted provider is configured and the replay is accepted
    const hostedOn = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      filter: { agent: "privacy-agent" },
    });
    expect(hostedOn.status).toBe(201); // accepted (not awaited: it would call the real vendor)

    const off = await api<{ settings: { privacy: { hostedModelCalls: boolean } } }>(
      ctx,
      "PATCH",
      "/v1/project",
      {
        settings: { privacy: { hostedModelCalls: false } },
      },
    );
    expect(off.status).toBe(200);
    expect(off.body.settings.privacy.hostedModelCalls).toBe(false);

    const refused = await api<{ message: string }>(ctx, "POST", "/v1/replays", {
      model: "openai/gpt-4.1-mini",
      filter: { agent: "privacy-agent" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("settings.privacy.hostedModelCalls");
    expect(refused.body.message).toContain("local/");

    // the judge and embeddings fall back too: the examples endpoint goes lexical under an openai/ embedder
    await api(ctx, "PATCH", "/v1/project", { settings: { embeddingModel: "openai/text-embedding-3-small" } });
    const ex = await api<{ embeddingModel: string }>(
      ctx,
      "GET",
      `/v1/examples?input=${encodeURIComponent("priv")}&k=1&agent=privacy-agent`,
    );
    expect(ex.body.embeddingModel).toBe("lexical");

    // a fine-tune would upload the correction set: refused with the same message
    const train = await api<{ message: string }>(ctx, "POST", "/v1/models", {
      baseModel: "meta-llama/Llama-3.1-8B-Instruct-Reference",
      method: "sft",
    });
    expect(train.status).toBe(400);
    expect(train.body.message).toMatch(/hostedModelCalls|TOGETHER_API_KEY/);

    // local/ never leaves the network and keeps working
    const local = await api<{ job: ReplayJob }>(ctx, "POST", "/v1/replays", {
      model: `local/${echoModel({ priority: "P1" }).slice("fake/".length)}`,
      filter: { agent: "privacy-agent" },
    });
    expect(local.status).toBe(201);
    const job = await waitForJob(local.body.job.id);
    expect(job.status).toBe("completed");
  });
});
