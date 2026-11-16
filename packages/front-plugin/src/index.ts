import Front from '@frontapp/plugin-sdk';
import { buildCapturePayload, sendCapture } from './capture';
import { PluginState, ReasonCode } from './types';

let state: PluginState = {
  originalDraft: null,
  currentReason: null,
  note: '',
  requireReason: true, // Default to true as per requirements
};

const REASON_CODES: ReasonCode[] = [
  'too_long', 'too_short', 'wrong_tone', 'inaccurate', 
  'formatting', 'missing_info', 'hallucination', 'other'
];

/**
 * UI Rendering logic
 */
function updateUI(draftText: string) {
  const root = document.getElementById('app');
  if (!root) return;

  const wordCount = draftText.trim().split(/\s+/).length;
  const isModified = state.originalDraft !== null && state.originalDraft !== draftText;

  root.innerHTML = `
    <div style="font-family: sans-serif; padding: 10px;">
      <div style="color: #666; font-size: 12px; margin-bottom: 10px;">
        Draft inserted · ${wordCount} words
      </div>
      
      ${isModified ? `
        <div style="margin-top: 10px;">
          <label style="display: block; font-weight: bold; font-size: 11px; margin-bottom: 5px;">
            WHY DID YOU CHANGE THE DRAFT?
          </label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px;">
            ${REASON_CODES.map(code => `
              <button 
                class="reason-btn ${state.currentReason === code ? 'active' : ''}" 
                data-reason="${code}"
                style="padding: 4px; font-size: 11px; cursor: pointer; border: 1px solid #ccc; background: ${state.currentReason === code ? '#e0e0e0' : '#fff'}"
              >
                ${code.replace('_', ' ')}
              </button>
            `).join('')}
          </div>
          <input 
            type="text" 
            id="note-input" 
            placeholder="Optional note..." 
            value="${state.note}"
            style="width: 100%; margin-top: 8px; padding: 4px; box-sizing: border-box;"
          />
        </div>
      ` : ''}
    </div>
  `;

  // Attach listeners
  document.querySelectorAll('.reason-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLButtonElement;
      state.currentReason = target.dataset.reason as ReasonCode;
      updateUI(draftText);
    });
  });

  const noteInput = document.getElementById('note-input') as HTMLInputElement;
  if (noteInput) {
    noteInput.addEventListener('input', (e) => {
      state.note = (e.target as HTMLInputElement).value;
    });
  }
}

/**
 * Front Plugin Initialization
 */
Front.subscribe('conversation', (data) => {
  if (!data) return;

  // Detect AI draft landing in reply box
  // In Front, we check the composer state
  // This is a simplified detection logic based on the SDK
});

Front.subscribe('composer', (composerState) => {
  const body = composerState.value.body || '';
  
  // Requirement 1: Detect draft landing
  // If we don't have an original draft yet and the body is significant, we treat it as the draft
  if (!state.originalDraft && body.length > 0) {
    state.originalDraft = body;
  }

  updateUI(body);
});

// Requirement 3 & 4: On send and validation
Front.onSubmit((event) => {
  const composerState = event.composer;
  const currentBody = composerState.value.body || '';
  const isModified = state.originalDraft !== null && state.originalDraft !== currentBody;

  // Requirement 4: Honours require_reason
  if (state.requireReason && isModified && !state.currentReason) {
    alert('Please select a reason for modifying the AI draft.');
    return; // This prevents the send in Front
  }

  // Requirement 3: POST /v1/capture
  // We don't await this to avoid blocking the UI, but the SDK handles the lifecycle
  Front.context.then(async (context) => {
    if (context.type !== 'conversation') return;

    const payload = buildCapturePayload({
      conversationId: context.conversation.id,
      subject: context.conversation.subject,
      messages: [], // In a real scenario, we'd fetch conversation history via Front API
      draftText: state.originalDraft || '',
      sentText: currentBody,
      reason: state.currentReason || undefined,
      note: state.note || undefined,
    });

    await sendCapture(payload);
  });
});
