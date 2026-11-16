import type { CaptureResult } from "@overturn-ai/shared";
import { quickReasons, settingsFrom } from "./capture";
import { type ControllerView, createCaptureController, type FrontContext, type FrontSdk } from "./controller";

interface FrontPluginSdk extends FrontSdk {
  contextUpdates: {
    subscribe(handler: (context: FrontContext) => void): { unsubscribe(): void };
  };
}

declare global {
  interface Window {
    Front?: FrontPluginSdk;
    OVERTURN_FRONT_CONFIG?: Record<string, unknown>;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;
  const sdk = window.Front;
  if (!sdk) {
    root.textContent = "Front Plugin SDK did not load.";
    return;
  }
  const settings = settingsFrom(window.OVERTURN_FRONT_CONFIG ?? {});
  const heading = element("h1", "", "Overturn");
  const status = element("div", "status", "Select a conversation");
  const hint = element("div", "hint", "A draft must appear before the conversation is read.");
  const quick = element("div", "quick");
  quick.setAttribute("role", "radiogroup");
  quick.setAttribute("aria-label", "Why did you change the draft?");
  const note = element("textarea", "") as HTMLTextAreaElement;
  note.placeholder = "Anything else? Optional.";
  const mark = element("button", "link", "Use current text as draft") as HTMLButtonElement;
  mark.type = "button";
  const feedback = element("div", "note");
  root.replaceChildren(heading, status, hint, quick, note, mark, feedback);

  const chips = new Map<string, HTMLButtonElement>();
  const view: ControllerView = {
    render: (statusText, hintText) => {
      status.textContent = statusText;
      hint.textContent = hintText;
    },
    showFeedback: (text) => {
      feedback.textContent = text;
    },
    readNote: () => note.value,
    writeNote: (text) => {
      note.value = text;
    },
    selectReason: (code) => {
      for (const [option, chip] of chips) {
        const selected = code === option;
        chip.classList.toggle("on", selected);
        chip.setAttribute("aria-pressed", String(selected));
      }
    },
  };

  // The Plugin SDK offers no send callback. A sidebar stays open while Front
  // sends; the controller polls the documented draft and message methods to
  // confirm the actual send. All state lives in the controller, per
  // conversation; this file is only the DOM wiring.
  const controller = createCaptureController({
    sdk,
    settings,
    view,
    postCapture: async (url, body) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Overturn-Capture": "1" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as CaptureResult;
    },
  });

  for (const option of quickReasons(settings)) {
    const chip = element("button", "", option.label) as HTMLButtonElement;
    chip.type = "button";
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      void controller.toggleReason(option.code);
    });
    chips.set(option.code, chip);
    quick.appendChild(chip);
  }

  mark.addEventListener("click", () => {
    void controller.markDraft();
  });

  sdk.contextUpdates.subscribe((next) => {
    controller.onContext(next);
  });
  setInterval(() => void controller.poll(), 1200);
}

main();
