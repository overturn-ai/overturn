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
      "anthropic/claude-haiku-4-5",
    );
    expect(only({ ANTHROPIC_API_KEY: "k" }).resolveJudgeModel("anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(only({}).resolveJudgeModel("openai/gpt-4.1-mini")).toBeNull();
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
