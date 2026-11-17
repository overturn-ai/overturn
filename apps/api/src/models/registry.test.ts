import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";

describe("resolveJudgeModel", () => {
  it("keeps the project's judge when its provider has a key, else falls back to a configured provider", async () => {
    const { ModelRegistry } = await import("./registry");
    const base = { DATABASE_URL: "postgres://x/y", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
    const only = (keys: Record<string, string>) => new ModelRegistry(loadConfig({ ...base, ...keys }));
    expect(only({ OPENAI_API_KEY: "k" }).resolveJudgeModel("openai/gpt-4.1-mini")).toBe(
      "openai/gpt-4.1-mini",
    );
    expect(only({ ANTHROPIC_API_KEY: "k" }).resolveJudgeModel("openai/gpt-4.1-mini")).toBe(
      "anthropic/claude-haiku-5-5",
    );
    expect(only({ ANTHROPIC_API_KEY: "k" }).resolveJudgeModel("anthropic/claude-sonnet-5-5")).toBe(
      "anthropic/claude-sonnet-5-5",
    );
    expect(only({ OPENAI_API_KEY: "k" }).resolveJudgeModel("anthropic/claude-haiku-5-5")).toBe(
      "openai/gpt-4.1-mini",
    );
    expect(only({}).resolveJudgeModel("openai/gpt-4.1-mini")).toBeNull();
  });

  it("falls back to Anthropic first when several providers have keys", async () => {
    const { ModelRegistry } = await import("./registry");
    const both = new ModelRegistry(
      loadConfig({ DATABASE_URL: "postgres://x/y", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" }),
    );
    expect(both.resolveJudgeModel("google/gemini-2.5-flash")).toBe("anthropic/claude-haiku-5-5");
  });

  it("judges a default project with only ANTHROPIC_API_KEY on the default Claude model, no fallback", async () => {
    const { ModelRegistry } = await import("./registry");
    const { projectSettingsSchema } = await import("@overturn-ai/shared");
    const { judgeModel } = projectSettingsSchema.parse({});
    expect(judgeModel).toBe("anthropic/claude-haiku-5-5");
    const anthropicOnly = new ModelRegistry(
      loadConfig({ DATABASE_URL: "postgres://x/y", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "k" }),
    );
    // the replay service warns exactly when the resolved judge differs from the project's
    expect(anthropicOnly.resolveJudgeModel(judgeModel)).toBe(judgeModel);
  });
});

describe("hosted model calls off", () => {
  it("refuses every hosted provider with a message naming the switch; local and fake stay", async () => {
    const { HOSTED_PROVIDERS, ModelRegistry, hostedOffMessage } = await import("./registry");
    const on = new ModelRegistry(
      loadConfig({
        DATABASE_URL: "postgres://x/y",
        OPENAI_API_KEY: "k",
        ANTHROPIC_API_KEY: "k",
        TOGETHER_API_KEY: "k",
        LOCAL_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
      }),
    );
    expect(on.scoped(true)).toBe(on);
    const off = on.scoped(false);
    expect(off).not.toBe(on);
    for (const p of ["openai", "anthropic", "together"]) {
      expect(on.isConfigured(p)).toBe(true);
      expect(off.isConfigured(p)).toBe(false);
    }
    expect(() => off.languageModel("openai/gpt-4.1-mini")).toThrow(hostedOffMessage("openai"));
    expect(() => off.embeddingModel("openai/text-embedding-3-small")).toThrow("hostedModelCalls");
    expect(off.isConfigured("local")).toBe(true);
    expect(off.isConfigured("fake")).toBe(true);
    expect(off.resolveJudgeModel("openai/gpt-4.1-mini")).toBeNull();
    expect(HOSTED_PROVIDERS).toContain("openrouter");
    expect(HOSTED_PROVIDERS).toContain("google");
  });
});
