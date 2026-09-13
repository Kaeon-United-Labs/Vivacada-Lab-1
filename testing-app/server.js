require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const llm = require('../shared/llm');
const interview = require('../shared/interview');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const UNLOCK_CODE = process.env.UNLOCK_CODE || '';
const PROCTOR_CODE = process.env.PROCTOR_CODE || '';
const AGGREGATOR_ENDPOINT = process.env.AGGREGATOR_ENDPOINT || 'https://aggregator.vivacada.example/api';
const INSTITUTION_API_KEY = process.env.INSTITUTION_API_KEY || '';
const ALLOW_SPECIAL_CATALOG = (process.env.ALLOW_SPECIAL_CATALOG || 'true').toLowerCase() !== 'false';
const IDLE_TIMEOUT_MS = (parseInt(process.env.SESSION_IDLE_TIMEOUT_MIN, 10) || 15) * 60 * 1000;
const QUESTIONS_PER_EXAM = interview.QUESTIONS_PER_EXAM;
const LEVELS = interview.LEVELS;

if (!UNLOCK_CODE || !PROCTOR_CODE) {
  console.warn('[vivacada] WARNING: UNLOCK_CODE and/or PROCTOR_CODE not set. Set both before deploying to a public device.');
}

// ---------------- in-memory session store (no disk persistence) ----------------
const sessions = new Map();
const newToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();

function newSession() {
  const id = newToken();
  const s = {
    id, stage: 'email', createdAt: now(), lastActivity: now(),
    email: null, patronName: null, birthdate: null, testRef: null, competencies: null,
    attemptSeed: null, schedule: null, progress: null, transcript: [],
    result: null, feedback: null, proctorAttempts: 0, locked: false
  };
  sessions.set(id, s);
  return s;
}
function touch(s) { s.lastActivity = now(); }
setInterval(() => {
  const cutoff = now() - IDLE_TIMEOUT_MS;
  for (const [id, s] of sessions) if (s.lastActivity < cutoff) sessions.delete(id);
}, 60 * 1000).unref();

function sessionMiddleware(req, res, next) {
  const token = req.get('X-Session-Token');
  if (!token) return res.status(401).json({ error: 'No session. Unlock first.' });
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Session expired or invalid. Unlock again.' });
  if (s.locked) return res.status(403).json({ error: 'Session locked after too many incorrect proctor codes. Unlock a new session.' });
  touch(s);
  req.session = s;
  next();
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

function publicSession(s) {
  return {
    stage: s.stage, email: s.email, patronName: s.patronName, testRef: s.testRef,
    progress: s.progress, transcript: s.transcript,
    result: s.result, feedback: s.feedback
  };
}

// ---------------- auth ----------------
app.post('/api/unlock', wrap(async (req, res) => {
  const { code } = req.body || {};
  if (!UNLOCK_CODE || code !== UNLOCK_CODE) return res.status(401).json({ error: 'Incorrect unlock code.' });
  const s = newSession();
  res.json({ sessionToken: s.id, session: publicSession(s) });
}));

app.get('/api/session', sessionMiddleware, (req, res) => res.json({ session: publicSession(req.session) }));

app.post('/api/abandon', sessionMiddleware, (req, res) => {
  sessions.delete(req.session.id);
  res.json({ ok: true });
});

// ---------------- catalog (short cache; falls back to env list for main only) ----------------
// Levels are NOT catalog content: the five tiers (beginner..expert) are a fixed
// taxonomy wired directly into the grading engine by array position (see
// levelIdx() in src/interview.js and score() in src/llm.js) — an institution
// or the aggregator redefining them would silently miscalibrate every exam.
// Two catalogs: "main" is browsable with a student-chosen level; "special" is
// found only by typing its exact name into an autocomplete and carries no
// student-chosen level. The aggregator is the source of truth for both —
// SUBJECT_OPTIONS is a last-resort fallback for "main" only, for when the
// aggregator can't be reached at all; there's no local fallback for "special"
// since it's a supplementary feature, not the base offering.
const normalizeSubjectName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const CATALOG_CACHE_TTL_MS = (parseInt(process.env.CATALOG_CACHE_TTL_SEC, 10) || 30) * 1000;
let catalogCache = { at: 0, main: null, special: [] };
async function ensureCatalogFresh() {
  if (catalogCache.main && now() - catalogCache.at < CATALOG_CACHE_TTL_MS) return catalogCache;
  const shape = (list) => (Array.isArray(list) ? list.map((s) => (typeof s === 'string' ? { subject: s, description: null } : { subject: s.subject, description: s.description || null })) : []);
  try {
    const r = await fetch(`${AGGREGATOR_ENDPOINT}/catalog`);
    if (!r.ok) throw new Error('bad status');
    const data = await r.json();
    catalogCache = { at: now(), main: shape(data.main), special: shape(data.special) };
  } catch (_) {
    const main = (process.env.SUBJECT_OPTIONS || '').split(',').map((s) => s.trim()).filter(Boolean).map((subject) => ({ subject, description: null }));
    catalogCache = { at: now(), main, special: [], source: 'fallback' };
  }
  return catalogCache;
}
app.get('/api/catalog', sessionMiddleware, wrap(async (req, res) => {
  const c = await ensureCatalogFresh();
  res.json({ main: c.main, special: c.special, levels: LEVELS, ...(c.source ? { source: c.source } : {}) });
}));

// ---------------- flow ----------------
app.post('/api/email', sessionMiddleware, wrap(async (req, res) => {
  const { email, birthdate } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  // Age verification lives here, not at aggregator signup: the proctor who's
  // already watching the exam is trusted to confirm the birthdate the same
  // way they attest to the rest of the session. It travels with the result as
  // credential metadata and is never shown on the credential itself.
  const bd = new Date(birthdate);
  if (!birthdate || isNaN(bd.getTime()) || bd > new Date()) return res.status(400).json({ error: 'Enter a valid, non-future birthdate.' });
  req.session.email = email;
  req.session.birthdate = birthdate;
  req.session.stage = 'select';
  // Best-effort name lookup so the kiosk can greet a returning patron by name.
  // No account yet, or the aggregator is unreachable: fall back to showing the
  // email itself rather than nothing, so the corner display never looks broken.
  req.session.patronName = email;
  try {
    const r = await fetch(`${AGGREGATOR_ENDPOINT}/accounts/lookup?email=${encodeURIComponent(email)}`, {
      headers: { authorization: `Bearer ${INSTITUTION_API_KEY}` }
    });
    if (r.ok) {
      const data = await r.json();
      if (data.fullName) req.session.patronName = data.fullName;
    }
  } catch (_) { /* keep the email fallback */ }
  res.json({ session: publicSession(req.session) });
}));

app.post('/api/start', sessionMiddleware, wrap(async (req, res) => {
  const s = req.session;
  if (s.stage !== 'select') return res.status(400).json({ error: 'Not ready to start a test.' });
  const { mode, subject, level } = req.body || {};
  let testRef, competencies = null;
  const cat = await ensureCatalogFresh(); // never validate against a cold/empty cache

  if (mode === 'catalog') {
    if (!subject || !LEVELS.includes(level)) return res.status(400).json({ error: 'Pick a subject and level.' });
    const known = (cat.main || []).find((s) => s.subject === subject);
    if (!known) return res.status(400).json({ error: 'Pick a subject from the list.' });
    testRef = { tier: 'catalog', title: known.subject, subject: known.subject, level, description: known.description || undefined };
  } else if (mode === 'special') {
    if (!ALLOW_SPECIAL_CATALOG) return res.status(403).json({ error: 'The special catalog is disabled at this institution.' });
    const known = (cat.special || []).find((s) => normalizeSubjectName(s.subject) === normalizeSubjectName(subject));
    if (!known) return res.status(400).json({ error: 'Pick a valid special-catalog test from the suggestions.' });
    const spec = await llm.deriveSpecFromDescription(known.description);
    // Canonical catalog name, not whatever title the derivation might produce.
    testRef = { tier: 'special', title: known.subject, subject: known.subject, level: spec.derivedLevel, description: known.description };
    competencies = spec.competencies;
  } else {
    return res.status(400).json({ error: 'Pick catalog or special-catalog mode.' });
  }

  const attemptSeed = s.id + ':' + crypto.randomBytes(6).toString('hex');
  const schedule = interview.buildSchedule(attemptSeed, testRef, competencies);
  const firstSched = schedule[0];
  const firstQ = await llm.genOpener({ attemptSeed, testRef, competencies, sched: firstSched, threadOrdinal: 0, askedSoFar: [] });

  s.testRef = testRef; s.competencies = competencies; s.attemptSeed = attemptSeed; s.schedule = schedule;
  s.progress = { threadIndex: 0, qInThread: 1, asked: 1, total: QUESTIONS_PER_EXAM };
  // Special-catalog tests have no student-chosen level, so it's left out of
  // what the student sees, even though it still exists internally for grading.
  const levelSuffix = testRef.tier === 'catalog' ? `, ${testRef.level} level` : '';
  s.transcript = [{
    role: 'assistant',
    content: `Welcome. This is an assessment in ${testRef.title}${levelSuffix}. It has ${QUESTIONS_PER_EXAM} questions. Question 1 of ${QUESTIONS_PER_EXAM}:\n\n${firstQ}`,
    threadLabel: firstSched.label, mode: firstSched.mode
  }];
  s.stage = 'interview';
  res.json({ session: publicSession(s) });
}));

app.post('/api/message', sessionMiddleware, wrap(async (req, res) => {
  const s = req.session;
  if (s.stage !== 'interview') return res.status(400).json({ error: 'No exam in progress.' });
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Write an answer before sending.' });

  const sched = s.schedule, p = s.progress, curThread = sched[p.threadIndex];
  const userTurn = { role: 'user', content: String(content).slice(0, 20000), threadLabel: curThread.label };
  const transcript = [...s.transcript, userTurn];
  const askedSoFar = transcript.filter((t) => t.role === 'assistant').map((t) => t.content);

  let reply, done = false, nextThreadIndex = p.threadIndex, nextQInThread = p.qInThread, replyThread = curThread;

  if (p.asked >= QUESTIONS_PER_EXAM) {
    done = true;
    reply = `That completes all ${QUESTIONS_PER_EXAM} questions. Grading now…`;
  } else if (p.qInThread < curThread.length) {
    nextQInThread = p.qInThread + 1;
    reply = await llm.genFollowUp({ attemptSeed: s.attemptSeed, testRef: s.testRef, sched: curThread, threadOrdinal: p.threadIndex, qInThread: nextQInThread, lastAnswer: content, askedSoFar });
  } else {
    nextThreadIndex = p.threadIndex + 1; nextQInThread = 1;
    replyThread = sched[nextThreadIndex];
    reply = await llm.genOpener({ attemptSeed: s.attemptSeed, testRef: s.testRef, competencies: s.competencies, sched: replyThread, threadOrdinal: nextThreadIndex, askedSoFar });
  }

  const nextAsked = done ? p.asked : p.asked + 1;
  const labelled = done ? reply : `Question ${nextAsked} of ${QUESTIONS_PER_EXAM}:\n\n${reply}`;
  transcript.push({ role: 'assistant', content: labelled, threadLabel: replyThread.label, mode: replyThread.mode });

  s.transcript = transcript;
  s.progress = { threadIndex: nextThreadIndex, qInThread: nextQInThread, asked: nextAsked, total: QUESTIONS_PER_EXAM };

  if (done) {
    const result = llm.score({ transcript: s.transcript, level: s.testRef.level });
    const feedback = llm.feedback({ result, testRef: s.testRef });
    s.result = { outcome: result.outcome, score: result.score, perTopic: result.perTopic };
    s.feedback = feedback;
    s.stage = 'complete';
  }
  res.json({ reply: labelled, done, mode: replyThread.mode, topic: replyThread.label, progress: s.progress, result: s.result, feedback: s.feedback });
}));

// ---------------- release (proctor attestation + submit) ----------------
app.post('/api/release', sessionMiddleware, wrap(async (req, res) => {
  const s = req.session;
  if (s.stage !== 'complete') return res.status(400).json({ error: 'Exam is not finished yet.' });
  const { proctorCode } = req.body || {};
  if (!PROCTOR_CODE || proctorCode !== PROCTOR_CODE) {
    s.proctorAttempts++;
    if (s.proctorAttempts >= 5) { s.locked = true; return res.status(403).json({ error: 'Too many incorrect proctor codes. Session locked — unlock a new session.' }); }
    return res.status(401).json({ error: `Incorrect proctor code. ${5 - s.proctorAttempts} attempts remaining.` });
  }

  const payload = {
    userEmail: s.email, birthdate: s.birthdate,
    // Special-tier level is internal-only — used here to calibrate generation
    // and grading, but never named to the model, shown to the student, or
    // sent onward. The aggregator's testRef for a special-tier credential has
    // no level field at all.
    testRef: s.testRef.tier === 'catalog'
      ? { tier: 'catalog', subject: s.testRef.subject, level: s.testRef.level }
      : { tier: 'special', subject: s.testRef.subject },
    transcript: s.transcript, outcome: s.result.outcome, score: s.result.score, feedback: s.feedback, modelUsed: llm.modelUsed()
  };

  try {
    const r = await fetch(`${AGGREGATOR_ENDPOINT}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INSTITUTION_API_KEY}` },
      body: JSON.stringify(payload)
    });
    if (r.status === 401) return res.status(502).json({ error: 'Institution key rejected by the aggregator. Contact your Vivacada administrator.', retryable: false });
    if (r.status === 429) return res.status(502).json({ error: 'Aggregator rate limit reached. Try again shortly.', retryable: true });
    if (!r.ok) return res.status(502).json({ error: `Aggregator rejected the submission (HTTP ${r.status}). You can retry.`, retryable: true });
    sessions.delete(s.id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the aggregator. Check the network and retry — nothing is lost.', retryable: true });
  }
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vivacada testing app on http://localhost:${PORT}  (LLM: ${llm.modelUsed().provider}/${llm.modelUsed().name})`));
