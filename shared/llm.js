'use strict';
const interview = require('./interview');
const LEVELS = interview.LEVELS;

function live() {
  return !!(process.env.LLM_PROVIDER && process.env.LLM_MODEL && (process.env.LLM_API_KEY || process.env.LLM_ENDPOINT));
}
function modelUsed() {
  if (!live()) return { provider: 'mock', name: 'vivacada-mock-1' };
  return { provider: process.env.LLM_PROVIDER, name: process.env.LLM_MODEL };
}

// Minimal OpenAI-compatible / Anthropic-compatible chat call. `sys` is a
// system prompt, `messages` is [{role,content}]. Returns plain text.
async function chat(sys, messages) {
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.LLM_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: sys, messages })
    });
    const data = await res.json();
    return (data.content || []).map((b) => b.text || '').join('').trim();
  }
  const endpoint = process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, ...messages] })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function genOpener({ attemptSeed, testRef, competencies, sched, threadOrdinal, askedSoFar }) {
  if (live()) {
    const levelClause = testRef.tier === 'special'
      ? `Judge the depth and rigor this subject calls for entirely from its own description below — do not assume or name any difficulty tier. `
      : `You are generating ONE interview question for a "${testRef.level}"-level assessment. `;
    const sys = `You are Vivacada's examiner generating ONE interview question for an assessment in "${testRef.title}". `
      + levelClause
      + (testRef.description ? `Description: "${testRef.description}". ` : '')
      + `Topic thread: "${sched.label}". `
      + (sched.openerConcrete ? `Write a CONCRETE, field-specific task (write code, compute a quantity, derive a result). `
        : `Write a BROAD, abstract question (a misconception, a boundary of the field, an open problem). `)
      + `Match rigor to what's implied above. Do NOT reuse any question already asked. Return ONLY the question text. Attempt token: ${attemptSeed.slice(0,8)}.`;
    const usr = `Already asked:\n${(askedSoFar||[]).map((q,i)=>`${i+1}. ${q}`).join('\n') || '(none)'}\n\nWrite the next question.`;
    try { const out = await chat(sys, [{ role: 'user', content: usr }]); if (out) return out; } catch (_) {}
  }
  return interview.openerFor(attemptSeed, testRef, competencies, sched, threadOrdinal, askedSoFar);
}

async function genFollowUp({ attemptSeed, testRef, sched, threadOrdinal, qInThread, lastAnswer, askedSoFar }) {
  if (live()) {
    const levelClause = testRef.tier === 'special'
      ? `Judge the depth and rigor this subject calls for entirely from its own description below — do not assume or name any difficulty tier. `
      : `This is a "${testRef.level}"-level assessment. `;
    const sys = `You are Vivacada's examiner running a Socratic thread on "${sched.label}" in an assessment in "${testRef.title}". `
      + levelClause
      + (testRef.description ? `Description: "${testRef.description}". ` : '')
      + `Write ONE follow-up building directly on the candidate's last answer. This is follow-up #${qInThread}; a thread never exceeds 3 questions. Return ONLY the question text.`;
    const usr = `Candidate's answer:\n"""${(lastAnswer||'').slice(0,4000)}"""\n\nWrite the follow-up.`;
    try { const out = await chat(sys, [{ role: 'user', content: usr }]); if (out) return out; } catch (_) {}
  }
  return interview.followUpText(attemptSeed, testRef, sched, threadOrdinal, qInThread, lastAnswer);
}

// Derives a topic-thread plan (level + competencies) from a special-catalog
// entry's description — the description is the sole basis for generation,
// since special-catalog subjects have no student-chosen level.
async function deriveSpecFromDescription(description) {
  if (live()) {
    const sys = 'You turn a subject description into JSON: {competencies:[6-10 topic areas spanning the subject], derivedLevel: beginner|intermediate|junior|senior|expert, title: short subject name}. Respond ONLY with JSON.';
    try {
      const out = await chat(sys, [{ role: 'user', content: description }]);
      const parsed = JSON.parse(out.replace(/```json|```/g, '').trim());
      if (parsed.competencies?.length && LEVELS.includes(parsed.derivedLevel)) return parsed;
    } catch (_) {}
  }
  // mock: derive a plausible level from keywords, generic competency spread
  const text = description.toLowerCase();
  let derivedLevel = 'intermediate';
  if (/beginner|intro|basic|new to/.test(text)) derivedLevel = 'beginner';
  else if (/senior|advanced|expert|lead|architect/.test(text)) derivedLevel = 'senior';
  else if (/expert|principal|staff/.test(text)) derivedLevel = 'expert';
  else if (/junior|entry.level/.test(text)) derivedLevel = 'junior';
  const title = description.split(/[.,\n]/)[0].slice(0, 60).trim() || 'Custom subject';
  return {
    title, derivedLevel,
    competencies: ['core concepts', 'applied problem-solving', 'communication of reasoning', 'edge cases & limits', 'tooling & methods', 'connections to related work']
  };
}

// ---- scoring (heuristic mock; a live grading pass could replace this) ----
function answerScore(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  const words = t.split(/\s+/).filter(Boolean).length;
  const hasStructure = /(because|therefore|however|first|second|e\.g\.|for example|trade-?off)/i.test(t);
  const hasSpecific = /\d/.test(t) || /`[^`]+`/.test(t) || /=|\+|\{|\}/.test(t);
  let s = Math.min(1, words / 90);
  if (hasStructure) s += 0.2;
  if (hasSpecific) s += 0.15;
  if (words < 4) s = 0.05;
  return Math.max(0, Math.min(1, s));
}

function score({ transcript, level, passThreshold = 0.55 }) {
  const li = interview.levelIdx(level); // clamped to 0 for unrecognized levels — never silently over-lenient
  const leniency = 1 + (2 - li) * 0.06;
  const answers = transcript.filter((t) => t.role === 'user');
  const byThread = {};
  for (const a of answers) {
    const key = a.threadLabel || 'General';
    byThread[key] = byThread[key] || [];
    byThread[key].push(Math.min(1, answerScore(a.content) * leniency));
  }
  const topics = []; let total = 0, n = 0;
  for (const [label, scores] of Object.entries(byThread)) {
    const avg = scores.reduce((x, y) => x + y, 0) / scores.length;
    total += avg; n++;
    topics.push({ topic: label, rating: avg > 0.7 ? 'strong' : avg > 0.5 ? 'adequate' : avg > 0.25 ? 'weak' : 'not demonstrated', raw: avg });
  }
  const bar = passThreshold + li * 0.04;
  const s = n ? total / n : 0;
  return { outcome: s >= bar ? 'pass' : 'fail', score: Math.round(s * 100) / 100, perTopic: topics.map(({ topic, rating }) => ({ topic, rating })), _raw: topics };
}

function feedback({ result, testRef }) {
  const weak = result._raw.filter((t) => t.raw <= 0.5).sort((a, b) => a.raw - b.raw);
  const strong = result._raw.filter((t) => t.raw > 0.7);
  const isSpecial = testRef.tier === 'special';
  const summary = result.outcome === 'pass'
    ? `Solid${isSpecial ? '' : ` ${testRef.level}-level`} performance in ${testRef.title}. ${strong.length ? 'Particular strength in ' + strong.slice(0,2).map(t=>t.topic).join(', ') + '.' : ''}`
    : `This attempt fell short${isSpecial ? '' : ` of the ${testRef.level} bar`} in ${testRef.title}. ${weak.length ? 'Focus areas: ' + weak.slice(0,3).map(t=>t.topic).join(', ') + '.' : ''}`;
  const didWell = strong.slice(0, 3).map((t) => t.topic);
  const out = { summary, didWell, studyOrder: weak.map((t) => t.topic) };
  if (result.outcome === 'fail') {
    out.studyPlan = weak.slice(0, 5).map((t) => ({ topic: t.topic, why: `Answers on ${t.topic} were thin or unstructured — revisit fundamentals and practice explaining your reasoning step by step.`, resources: [] }));
    out.advice = 'Retakes are unlimited. Review the weakest topics above before your next attempt.';
  } else {
    out.weakestDespitePass = weak.slice(0, 2).map((t) => t.topic);
    // Special-catalog tests have no level ladder to climb, so there's no "next level" to suggest.
    if (!isSpecial) out.nextLevel = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(testRef.level) + 1)];
  }
  return out;
}

module.exports = { chat, live, modelUsed, genOpener, genFollowUp, deriveSpecFromDescription, score, feedback, LEVELS };
