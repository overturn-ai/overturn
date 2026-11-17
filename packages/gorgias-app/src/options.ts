declare const chrome: { storage: { local: { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> } } };
const fields = ["overturn_api_key", "overturn_base_url", "agent", "reason_pack", "min_draft_chars"] as const;
const form = document.querySelector<HTMLFormElement>("form")!;
void chrome.storage.local.get([...fields, "require_reason", "capture_internal_notes"]).then((values) => {
  for (const field of fields) {
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) input.value = typeof values[field] === "string" ? values[field] as string : "";
  }
  for (const field of ["require_reason", "capture_internal_notes"] as const) {
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement) input.checked = typeof values[field] === "boolean" ? values[field] as boolean : field === "require_reason";
  }
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) values[field] = input.value.trim();
  }
  for (const field of ["require_reason", "capture_internal_notes"] as const) {
    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement) values[field] = input.checked;
  }
  void chrome.storage.local.set(values).then(() => { document.querySelector("output")!.textContent = "Saved. Reload your Gorgias ticket."; });
});
