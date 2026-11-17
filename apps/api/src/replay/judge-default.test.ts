import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CasesService } from "../cases/cases.service";
import { loadConfig } from "../config";
import type { Db } from "../db/client";
import type { ExamplesService } from "../examples/examples.service";
import { parseSettings } from "../projects/settings";
import type { PromptsService } from "./prompts.service";
import { ReplayService } from "./replay.service";

// scorerContext only reads config and settings until a judge call is made, so no database here.
function service(keys: Record<string, string>): ReplayService {
  const config = loadConfig({
    DATABASE_URL: "postgres://x/y",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ...keys,
  });
  return new ReplayService({} as Db, config, {} as CasesService, {} as PromptsService, {} as ExamplesService);
}

describe("default judge", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an Anthropic-only server judges a default project with Claude and logs no fallback", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const ctx = service({ ANTHROPIC_API_KEY: "k" }).scorerContext("p", parseSettings({}), () => {});
    expect(ctx.judge).toBeTypeOf("function");
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("judge "))).toEqual([]);
  });

  it("still says so when it has to fall back", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    service({ OPENAI_API_KEY: "k" }).scorerContext("p", parseSettings({}), () => {});
    expect(warn).toHaveBeenCalledWith(
      "judge anthropic/claude-haiku-5-5 has no key; using openai/gpt-4.1-mini",
    );
  });
});
