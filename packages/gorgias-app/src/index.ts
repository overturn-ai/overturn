import { buildCapturePayload, countWords } from './capture';
import { SUPPORT_REASON_PACK, GorgiasTicket } from './types';

declare const Gorgias: any;

let currentDraft = '';
let selectedReason = '';
let reasonNote = '';
let requireReason = false;

async function initApp() {
  // Initialize Gorgias SDK
  await Gorgias.init();

  const container = document.getElementById('app');
  if (!container) return;

  // Listen for ticket updates (where drafts usually happen)
  Gorgias.on('ticket:updated', (ticket: GorgiasTicket) => {
    renderUI(ticket);
  });

  // Listen for draft changes in the reply box
  Gorgias.on('message:draft:updated', (data: { text: string }) => {
    currentDraft = data.text;
    updateStatus(data.text);
  });

  // Capture the send event
  Gorgias.on('message:sent', async (data: { text: string, ticket: GorgiasTicket }) => {
    if (currentDraft) {
      const payload = buildCapturePayload(
        data.ticket,
        currentDraft,
        data.text,
        selectedReason,
        reasonNote
      );

      // Non-blocking capture call
      fetch('/v1/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(err => console.error('Capture failed', err));
      
      // Reset state for next interaction
      currentDraft = '';
    }
  });
}

function updateStatus(text: string) {
  const statusEl = document.getElementById('draft-status');
  if (statusEl && text.length > 0) {
    const words = countWords(text);
    statusEl.innerText = `Draft inserted · ${words} words`;
    statusEl.style.display = 'block';
  } else if (statusEl) {
    statusEl.style.display = 'none';
  }
}

function renderUI(ticket: GorgiasTicket) {
  const container = document.getElementById('app');
  if (!container) return;

  container.innerHTML = `
    <div class="overturn-capture-widget">
      <div id="draft-status" style="display: none; color: #4a5568; font-size: 12px; margin-bottom: 8px; font-weight: 500;"></div>
      
      <div class="reason-picker">
        <label style="display: block; font-size: 12px; margin-bottom: 4px;">Reason for response ${requireReason ? '*' : ''}</label>
        <select id="reason-select" style="width: 100%; margin-bottom: 8px; padding: 4px;">
          <option value="">Select a reason...</option>
          ${SUPPORT_REASON_PACK.map(r => `<option value="${r.id}">${r.label}</option>`).join('')}
        </select>
        <textarea id="reason-note" placeholder="Optional note..." style="width: 100%; height: 40px; padding: 4px; font-size: 12px;"></textarea>
      </div>
    </div>
  `;

  const select = document.getElementById('reason-select') as HTMLSelectElement;
  select?.addEventListener('change', (e) => {
    selectedReason = (e.target as HTMLSelectElement).value;
  });

  const note = document.getElementById('reason-note') as HTMLTextAreaElement;
  note?.addEventListener('input', (e) => {
    reasonNote = (e.target as HTMLTextAreaElement).value;
  });
}

initApp().catch(console.error);
