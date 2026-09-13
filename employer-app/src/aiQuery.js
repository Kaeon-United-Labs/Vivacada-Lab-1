'use strict';
const { isEmployerEligible } = require('../../shared/eligibility');

const MOCK_MODE = (process.env.MOCK_MODE || 'false').toLowerCase() === 'true';
const MAX_CANDIDATES_PER_QUERY = parseInt(process.env.MAX_CANDIDATES_PER_QUERY, 10) || 50;

// Pulls every currently-eligible credential+holder pair. Transcript content
// is included only where the credential owner has separately turned on
// showTranscript for that specific credential — dataSharing makes a profile
// findable at all, showTranscript is a second, per-credential decision about
// how much of it is visible, and the AI never sees more than a human
// browsing the public credential page already could.
async function eligibleCandidates(db) {
  const creds = await db.collection('credentials').find({ visibility: 'public' }).toArray();
  const out = [];
  for (const c of creds) {
    const holder = await db.collection('users').findOne({ _id: c.userId });
    if (!isEmployerEligible(c, holder)) continue;
    let transcriptExcerpt = null;
    if (c.showTranscript) {
      const sub = await db.collection('submissions').findOne({ _id: c.submissionId });
      if (sub?.transcript) transcriptExcerpt = sub.transcript.filter((t) => t.role === 'user').map((t) => t.content).join('\n---\n').slice(0, 2000);
    }
    out.push({
      id: c._id, slug: c.publicSlug, name: holder.fullName, email: holder.email,
      subject: c.testRef.subject, level: c.testRef.level || c.testRef.derivedLevel || null, tier: c.tier,
      institutionName: c.institutionName, institutionLabel: c.institutionLabel || null, score: c.score,
      transcriptExcerpt
    });
  }
  return out;
}

// Cheap keyword overlap so the candidate SET sent to the model — and
// therefore the cost of a metered query — stays bounded and predictable,
// rather than growing with the whole eligible pool. Not the actual matching
// logic; the model does that. Just keeps the prompt a sane size.
function preRank(candidates, queryText) {
  const terms = (queryText || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const score = (c) => {
    const hay = `${c.subject} ${c.institutionName} ${c.transcriptExcerpt || ''}`.toLowerCase();
    return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };
  return candidates.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s).slice(0, MAX_CANDIDATES_PER_QUERY).map((x) => x.c);
}

function buildPrompt(candidates, queryText) {
  const listing = candidates.map((c, i) => `[${i}] ${c.name} — ${c.subject}${c.level ? ' (' + c.level + ')' : ''}, via ${c.institutionName}${c.institutionLabel ? ' [' + c.institutionLabel + ']' : ''}, score ${Math.round(c.score * 100)}%.${c.transcriptExcerpt ? ' Transcript excerpt: ' + c.transcriptExcerpt.slice(0, 500) : ''}`).join('\n\n');
  const sys = `You help an employer search verified exam candidates. Given a natural-language request and a numbered list of candidates, return ONLY a JSON array of the best-matching candidate indices with a one-sentence rationale each: [{"index": 0, "rationale": "..."}]. Only include genuinely relevant matches — an empty array is a valid answer if nothing fits. Never invent information not present in the listing.`;
  const usr = `Request: "${queryText}"\n\nCandidates:\n${listing}`;
  return { sys, usr };
}

async function callModel(sys, usr) {
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;
  const pricing = require('./pricing');
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.LLM_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: pricing.MAX_OUTPUT_TOKENS, system: sys, messages: [{ role: 'user', content: usr }] })
    });
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return { text, inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
  }
  const endpoint = process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model, max_tokens: pricing.MAX_OUTPUT_TOKENS, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] })
  });
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || '', inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens };
}

async function search({ db, queryText }) {
  const pricing = require('./pricing');
  const all = await eligibleCandidates(db);
  const candidates = preRank(all, queryText);

  if (MOCK_MODE || !process.env.LLM_PROVIDER) {
    // Deterministic mock: "match" anything whose subject or institution
    // shares a keyword with the query, canned usage numbers for predictable
    // metered-cost testing.
    const terms = queryText.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const matches = candidates.filter((c) => terms.some((t) => c.subject.toLowerCase().includes(t))).slice(0, 10)
      .map((c) => ({ ...c, rationale: `Matches on subject relevance to "${queryText}".` }));
    return { matches, usage: { inputTokens: 400, outputTokens: 80 } };
  }

  const { sys, usr } = buildPrompt(candidates, queryText);
  const { text, inputTokens, outputTokens } = await callModel(sys, usr);
  let picks = [];
  try { picks = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch (_) { picks = []; }
  const matches = picks.filter((p) => candidates[p.index]).map((p) => ({ ...candidates[p.index], rationale: p.rationale }));
  return {
    matches,
    usage: { inputTokens: inputTokens ?? pricing.estimateInputTokens(sys + usr), outputTokens: outputTokens ?? Math.ceil((text || '').length / 4) }
  };
}

module.exports = { search, eligibleCandidates };
