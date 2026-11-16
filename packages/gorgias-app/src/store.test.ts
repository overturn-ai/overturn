import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TicketState } from "./handler";
import { createFileStore } from "./store";

const dirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overturn-gorgias-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function state(over: Partial<TicketState> = {}): TicketState {
  return {
    draft: { text: "the draft", origin: "recorded", at: 1, fields: { refund_amount: 0 } },
    reason: { code: "wrong_answer", note: "ships Monday", at: 2 },
    seenReplyId: 9,
    consumedRunIds: ["run-1"],
    lastResult: null,
    pending: null,
    note: null,
    ...over,
  };
}

describe("the file store", () => {
  it("keeps the progress the reviewer would miss: draft, reason, seen reply, spent runs", async () => {
    const path = await tempFile();
    const first = createFileStore(path);
    await first.set("48213", state());

    // A new process, same file.
    const second = createFileStore(path);
    expect(await second.get("48213")).toEqual(state());
    expect(await second.get("other")).toMatchObject({ draft: null, consumedRunIds: [] });
  });

  it("keeps a capture waiting for its reason across a restart", async () => {
    const path = await tempFile();
    const held = state({
      draft: null,
      pending: {
        body: {
          source: "gorgias",
          externalId: "gr:48213",
          agent: "support-reply",
          context: [],
          draft: { text: "draft" },
          sent: { text: "sent" },
        },
        replyId: 9,
        changedFields: [],
      },
    });
    await createFileStore(path).set("48213", held);

    const restarted = await createFileStore(path).get("48213");
    expect(restarted.pending?.body.sent).toEqual({ text: "sent" });
    expect(restarted.pending?.replyId).toBe(9);
  });

  it("starts empty when there is no file yet, and says nothing about it", async () => {
    const store = createFileStore(await tempFile());
    expect((await store.get("1")).draft).toBeNull();
  });

  it("survives a corrupt file rather than failing every request", async () => {
    const path = await tempFile();
    await writeFile(path, "{ this is not json", "utf8");
    const store = createFileStore(path);
    expect((await store.get("1")).draft).toBeNull();
    // And it recovers: the next write replaces the bad file.
    await store.set("1", state());
    expect((await createFileStore(path).get("1")).seenReplyId).toBe(9);
  });

  it("never leaves a half-written file behind", async () => {
    const path = await tempFile();
    const store = createFileStore(path);
    await Promise.all([store.set("1", state()), store.set("2", state({ seenReplyId: 10 }))]);
    const saved = JSON.parse(await readFile(path, "utf8")) as { v: number; tickets: unknown[] };
    expect(saved.v).toBe(1);
    expect(saved.tickets).toHaveLength(2);
  });
});
