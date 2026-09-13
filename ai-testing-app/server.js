// dotenv is loaded once by the root server.js dispatcher before this module is required.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { connect, newId } = require('./src/db');
const storage = require('./src/storage');
const payment = require('./src/payment');
const proctor = require('./src/proctor');
const llm = require('../shared/llm');
const interview = require('../shared/interview');

const LEVELS = llm.LEVELS;
const QUESTIONS_PER_EXAM = interview.QUESTIONS_PER_EXAM;
const ALLOW_SPECIAL_CATALOG = (process.env.ALLOW_SPECIAL_CATALOG || 'true').toLowerCase() !== 'false';
const AGGREGATOR_ENDPOINT = process.env.AGGREGATOR_ENDPOINT || 'https://aggregator.vivacada.example/api';
const INSTITUTION_API_KEY = process.env.INSTITUTION_API_KEY || '';
const ROLE = (process.env.ROLE || 'client').toLowerCase(); // 'client' (HTTP + worker) or 'worker' (worker only)
const PROCTOR_JOB_LEASE_MIN = parseInt(process.env.PROCTOR_JOB_LEASE_MIN, 10) || 10;
const PROCTOR_MAX_JOB_ATTEMPTS = parseInt(process.env.PROCTOR_MAX_JOB_ATTEMPTS, 10) || 2;
const WORKER_ID = crypto.randomBytes(4).toString('hex');

const now = () => new Date();
const normalizeSubjectName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

let db;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: 'Something went wrong. Try again.' }); });

async function requireAttempt(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'No session.' });
  const attempt = await db.collection('attempts').findOne({ _id: req.params.id, sessionToken: token });
  if (!attempt) return res.status(401).json({ error: 'Invalid or expired session.' });
  req.attempt = attempt;
  next();
}
function requirePaid(req, res, next) {
  if (req.attempt.payment.status !== 'paid') return res.status(402).json({ error: 'Payment required.' });
  next();
}
function publicAttempt(a) {
  return { _id: a._id, stage: a.stage, email: a.email, testRef: a.testRef, progress: a.progress, transcript: a.transcript, result: a.result, feedback: a.feedback, gestureList: a.gestureList };
}

// ---------------- catalog (proxied from the aggregator, same shape as the kiosk) ----------------
let catalogCache = { at: 0, main: [], special: [] };
async function ensureCatalogFresh() {
  if (catalogCache.main.length && Date.now() - catalogCache.at < 30000) return catalogCache;
  const shape = (list) => (Array.isArray(list) ? list.map((s) => (typeof s === 'string' ? { subject: s, description: null } : { subject: s.subject, description: s.description || null })) : []);
  try {
    const r = await fetch(`${AGGREGATOR_ENDPOINT}/catalog`);
    const data = await r.json();
    catalogCache = { at: Date.now(), main: shape(data.main), special: shape(data.special) };
  } catch (_) { /* keep the last-known cache rather than serving nothing */ }
  return catalogCache;
}

// ---------------- aggregator submission ----------------
async function submitToAggregator(a) {
  const payload = {
    userEmail: a.email, birthdate: a.proctorJob.extractedBirthdate,
    testRef: a.testRef.tier === 'catalog' ? { tier: 'catalog', subject: a.testRef.subject, level: a.testRef.level } : { tier: 'special', subject: a.testRef.subject },
    transcript: a.transcript, outcome: 'pass', score: a.result.score, feedback: a.feedback, modelUsed: llm.modelUsed()
  };
  const r = await fetch(`${AGGREGATOR_ENDPOINT}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INSTITUTION_API_KEY}` }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`aggregator ingest failed: ${r.status}`);
}

function buildApp() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/legal', express.static(path.join(__dirname, 'legal')));

  app.get('/api/config', (req, res) => {
    res.json({ mockMode: payment.MOCK_MODE, paymentProvider: payment.PROVIDER, feeCents: payment.feeCents(), questionsPerExam: QUESTIONS_PER_EXAM, allowSpecialCatalog: ALLOW_SPECIAL_CATALOG });
  });

  app.get('/api/catalog', wrap(async (req, res) => {
    const c = await ensureCatalogFresh();
    res.json({ main: c.main, special: c.special, levels: LEVELS });
  }));

  // ---------------- attempt lifecycle ----------------
  app.post('/api/attempts', express.json(), wrap(async (req, res) => {
    if (!req.body?.agreedToTerms) return res.status(400).json({ error: 'You must agree to the terms to continue.' });
    const sessionToken = crypto.randomBytes(24).toString('base64url');
    const attempt = {
      _id: newId(), sessionToken, stage: 'terms_agreed', email: null,
      testRef: null, competencies: null, attemptSeed: null, schedule: null, progress: null, transcript: [],
      result: null, feedback: null, gestureList: null, mockOverride: null,
      payment: { status: 'pending', provider: payment.PROVIDER, providerRef: null, amountCents: payment.feeCents(), paidAt: null },
      clips: {}, // { [step]: { webcamKey, screenKey, capturedAt } } — only the current, kept clip per step
      proctorJob: { status: 'not_queued', jobAttempts: 0, claimedBy: null, claimedAt: null, leaseUntil: null, extractedBirthdate: null, submittedToAggregatorAt: null },
      createdAt: now(), updatedAt: now()
    };
    await db.collection('attempts').insertOne(attempt);
    res.json({ attemptId: attempt._id, sessionToken });
  }));

  app.post('/api/attempts/:id/pay', express.json(), requireAttempt, wrap(async (req, res) => {
    const { returnBaseUrl } = req.body || {};
    const result = await payment.startPayment({ attemptId: req.attempt._id, returnBaseUrl: returnBaseUrl || `${req.protocol}://${req.get('host')}/` });
    await db.collection('attempts').updateOne({ _id: req.attempt._id }, { $set: { 'payment.providerRef': result.providerRef || null, updatedAt: now() } });
    res.json(result);
  }));

  app.post('/api/attempts/:id/pay/confirm', requireAttempt, wrap(async (req, res) => {
    if (req.attempt.payment.status === 'paid') return res.json({ paid: true });
    const { paid } = await payment.confirmPayment({ providerRef: req.attempt.payment.providerRef });
    if (paid) await db.collection('attempts').updateOne({ _id: req.attempt._id }, { $set: { 'payment.status': 'paid', 'payment.paidAt': now(), stage: 'select', updatedAt: now() } });
    res.json({ paid });
  }));

  app.get('/api/attempts/:id', requireAttempt, wrap(async (req, res) => res.json({ attempt: publicAttempt(req.attempt) })));

  app.post('/api/attempts/:id/select', express.json(), requireAttempt, requirePaid, wrap(async (req, res) => {
    const a = req.attempt;
    if (a.stage !== 'select') return res.status(400).json({ error: 'Not ready to select a test.' });
    const { email, mode, subject, level, mockOverride } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });

    const cat = await ensureCatalogFresh();
    let testRef, competencies = null;
    if (mode === 'catalog') {
      if (!subject || !LEVELS.includes(level)) return res.status(400).json({ error: 'Pick a subject and level.' });
      const known = cat.main.find((s) => s.subject === subject);
      if (!known) return res.status(400).json({ error: 'Pick a subject from the list.' });
      testRef = { tier: 'catalog', title: known.subject, subject: known.subject, level, description: known.description || undefined };
    } else if (mode === 'special') {
      if (!ALLOW_SPECIAL_CATALOG) return res.status(403).json({ error: 'The special catalog is disabled.' });
      const known = cat.special.find((s) => normalizeSubjectName(s.subject) === normalizeSubjectName(subject));
      if (!known) return res.status(400).json({ error: 'Pick a valid special-catalog test from the suggestions.' });
      const spec = await llm.deriveSpecFromDescription(known.description);
      testRef = { tier: 'special', title: known.subject, subject: known.subject, level: spec.derivedLevel, description: known.description };
      competencies = spec.competencies;
    } else {
      return res.status(400).json({ error: 'Pick catalog or special-catalog mode.' });
    }

    const attemptSeed = a._id + ':' + crypto.randomBytes(6).toString('hex');
    const schedule = interview.buildSchedule(attemptSeed, testRef, competencies);
    const firstSched = schedule[0];
    const firstQ = await llm.genOpener({ attemptSeed, testRef, competencies, sched: firstSched, threadOrdinal: 0, askedSoFar: [] });
    const levelSuffix = testRef.tier === 'catalog' ? `, ${testRef.level} level` : '';
    const transcript = [{ role: 'assistant', content: `Welcome. This is an assessment in ${testRef.title}${levelSuffix}. It has ${QUESTIONS_PER_EXAM} questions. Question 1 of ${QUESTIONS_PER_EXAM}:\n\n${firstQ}`, threadLabel: firstSched.label, mode: firstSched.mode }];
    const progress = { threadIndex: 0, qInThread: 1, asked: 1, total: QUESTIONS_PER_EXAM };

    await db.collection('attempts').updateOne({ _id: a._id }, { $set: {
      email, testRef, competencies, attemptSeed, schedule, progress, transcript, stage: 'recording',
      mockOverride: payment.MOCK_MODE ? (mockOverride || null) : null, // test-only hook, inert unless MOCK_MODE
      updatedAt: now()
    } });
    res.json({ attempt: publicAttempt({ ...a, email, testRef, progress, transcript, stage: 'recording' }) });
  }));

  // ---------------- gestures ----------------
  const GESTURE_BANK = ['Hold up three fingers on your left hand', 'Touch your right ear', 'Look over your left shoulder', 'Hold up one finger on each hand', 'Touch your chin', 'Give a thumbs up with your right hand', 'Wave with your left hand'];
  app.post('/api/attempts/:id/gestures', requireAttempt, requirePaid, wrap(async (req, res) => {
    let list = req.attempt.gestureList;
    if (!list) {
      list = [...GESTURE_BANK].sort(() => 0.5 - Math.random()).slice(0, 3);
      await db.collection('attempts').updateOne({ _id: req.attempt._id }, { $set: { gestureList: list, updatedAt: now() } });
    }
    res.json({ gestureList: list });
  }));

  // ---------------- segmented clip upload ----------------
  // One call per (step, track). A retry re-uploads the same step: the prior
  // clip for that step is deleted from storage immediately, not held until
  // the end — it's superseded the instant the new one lands.
  app.post('/api/attempts/:id/clip', express.raw({ type: () => true, limit: '200mb' }), requireAttempt, requirePaid, wrap(async (req, res) => {
    const step = req.query.step, track = req.query.track;
    if (!['face', 'id', 'gestures', 'sweep', 'exam'].includes(step)) return res.status(400).json({ error: 'Invalid step.' });
    if (!['webcam', 'screen'].includes(track)) return res.status(400).json({ error: 'Invalid track.' });
    if (!req.body?.length) return res.status(400).json({ error: 'Empty clip.' });

    const a = req.attempt;
    const keyField = track === 'webcam' ? 'webcamKey' : 'screenKey';
    const existing = a.clips[step];
    if (existing?.[keyField]) await storage.deleteClip(existing[keyField]); // supersede immediately

    const key = `attempts/${a._id}/${step}-${track}-${Date.now()}.webm`;
    await storage.uploadClip(key, req.body, 'video/webm');
    const updated = { ...(existing || {}), [keyField]: key, capturedAt: now() };
    await db.collection('attempts').updateOne({ _id: a._id }, { $set: { [`clips.${step}`]: updated, updatedAt: now() } });
    res.json({ ok: true });
  }));

  // ---------------- exam (same shape as the kiosk, via the shared engine) ----------------
  app.post('/api/attempts/:id/message', express.json(), requireAttempt, requirePaid, wrap(async (req, res) => {
    const a = req.attempt;
    if (a.stage !== 'recording') return res.status(400).json({ error: 'No exam in progress.' });
    const { content } = req.body || {};
    if (!content || !content.trim()) return res.status(400).json({ error: 'Write an answer before sending.' });

    const sched = a.schedule, p = a.progress, curThread = sched[p.threadIndex];
    const userTurn = { role: 'user', content: String(content).slice(0, 20000), threadLabel: curThread.label };
    const transcript = [...a.transcript, userTurn];
    const askedSoFar = transcript.filter((t) => t.role === 'assistant').map((t) => t.content);

    let reply, done = false, nextThreadIndex = p.threadIndex, nextQInThread = p.qInThread, replyThread = curThread;
    if (p.asked >= QUESTIONS_PER_EXAM) {
      done = true;
      reply = `That completes all ${QUESTIONS_PER_EXAM} questions. Grading now…`;
    } else if (p.qInThread < curThread.length) {
      nextQInThread = p.qInThread + 1;
      reply = await llm.genFollowUp({ attemptSeed: a.attemptSeed, testRef: a.testRef, sched: curThread, threadOrdinal: p.threadIndex, qInThread: nextQInThread, lastAnswer: content, askedSoFar });
    } else {
      nextThreadIndex = p.threadIndex + 1; nextQInThread = 1;
      replyThread = sched[nextThreadIndex];
      reply = await llm.genOpener({ attemptSeed: a.attemptSeed, testRef: a.testRef, competencies: a.competencies, sched: replyThread, threadOrdinal: nextThreadIndex, askedSoFar });
    }
    const nextAsked = done ? p.asked : p.asked + 1;
    const labelled = done ? reply : `Question ${nextAsked} of ${QUESTIONS_PER_EXAM}:\n\n${reply}`;
    transcript.push({ role: 'assistant', content: labelled, threadLabel: replyThread.label, mode: replyThread.mode });
    const progress = { threadIndex: nextThreadIndex, qInThread: nextQInThread, asked: nextAsked, total: QUESTIONS_PER_EXAM };

    let result = null, feedback = null;
    if (done) {
      result = llm.score({ transcript, level: a.testRef.level });
      feedback = llm.feedback({ result, testRef: a.testRef });
    }
    await db.collection('attempts').updateOne({ _id: a._id }, { $set: { transcript, progress, result, feedback, updatedAt: now() } });
    res.json({ reply: labelled, done, mode: replyThread.mode, topic: replyThread.label, progress, result, feedback });
  }));

  // ---------------- submit: grade already computed on the last message; this
  // gates what happens next — fail discards everything immediately, pass
  // queues the proctor job. Nothing reaches the aggregator until the proctor
  // approves. ----------------
  app.post('/api/attempts/:id/submit', requireAttempt, requirePaid, wrap(async (req, res) => {
    const a = req.attempt;
    if (!a.result) return res.status(400).json({ error: 'Exam is not finished yet.' });
    if (a.result.outcome === 'fail') {
      await storage.deletePrefix(`attempts/${a._id}/`);
      await db.collection('attempts').updateOne({ _id: a._id }, { $set: { stage: 'failed_content', clips: {}, updatedAt: now() } });
      return res.json({ outcome: 'fail', result: a.result, feedback: a.feedback });
    }
    await db.collection('attempts').updateOne({ _id: a._id }, { $set: {
      stage: 'awaiting_proctor', 'proctorJob.status': 'pending', updatedAt: now()
    } });
    res.json({ outcome: 'pass', result: a.result, feedback: a.feedback, statusToken: a.sessionToken });
  }));

  app.get('/api/attempts/:id/proctor-status', requireAttempt, wrap(async (req, res) => {
    const s = req.attempt.proctorJob.status;
    const display = { not_queued: 'not_submitted', pending: 'checking', processing: 'checking', done_approved: 'approved', done_rejected: 'rejected', done_failed: 'rejected' }[s] || 'checking';
    res.json({ status: display });
  }));

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  return app;
}

// ---------------- worker: claims and processes proctor jobs ----------------
async function reclaimStaleJobs() {
  await db.collection('attempts').updateMany(
    { 'proctorJob.status': 'processing', 'proctorJob.leaseUntil': { $lt: now() } },
    { $set: { 'proctorJob.status': 'pending' }, $inc: { 'proctorJob.jobAttempts': 1 } }
  );
}

async function claimOneJob() {
  const leaseUntil = new Date(Date.now() + PROCTOR_JOB_LEASE_MIN * 60000);
  const result = await db.collection('attempts').findOneAndUpdate(
    { 'proctorJob.status': 'pending' },
    { $set: { 'proctorJob.status': 'processing', 'proctorJob.claimedBy': WORKER_ID, 'proctorJob.claimedAt': now(), 'proctorJob.leaseUntil': leaseUntil } },
    { returnDocument: 'after', sort: { updatedAt: 1 } }
  );
  return result?.value || result || null;
}

async function processJob(a) {
  const verdict = await proctor.analyzeAttempt({ clipsByStep: a.clips, gestureList: a.gestureList, mockOverride: a.mockOverride });
  if (verdict.outcome === 'technical_failure') {
    const jobAttempts = (a.proctorJob.jobAttempts || 0) + 1;
    if (jobAttempts >= PROCTOR_MAX_JOB_ATTEMPTS) {
      await storage.deletePrefix(`attempts/${a._id}/`);
      await db.collection('attempts').updateOne({ _id: a._id }, { $set: { stage: 'failed_proctor', clips: {}, 'proctorJob.status': 'done_failed', 'proctorJob.jobAttempts': jobAttempts, updatedAt: now() } });
    } else {
      await db.collection('attempts').updateOne({ _id: a._id }, { $set: { 'proctorJob.status': 'pending', 'proctorJob.jobAttempts': jobAttempts, updatedAt: now() } });
    }
    return;
  }
  if (verdict.outcome === 'rejected') {
    await storage.deletePrefix(`attempts/${a._id}/`);
    await db.collection('attempts').updateOne({ _id: a._id }, { $set: { stage: 'failed_proctor', clips: {}, 'proctorJob.status': 'done_rejected', updatedAt: now() } });
    return;
  }
  // approved
  await db.collection('attempts').updateOne({ _id: a._id }, { $set: { 'proctorJob.extractedBirthdate': verdict.birthdate } });
  try {
    await submitToAggregator({ ...a, proctorJob: { ...a.proctorJob, extractedBirthdate: verdict.birthdate } });
    await db.collection('attempts').updateOne({ _id: a._id }, { $set: { 'proctorJob.submittedToAggregatorAt': now(), 'proctorJob.status': 'done_approved', stage: 'complete', updatedAt: now() } });
  } finally {
    await storage.deletePrefix(`attempts/${a._id}/`); // unconditional — footage never survives analysis, pass or fail
    await db.collection('attempts').updateOne({ _id: a._id }, { $set: { clips: {} } });
  }
}

function startWorkerLoop() {
  setInterval(async () => {
    try {
      await reclaimStaleJobs();
      const job = await claimOneJob();
      if (job) await processJob(job);
    } catch (e) { console.error('[worker]', e); }
  }, 5000).unref();
  console.log(`[ai-testing-app] worker loop running (id=${WORKER_ID}, lease=${PROCTOR_JOB_LEASE_MIN}m, maxJobAttempts=${PROCTOR_MAX_JOB_ATTEMPTS})`);
}

(async () => {
  db = await connect();
  startWorkerLoop();
  if (ROLE !== 'worker') {
    const PORT = process.env.PORT || 3100;
    buildApp().listen(PORT, () => console.log(`[ai-testing-app] client listening on http://localhost:${PORT} (role=${ROLE}, mock=${payment.MOCK_MODE})`));
  } else {
    console.log('[ai-testing-app] running as worker-only — no HTTP surface.');
  }
})();
