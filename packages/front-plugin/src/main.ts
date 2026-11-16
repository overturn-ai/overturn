import {
  buildCapture,
  DEFAULT_SETTINGS,
  draftStatus,
  postCapture,
  quickReasons,
  settingsFrom,
  snapshotDraft,
  type FrontConversation,
  type FrontDraft,
  type FrontMessage,
  type FrontSettings,
} from "./capture";

interface FrontContext {
  type: string;
  conversation?: FrontConversation & { draftId?: string };
  teammate?: { name?: string; email?: string };
  fetchDraft?: (id: string) => Promise<FrontDraft | undefined>;
  listMessages?: () => Promise<{ results: FrontMessage[] }>;
}

interface FrontSdk {
  contextUpdates: {
    subscribe(handler: (context: FrontContext) => void): { unsubscribe(): void };
  };
}

interface PendingCapture {
  conversation: FrontConversation;
  messages: FrontMessage[];
  draft: NonNullable<ReturnType<typeof snapshotDraft>>;
  sent: string;
  sentMessageId: string;
  actor: string | null;
  captureSettings: Omit<FrontSettings, "apiKey">;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function start(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root");
  root.replaceChildren();
  const heading = element("h2", undefined, "Overturn for Front");
  const status = element("div", "status", "Waiting for a conversation");
  const detail = element("p", "muted small", "The plugin watches the selected conversation for a saved reply draft and a newly sent outbound message.");
  const settingsSection = element("section", "section");
  const agentLabel = element("label", "label", "Workflow / agent");
  const agentInput = element("input");
  agentInput.value = sessionStorage.getItem("overturn_agent") ?? DEFAULT_SETTINGS.agent;
  const packLabel = element("label", "label", "Reason pack");
  const packSelect = element("select");
  for (const value of ["support", "claims"] as const) {
    const option = element("option", undefined, value);
    option.value = value;
    packSelect.append(option);
  }
  packSelect.value = sessionStorage.getItem("overturn_reason_pack") ?? DEFAULT_SETTINGS.reasonPack;
  const requireLabel = element("label", "label", "Require a reason for changed replies");
  const requireInput = element("input");
  requireInput.type = "checkbox";
  requireInput.checked = sessionStorage.getItem("overturn_require_reason") !== "false";
  const keyLabel = element("label", "label", "Overturn project API key");
  const keyInput = element("input");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.placeholder = "ov_live_…";
  keyInput.value = sessionStorage.getItem("overturn_api_key") ?? "";
  const keyHelp = element("p", "muted small", "Stored only in this plugin tab for this session.");
  settingsSection.append(agentLabel, agentInput, packLabel, packSelect, requireLabel, requireInput, keyLabel, keyInput, keyHelp);

  const reasonsSection = element("section", "section");
  const reasonsLabel = element("label", "label", "Why was the reply changed?");
  const reasons = element("div", "grid");
  let reasonCode: string | null = null;
  const noteLabel = element("label", "label", "Optional note");
  const noteInput = element("textarea");
  noteInput.rows = 2;
  noteInput.placeholder = "One line explaining the correction";
  const reasonHelp = element("p", "muted small", "A changed reply is held for capture until a reason is selected when require_reason is enabled. Front's Plugin SDK does not expose a send-blocking hook.");
  reasonsSection.append(reasonsLabel, reasons, noteLabel, noteInput, reasonHelp);
  const message = element("p", "small", "");
  const retryButton = element("button", "button", "Retry capture");
  retryButton.type = "button";
  retryButton.hidden = true;
  root.append(heading, status, detail, settingsSection, reasonsSection, message, retryButton);

  const { default: importedFront } = await import("@frontapp/plugin-sdk");
  const front = importedFront as unknown as FrontSdk;
  let settings = settingsFrom({
    agent: sessionStorage.getItem("overturn_agent") ?? DEFAULT_SETTINGS.agent,
    require_reason: sessionStorage.getItem("overturn_require_reason") ?? "true",
    reason_pack: sessionStorage.getItem("overturn_reason_pack") ?? "support",
    overturn_base_url: sessionStorage.getItem("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl,
  }, keyInput.value);

  function renderReasons(): void {
    reasons.replaceChildren();
    for (const option of quickReasons(settings.reasonPack)) {
      const chip = element("button", "chip", option.label);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(reasonCode === option.code));
      chip.addEventListener("click", () => {
        reasonCode = reasonCode === option.code ? null : option.code;
        for (const button of Array.from(reasons.querySelectorAll("button"))) {
          button.setAttribute("aria-pressed", String(button === chip && reasonCode === option.code));
        }
        if (pendingQueue.length > 0) void tryCapturePending();
      });
      reasons.append(chip);
    }
  }
  renderReasons();

  let current: FrontContext | null = null;
  let draftSnapshot: ReturnType<typeof snapshotDraft> = null;
  let draftId: string | null = null;
  const pendingQueue: PendingCapture[] = [];
  let lastSentMessageId: string | null = null;
  let activeConversationId: string | null = null;
  let busy = false;
  let polling = false;

  keyInput.addEventListener("change", () => {
    sessionStorage.setItem("overturn_api_key", keyInput.value.trim());
    if (pendingQueue.length > 0) void tryCapturePending();
  });
  retryButton.addEventListener("click", () => void tryCapturePending());
  agentInput.addEventListener("change", () => {
    sessionStorage.setItem("overturn_agent", agentInput.value.trim() || DEFAULT_SETTINGS.agent);
    settings = { ...settings, agent: agentInput.value.trim() || DEFAULT_SETTINGS.agent };
  });
  packSelect.addEventListener("change", () => {
    const pack = packSelect.value === "claims" ? "claims" : "support";
    sessionStorage.setItem("overturn_reason_pack", pack);
    settings = { ...settings, reasonPack: pack };
    reasonCode = null;
    renderReasons();
  });
  requireInput.addEventListener("change", () => {
    sessionStorage.setItem("overturn_require_reason", String(requireInput.checked));
    settings = { ...settings, requireReason: requireInput.checked };
  });

  async function tryCapturePending(): Promise<void> {
    const pending = pendingQueue[0];
    if (!pending || busy) return;
    if (!keyInput.value.trim()) {
      message.textContent = "Enter your Overturn API key to save this capture.";
      message.className = "small error";
      retryButton.hidden = false;
      return;
    }
    const decision = buildCapture({
      ...pending,
      sent: pending.sent,
      actor: pending.actor,
      sentMessageId: pending.sentMessageId,
      reasonCode,
      reason: noteInput.value,
      settings: { ...pending.captureSettings, apiKey: keyInput.value.trim() },
    });
    if (decision.action === "need-reason") {
      message.textContent = "Reply sent. Select a reason to finish saving the capture.";
      message.className = "small error";
      retryButton.hidden = true;
      return;
    }
    if (decision.action !== "capture") return;
    busy = true;
    let saved = false;
    try {
      await postCapture(settings.baseUrl, keyInput.value.trim(), decision.body);
      pendingQueue.shift();
      saved = true;
      retryButton.hidden = true;
      message.textContent = decision.changed ? "Correction captured." : "Sent as drafted · approved";
      message.className = "small success";
      draftSnapshot = null;
      draftId = null;
      reasonCode = null;
      noteInput.value = "";
      for (const button of Array.from(reasons.querySelectorAll("button"))) button.setAttribute("aria-pressed", "false");
      status.textContent = pendingQueue.length > 0
        ? `Capture saved · ${pendingQueue.length} waiting in queue`
        : "Capture saved · waiting for the next draft";
    } catch (error) {
      message.textContent = `Capture failed; the reply was not affected. ${error instanceof Error ? error.message : "Network error"}`;
      message.className = "small error";
      retryButton.hidden = false;
    } finally {
      busy = false;
      if (saved && pendingQueue.length > 0) void tryCapturePending();
    }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    const context = current;
    const conversation = context?.conversation;
    if (!context || context.type !== "singleConversation" || !conversation || !context.listMessages) {
      status.textContent = "Select one conversation in Front";
      polling = false;
      return;
    }
    if (activeConversationId !== conversation.id) {
      activeConversationId = conversation.id;
      draftSnapshot = null;
      draftId = null;
      lastSentMessageId = null;
      if (pendingQueue.length === 0) {
        reasonCode = null;
        noteInput.value = "";
      }
    }
    try {
      // Fetch on each poll, not only when draftId changes: Front can update the body
      // of an existing draft without changing its ID (for example, an AI rewrite).
      if (conversation.draftId && context.fetchDraft) {
        const fetched = await context.fetchDraft(conversation.draftId);
        if (fetched) {
          const snapshot = snapshotDraft(fetched);
          if (snapshot && (fetched.id !== draftId || snapshot.text !== draftSnapshot?.text)) {
            draftSnapshot = snapshot;
            draftId = fetched.id;
            status.textContent = draftStatus(snapshot.text);
            message.textContent = "";
          }
        }
      }

      const response = await context.listMessages();
      const messages = response.results ?? [];
      const latestOutbound = [...messages].reverse().find((item) => item.status === "outbound");
      if (!latestOutbound) return;
      if (lastSentMessageId === null) {
        lastSentMessageId = latestOutbound.id;
        return;
      }
      if (latestOutbound.id === lastSentMessageId) return;
      if (!draftSnapshot) {
        lastSentMessageId = latestOutbound.id;
        return;
      }
      const sent = latestOutbound.content?.body ?? "";
      if (!sent.trim()) return;
      lastSentMessageId = latestOutbound.id;
      pendingQueue.push({
        conversation: { id: conversation.id, subject: conversation.subject },
        messages,
        draft: draftSnapshot,
        sent,
        sentMessageId: latestOutbound.id,
        actor: context.teammate?.email ?? context.teammate?.name ?? null,
        captureSettings: {
          baseUrl: settings.baseUrl,
          agent: settings.agent,
          requireReason: settings.requireReason,
          reasonPack: settings.reasonPack,
        },
      });
      const changed = draftSnapshot.text.trim() !== sent.trim();
      if (changed && settings.requireReason && !reasonCode && pendingQueue.length === 1) {
        message.textContent = "Reply sent. Select a reason to save the correction.";
        message.className = "small error";
      } else {
        await tryCapturePending();
      }
    } catch (error) {
      message.textContent = `Waiting for Front data: ${error instanceof Error ? error.message : "SDK error"}`;
      message.className = "small muted";
    }
    finally {
      polling = false;
    }
  }

  front.contextUpdates.subscribe((context) => {
    current = context;
    if (context.type !== "singleConversation") {
      status.textContent = "Select one conversation in Front";
      return;
    }
    void poll();
  });

  window.setInterval(() => void poll(), 2000);
}

void start().catch((error: unknown) => {
  document.getElementById("app")?.replaceChildren(element("p", "error", `Overturn could not start: ${error instanceof Error ? error.message : "Unknown error"}`));
});
