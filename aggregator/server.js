require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { connect, newId } = require('../shared/db');
const { validateCatalogInput, assertNoDuplicateSubject } = require('../shared/catalogValidation');
const { hashPassword, verifyPassword } = require('../shared/auth');
const { seed } = require('./src/seed');

const LEVELS = ['beginner', 'intermediate', 'junior', 'senior', 'expert'];
const now = () => new Date().toISOString();
const slug = () => crypto.randomBytes(6).toString('base64url');
const RATE_LIMIT_PER_DAY = parseInt(process.env.RATE_LIMIT_PER_DAY, 10) || 500;
// A single optional label per institution, e.g. "AI-Proctor" — distinguishes
// how an institution actually proctors exams, shown everywhere its name
// appears (directory, credentials, badge). Closed vocabulary from env, not
// free text, so it can't fragment into near-duplicate variants.
const INSTITUTION_LABELS = (process.env.INSTITUTION_LABELS || 'AI-Proctor').split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

let db;

// ---------------- auth ----------------
async function requireAuth(req, res, next) {
  const token = req.cookies.sid;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  const session = await db.collection('sessions').findOne({ token });
  if (!session) return res.status(401).json({ error: 'Sign in to continue.' });
  const user = await db.collection('users').findOne({ _id: session.userId });
  if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}
// Combined admin gate: a valid admin session cookie, OR a bearer token matching
// ADMIN_API_KEY — the latter needs no session/cookies, for headless/scripted use.
async function requireAdminAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && key === adminKey) {
    req.user = { _id: 'admin-api-key', email: '(admin API key)', role: 'admin' };
    return next();
  }
  return requireAuth(req, res, (err) => { if (err) return; requireAdmin(req, res, next); });
}
async function authenticateInstitution(req, res) {
  const auth = req.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!key) { res.status(401).json({ error: 'Missing institution API key.' }); return null; }
  const inst = await db.collection('institutions').findOne({ apiKey: key });
  if (!inst) { res.status(401).json({ error: 'Unknown institution API key.' }); return null; }
  if (inst.status === 'revoked') { res.status(401).json({ error: 'This institution API key has been revoked.' }); return null; }
  if (inst.status === 'pending') { res.status(403).json({ error: 'This institution is not yet approved.' }); return null; }
  return inst;
}
async function requireInstitution(req, res, next) {
  const inst = await authenticateInstitution(req, res);
  if (!inst) return;
  const today = now().slice(0, 10);
  const bucket = inst.rateBucket === today ? inst.rateCount : 0;
  if (bucket >= RATE_LIMIT_PER_DAY) return res.status(429).json({ error: 'Daily submission limit reached for this institution.' });
  await db.collection('institutions').updateOne({ _id: inst._id }, { $set: { rateBucket: today, rateCount: bucket + 1 } });
  req.institution = inst;
  next();
}
// Auth only, no submission-quota consumption — for read-only institution calls
// (e.g. the name lookup at the testing app's email step) that shouldn't be
// able to starve out the day's actual exam-submission budget.
async function requireInstitutionAuthOnly(req, res, next) {
  const inst = await authenticateInstitution(req, res);
  if (!inst) return;
  req.institution = inst;
  next();
}
function publicUser(u) { return { email: u.email, fullName: u.fullName || null }; }
// birthdate is proctor-witnessed, per-credential metadata recorded solely to
// gate employer matching until the holder turns 18 — it is never returned in
// any API response, including the credential owner's own dashboard.
function stripInternal(c) { const { birthdate, ...rest } = c; return rest; }

async function createCredential(sub, userId) {
  const cred = {
    _id: newId(), userId, testRef: sub.testRef, tier: sub.testRef.tier, score: sub.score,
    visibility: 'hidden', showTranscript: false, submissionId: sub._id, publicSlug: slug(),
    institutionName: sub.institutionName, institutionLabel: sub.institutionLabel || null, modelUsed: sub.modelUsed, issuedAt: now(),
    birthdate: sub.birthdate || null // proctor-witnessed at test time; never displayed, see stripInternal()
  };
  await db.collection('credentials').insertOne(cred);
  return cred;
}

// Shared by signup and ingest: any submission whose userEmail matches an
// account's email is attached to that account, no separate verification step
// (spec A6 — an account with a matching email is the only proof required).
async function attachPendingSubmissions(email, userId) {
  const pending = await db.collection('submissions').find({ userEmail: email, claimedUserId: null }).toArray();
  let created = 0;
  for (const sub of pending) {
    await db.collection('submissions').updateOne({ _id: sub._id }, { $set: { claimedUserId: userId } });
    if (sub.outcome === 'pass') { await createCredential(sub, userId); created++; }
  }
  return { claimed: pending.length, created };
}

// Institution-gated lookup, not public: given an email, returns the account's
// full name if one exists, so the testing app can greet a returning patron by
// name. Gated behind an institution key (not the open internet) since a blind
// email→name lookup is itself a privacy exposure even without a password.
app.get('/api/accounts/lookup', requireInstitutionAuthOnly, wrap(async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'email query param required.' });
  const user = await db.collection('users').findOne({ email });
  res.json({ fullName: user?.fullName || null });
}));

// ---------------- accounts ----------------
// No email verification: an existing or newly-created account with a matching
// email claims any archived submissions for that email automatically.
app.post('/api/accounts', wrap(async (req, res) => {
  const { email, password, fullName } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const cleanName = (fullName || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'Full name is required — it appears on your credentials alongside your email.' });
  if (cleanName.length > 200) return res.status(400).json({ error: 'Full name is too long.' });
  const normalizedEmail = email.toLowerCase();
  const existing = await db.collection('users').findOne({ email: normalizedEmail });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  const user = { _id: newId(), email: normalizedEmail, fullName: cleanName, passwordHash: hashPassword(password), role: 'student', dataSharing: false, createdAt: now() };
  await db.collection('users').insertOne(user);
  const token = crypto.randomBytes(24).toString('base64url');
  await db.collection('sessions').insertOne({ _id: newId(), token, userId: user._id, createdAt: now() });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  const attached = await attachPendingSubmissions(normalizedEmail, user._id);
  res.json({ user: { email: user.email, fullName: user.fullName, dataSharing: user.dataSharing, role: user.role }, claimed: attached.claimed, credentialsCreated: attached.created });
}));

app.post('/api/accounts/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.collection('users').findOne({ email: (email || '').toLowerCase() });
  if (!user) return res.status(401).json({ error: 'Wrong email or password.' });
  if (!verifyPassword(password || '', user.passwordHash)) return res.status(401).json({ error: 'Wrong email or password.' });
  const token = crypto.randomBytes(24).toString('base64url');
  await db.collection('sessions').insertOne({ _id: newId(), token, userId: user._id, createdAt: now() });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ user: { email: user.email, fullName: user.fullName, dataSharing: user.dataSharing, role: user.role } });
}));

app.post('/api/accounts/logout', requireAuth, wrap(async (req, res) => {
  await db.collection('sessions').deleteOne({ token: req.cookies.sid });
  res.clearCookie('sid'); res.json({ ok: true });
}));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const credentials = await db.collection('credentials').find({ userId: req.user._id }).sort({ issuedAt: -1 }).toArray();
  res.json({ user: { email: req.user.email, fullName: req.user.fullName, dataSharing: req.user.dataSharing, role: req.user.role }, credentials: credentials.map(stripInternal) });
}));

// Name and email are editable from profile settings — both shown on public
// credentials. Every actual change to either is recorded in profileChanges
// (userId, field, old/new value, timestamp) as an audit trail, regardless of
// whether the change came through this route. Changing email re-checks for
// archived, unclaimed submissions under the new address (same no-verification
// model as signup: a matching email is what attaches a result, whether that
// match happens at signup or later via a profile edit).
app.patch('/api/me', requireAuth, wrap(async (req, res) => {
  const { dataSharing, fullName, email } = req.body || {};
  const set = {};
  const auditEntries = [];
  if (dataSharing !== undefined) {
    if (typeof dataSharing !== 'boolean') return res.status(400).json({ error: 'dataSharing must be true or false.' });
    set.dataSharing = dataSharing;
  }
  if (fullName !== undefined) {
    const cleanName = String(fullName).trim();
    if (!cleanName) return res.status(400).json({ error: 'Full name cannot be empty.' });
    if (cleanName.length > 200) return res.status(400).json({ error: 'Full name is too long.' });
    if (cleanName !== req.user.fullName) {
      set.fullName = cleanName;
      auditEntries.push({ field: 'fullName', oldValue: req.user.fullName || null, newValue: cleanName });
    }
  }
  let newEmail = null;
  if (email !== undefined) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    newEmail = email.toLowerCase();
    if (newEmail !== req.user.email) {
      const existing = await db.collection('users').findOne({ email: newEmail });
      if (existing) return res.status(409).json({ error: 'Another account already uses this email.' });
      set.email = newEmail;
      auditEntries.push({ field: 'email', oldValue: req.user.email, newValue: newEmail });
    }
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  await db.collection('users').updateOne({ _id: req.user._id }, { $set: set });
  for (const entry of auditEntries) {
    await db.collection('profileChanges').insertOne({ _id: newId(), userId: req.user._id, ...entry, changedAt: now() });
  }
  let attached = { claimed: 0, created: 0 };
  if (set.email) attached = await attachPendingSubmissions(set.email, req.user._id);
  res.json({ ok: true, ...set, claimed: attached.claimed, credentialsCreated: attached.created });
}));

// ---------------- catalog ----------------
// Two catalogs. "Main" is the ordinary browsable catalog — subject + level
// picked by the student, level is the fixed five-tier constant (see LEVELS).
// "Special" is not browsed or shown in a dropdown — a student finds a special
// entry only by typing its exact name into an autocomplete. Special entries
// have no student-facing level: the description alone drives generation
// (including the level, derived the same way free-text mode used to work before
// it was replaced by the autocomplete-selected special catalog), so
// description is required for a special entry, optional for a main one.
app.get('/api/catalog', wrap(async (req, res) => {
  const entries = await db.collection('catalogEntries').find({}).sort({ subject: 1 }).toArray();
  const shape = (s) => ({ _id: s._id, subject: s.subject, description: s.description || null });
  res.json({
    main: entries.filter((s) => s.catalogType !== 'special').map(shape),
    special: entries.filter((s) => s.catalogType === 'special').map(shape),
    levels: LEVELS
  });
}));

app.post('/api/catalog', requireAdminAuth, wrap(async (req, res) => {
  let clean;
  try { clean = validateCatalogInput(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  try { await assertNoDuplicateSubject(db, clean.subject); } catch (e) { return res.status(409).json({ error: e.message }); }
  const entry = { _id: newId(), ...clean, createdAt: now() };
  await db.collection('catalogEntries').insertOne(entry);
  res.json({ entry });
}));

app.patch('/api/catalog/:id', requireAdminAuth, wrap(async (req, res) => {
  const { subject, description, catalogType } = req.body || {};
  const set = {};
  if (subject !== undefined) { if (!subject.trim()) return res.status(400).json({ error: 'Subject name cannot be empty.' }); set.subject = subject.trim(); }
  if (description !== undefined) set.description = (description || '').trim();
  if (catalogType !== undefined) { if (!['main', 'special'].includes(catalogType)) return res.status(400).json({ error: 'catalogType must be main or special.' }); set.catalogType = catalogType; }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  const existing = await db.collection('catalogEntries').findOne({ _id: req.params.id });
  if (!existing) return res.status(404).json({ error: 'Subject not found.' });
  const willBeSpecial = (set.catalogType || existing.catalogType) === 'special';
  const willHaveDesc = (set.description !== undefined ? set.description : existing.description || '').trim();
  if (willBeSpecial && !willHaveDesc) return res.status(400).json({ error: 'A special-catalog subject needs a description.' });
  const r = await db.collection('catalogEntries').updateOne({ _id: req.params.id }, { $set: set });
  if (!r.matchedCount) return res.status(404).json({ error: 'Subject not found.' });
  res.json({ ok: true, ...set });
}));

app.delete('/api/catalog/:id', requireAdminAuth, wrap(async (req, res) => {
  const r = await db.collection('catalogEntries').deleteOne({ _id: req.params.id });
  if (!r.deletedCount) return res.status(404).json({ error: 'Subject not found.' });
  res.json({ ok: true });
}));

// ---------------- institutions ----------------
// Public directory: where students can find a participating institution.
// Approved only — no api keys, no pending/revoked entries, no internal fields.
app.get('/api/institutions/directory', wrap(async (req, res) => {
  const institutions = await db.collection('institutions').find({ status: 'approved' }).sort({ name: 1 }).toArray();
  res.json({ institutions: institutions.map((i) => ({ name: i.name, contact: i.contact || null, label: i.label || null })) });
}));

app.get('/api/institution-labels', requireAdminAuth, wrap(async (req, res) => {
  res.json({ labels: INSTITUTION_LABELS });
}));

app.get('/api/institutions', requireAdminAuth, wrap(async (req, res) => {
  const institutions = await db.collection('institutions').find({}).sort({ createdAt: -1 }).toArray();
  res.json({ institutions });
}));

app.post('/api/institutions', requireAdminAuth, wrap(async (req, res) => {
  const { name, contact, label } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Institution name required.' });
  if (label && !INSTITUTION_LABELS.includes(label)) return res.status(400).json({ error: 'Invalid label.' });
  const apiKey = 'inst_' + crypto.randomBytes(18).toString('base64url');
  const inst = { _id: newId(), name, contact: contact || '', label: label || null, apiKey, status: 'pending', rateBucket: null, rateCount: 0, createdAt: now() };
  await db.collection('institutions').insertOne(inst);
  res.json({ institution: inst });
}));

app.patch('/api/institutions/:id', requireAdminAuth, wrap(async (req, res) => {
  const { status, label } = req.body || {};
  const set = {};
  if (status !== undefined) {
    if (!['pending', 'approved', 'revoked'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    set.status = status;
  }
  if (label !== undefined) {
    if (label && !INSTITUTION_LABELS.includes(label)) return res.status(400).json({ error: 'Invalid label.' });
    set.label = label || null; // empty string / null clears the label
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  await db.collection('institutions').updateOne({ _id: req.params.id }, { $set: set });
  res.json({ ok: true, ...set });
}));

// ---------------- ingest ----------------
app.post('/api/ingest', requireInstitution, wrap(async (req, res) => {
  const { userEmail, testRef, transcript, outcome, score, feedback, modelUsed, birthdate } = req.body || {};
  if (!userEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userEmail)) return res.status(400).json({ error: 'Valid userEmail required.' });
  if (!testRef || !['catalog', 'special'].includes(testRef.tier)) return res.status(400).json({ error: 'testRef with a valid tier is required.' });
  if (!Array.isArray(transcript) || !transcript.length) return res.status(400).json({ error: 'transcript is required.' });
  if (!['pass', 'fail'].includes(outcome)) return res.status(400).json({ error: 'outcome must be pass or fail.' });
  // Proctor-witnessed at test time (spec: age verification moved off account
  // signup entirely — the testing app collects it alongside email, the
  // proctor is trusted to confirm it the same way they attest to the rest of
  // the exam). Required so every credential can be individually age-gated.
  const bd = new Date(birthdate);
  if (!birthdate || isNaN(bd.getTime()) || bd > new Date()) return res.status(400).json({ error: 'A valid, non-future birthdate is required.' });

  const email = userEmail.toLowerCase();
  const sub = {
    _id: newId(), userEmail: email, testRef, transcript, outcome, score: Number(score) || 0, feedback: feedback || {},
    modelUsed: modelUsed || { provider: 'unknown', name: 'unknown' }, institutionId: req.institution._id, institutionName: req.institution.name, institutionLabel: req.institution.label || null,
    birthdate, claimedUserId: null, createdAt: now()
  };
  await db.collection('submissions').insertOne(sub);

  // Existing account with a matching email → attach immediately. No account yet
  // → archived as-is; it attaches the moment an account with this email exists.
  const existingUser = await db.collection('users').findOne({ email });
  if (existingUser) {
    await db.collection('submissions').updateOne({ _id: sub._id }, { $set: { claimedUserId: existingUser._id } });
    if (outcome === 'pass') await createCredential(sub, existingUser._id);
  }
  res.status(201).json({ ok: true, submissionId: sub._id });
}));

// ---------------- credentials & badges ----------------
app.patch('/api/credentials/:id', requireAuth, wrap(async (req, res) => {
  const { visibility, showTranscript } = req.body || {};
  const set = {};
  if (visibility !== undefined) { if (!['public', 'hidden'].includes(visibility)) return res.status(400).json({ error: 'visibility is public or hidden.' }); set.visibility = visibility; }
  if (showTranscript !== undefined) set.showTranscript = !!showTranscript;
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  const r = await db.collection('credentials').updateOne({ _id: req.params.id, userId: req.user._id }, { $set: set });
  if (!r.matchedCount) return res.status(404).json({ error: 'Credential not found.' });
  res.json({ ok: true, ...set });
}));

app.get('/api/credentials/:slug', wrap(async (req, res) => {
  const c = await db.collection('credentials').findOne({ publicSlug: req.params.slug });
  if (!c || c.visibility !== 'public') return res.status(404).json({ error: 'Credential not found.' });
  const holder = await db.collection('users').findOne({ _id: c.userId });
  const sub = c.showTranscript ? await db.collection('submissions').findOne({ _id: c.submissionId }) : null;
  res.json({ credential: stripInternal(c), holder: holder ? publicUser(holder) : null, transcript: sub?.transcript, feedback: sub?.feedback });
}));

app.get('/api/badge/:slug.svg', wrap(async (req, res) => {
  const c = await db.collection('credentials').findOne({ publicSlug: req.params.slug });
  res.type('image/svg+xml');
  if (!c || c.visibility !== 'public') return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  const holder = await db.collection('users').findOne({ _id: c.userId });
  const uncal = c.tier === 'special';
  const title = c.testRef.subject;
  const holderName = holder?.fullName || 'Unnamed holder';
  // Name shown for attribution (same reason a diploma shows a name); email is
  // deliberately left off the badge itself — badges are commonly embedded on
  // external pages and scraped, unlike the credential page a viewer has to
  // click through to, so raw email stays there rather than on this artifact.
  // Special-tier tests have no level at all — implicit, internal to the
  // testing app's own grading, and never transmitted here. Show subject and
  // institution only, no level line.
  const instText = c.institutionLabel ? `${c.institutionName} (${c.institutionLabel})` : c.institutionName;
  const infoLine = uncal ? esc(instText) : `${esc(cap(c.testRef.level))} · ${esc(instText)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="106" viewBox="0 0 260 106">
    <rect x="1" y="1" width="258" height="104" rx="6" fill="#F6F3EC" stroke="${uncal ? '#8a8272' : '#2F5233'}" stroke-width="2" stroke-dasharray="${uncal ? '5,4' : 'none'}"/>
    <text x="14" y="26" font-family="Georgia,serif" font-size="14" font-weight="700" fill="#1B2430">${esc(title)}</text>
    <text x="14" y="44" font-family="Georgia,serif" font-size="12" fill="#1B2430">${esc(holderName)}</text>
    <text x="14" y="62" font-family="monospace" font-size="11" fill="#2F5233">${infoLine}</text>
    <text x="14" y="84" font-family="monospace" font-size="9" letter-spacing="1" fill="#8a8272">${uncal ? 'SPECIAL CATALOG' : 'VIVACADA VERIFIED'}</text>
  </svg>`;
  res.send(svg);
}));
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ---------------- SPA fallback (hash-routed client) ----------------
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 4000;
(async () => {
  db = await connect();
  await seed(db);
  app.listen(PORT, () => console.log(`Vivacada aggregator on http://localhost:${PORT}`));
})();
