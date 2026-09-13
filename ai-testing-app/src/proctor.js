'use strict';
const storage = require('./storage');

const MOCK_MODE = (process.env.MOCK_MODE || 'false').toLowerCase() === 'true';
const MAX_TECHNICAL_RETRIES = parseInt(process.env.PROCTOR_MAX_RETRIES, 10) || 3;

// One general-purpose multimodal model does everything here: face-vs-ID match,
// reading the birthdate off the ID, confirming the requested gestures were
// performed (allowing for ordinary user error/retries, not exact timing),
// evaluating the room sweep, and flagging any other obvious cheating signal.
// A single conjunctive verdict — every check has to pass, any one failing is
// an overall reject. NOTE: this is written against each provider's documented
// multimodal API shape but has not been exercised against a real video-capable
// model in this environment. Expect real prompt-tuning iteration before this
// is reliable — video understanding plus fuzzy event correlation across
// segmented clips is a genuinely hard task for current models, not a solved
// problem a well-written prompt guarantees.

function videoModelConfigured() {
  return !!(process.env.VIDEO_MODEL_PROVIDER && process.env.VIDEO_MODEL && (process.env.VIDEO_MODEL_API_KEY || process.env.VIDEO_MODEL_ENDPOINT));
}

const SYSTEM_PROMPT = `You are Vivacada's automated exam proctor. You will be given several short video clips from one exam attempt, each labeled with the step it covers: face, id, gestures, sweep, exam. Some steps may have been retried by the user before the clip you're given — evaluate only what's in the clips provided, and allow for ordinary user error (a slightly off gesture, brief hesitation) as long as the user's actions aren't wildly out of sync with what was asked.

Check, independently:
1. face: a real person's face is clearly visible, matching normal expectations for an exam candidate.
2. id: a government-style ID is clearly shown and legible. Extract the birthdate printed on it in YYYY-MM-DD format.
3. face-vs-id: the face shown in the "face" clip visually matches the photo on the ID shown in the "id" clip.
4. gestures: the requested gesture list (given below) was performed, allowing for reasonable imprecision.
5. sweep: the room sweep looks like a genuine, unedited view of a real physical space, not overlaid, looped, or pre-recorded footage.
6. exam: nothing in the exam clip suggests a second person feeding answers, notes being read off-screen, or other obvious cheating.

Respond with ONLY a JSON object: {"approved": boolean, "birthdate": "YYYY-MM-DD" or null}. Approved is true only if ALL checks pass. If the ID is missing/illegible, or the face doesn't match, approved must be false and birthdate should reflect whatever was legible (or null). Do not include any other keys or commentary.`;

async function callVideoModel({ clipsByStep, gestureList }) {
  const provider = process.env.VIDEO_MODEL_PROVIDER;
  const model = process.env.VIDEO_MODEL;
  const parts = [];
  for (const [step, clip] of Object.entries(clipsByStep)) {
    parts.push({ type: 'text', text: `--- step: ${step} ---` });
    for (const track of ['webcamKey', 'screenKey']) {
      if (!clip[track]) continue;
      const bytes = await storage.getClipBytes(clip[track]);
      parts.push({ type: 'video', source: { type: 'base64', media_type: 'video/webm', data: bytes.toString('base64') } });
    }
  }
  const userText = `Requested gesture list: ${JSON.stringify(gestureList)}\n\nEvaluate the clips above.`;

  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.VIDEO_MODEL_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 512, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: [...parts, { type: 'text', text: userText }] }] })
    });
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }

  // OpenAI-compatible fallback (self-hosted or otherwise).
  const endpoint = process.env.VIDEO_MODEL_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.VIDEO_MODEL_API_KEY ? { authorization: `Bearer ${process.env.VIDEO_MODEL_API_KEY}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: [...parts, { type: 'text', text: userText }] }] })
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// Returns { outcome: 'approved' | 'rejected' | 'technical_failure', birthdate }.
// A technical_failure (network error, unparseable response, provider outage)
// is never treated as a rejection — the caller retries this call, and only
// exhausting MAX_TECHNICAL_RETRIES turns it into a terminal failure (which
// still costs the user another attempt, but is not the same thing internally
// as a model-confirmed reject; both currently surface identically to the user
// per the terms, but keeping them distinct server-side matters for debugging
// and for not miscounting infra outages as fraud signal).
async function analyzeAttempt({ clipsByStep, gestureList, mockOverride }) {
  if (MOCK_MODE || !videoModelConfigured()) {
    // Mock verdict for local development/demo — always approves with a
    // plausible adult birthdate unless the attempt explicitly requested a
    // mock rejection or a specific mock birthdate for testing.
    const forced = mockOverride || {};
    return { outcome: forced.forceReject ? 'rejected' : 'approved', birthdate: forced.birthdate || '1995-06-15' };
  }
  for (let attempt = 1; attempt <= MAX_TECHNICAL_RETRIES; attempt++) {
    try {
      const verdict = await callVideoModel({ clipsByStep, gestureList });
      if (typeof verdict.approved !== 'boolean') throw new Error('malformed verdict');
      return { outcome: verdict.approved ? 'approved' : 'rejected', birthdate: verdict.birthdate || null };
    } catch (e) {
      console.warn(`[proctor] analysis attempt ${attempt}/${MAX_TECHNICAL_RETRIES} failed: ${e.message}`);
      if (attempt === MAX_TECHNICAL_RETRIES) return { outcome: 'technical_failure', birthdate: null };
    }
  }
}

module.exports = { analyzeAttempt, videoModelConfigured, MAX_TECHNICAL_RETRIES };
