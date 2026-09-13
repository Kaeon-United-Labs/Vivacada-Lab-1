require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { connect, newId } = require('../shared/db');
const { hashPassword, verifyPassword, newApiKey } = require('../shared/auth');
const { validateCatalogInput, assertNoDuplicateSubject } = require('../shared/catalogValidation');
const { isEmployerEligible, age } = require('../shared/eligibility');
const payment = require('./src/payment');
const pricing = require('./src/pricing');
const aiQuery = require('./src/aiQuery');

const now = () => new Date().toISOString();
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/legal', express.static(path.join(__dirname, 'legal')));

let db;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: 'Something went wrong. Try again.' }); });

// ---------------- auth ----------------
// Accepts either a session cookie (UI) or a bearer API key (headless) -- same
// account either way, so every feature works identically through both.
async function requireAuth(req, res, next) {
  let account = null;
  const bearer = req.get('authorization')?.replace(/^Bearer /, '');
  if (bearer) account = await db.collection('employerAccounts').findOne({ apiKey: bearer });
  else {
    const token = req.cookies.sid;
    if (token) { const session = await db.collection('sessions').findOne({ token }); if (session) account = await db.collection('employerAccounts').findOne({ _id: session.accountId }); }
  }
  if (!account) return res.status(401).json({ error: 'Sign in or provide a valid API key.' });
  if (account.suspended) return res.status(403).json({ error: 'This account has been suspended.' });
  req.account = account;
  next();
}
function requireAdmin(req, res, next) { if (req.account.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' }); next(); }
function requireSubscribed(req, res, next) {
  if (req.account.subscription?.status !== 'active') return res.status(402).json({ error: 'An active subscription is required to browse profiles.' });
  next();
}
function publicAccount(a) {
  return { email: a.email, fullName: a.fullName, role: a.role, apiKey: a.apiKey, subscription: a.subscription, balanceCents: a.balanceCents };
}

// ---------------- config ----------------
app.get('/api/config', (req, res) => {
  res.json({
    mockMode: payment.MOCK_MODE, paymentProvider: payment.PROVIDER,
    subscriptionPriceCents: payment.SUBSCRIPTION_PRICE_CENTS, catalogSubmissionFeeCents: payment.CATALOG_SUBMISSION_FEE_CENTS,
    tokenPricingMode: pricing.MODE, tokenFlatCostCents: pricing.MODE === 'flat' ? pricing.preCallCeilingCents('') : null
  });
});

// ---------------- accounts ----------------
// Open self-registration, deliberately -- the alternative (manually vetting
// every employer) is exactly the overhead this app exists to avoid. The
// counterweight is the ToS (legal/terms.txt) plus an admin suspend lever.
app.post('/api/accounts', wrap(async (req, res) => {
  const { email, password, fullName } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const cleanName = (fullName || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'Name is required.' });
  const normalizedEmail = email.toLowerCase();
  if (await db.collection('employerAccounts').findOne({ email: normalizedEmail })) return res.status(409).json({ error: 'An account with this email already exists.' });
  const account = {
    _id: newId(), email: normalizedEmail, fullName: cleanName, passwordHash: hashPassword(password),
    role: 'employer', suspended: false, apiKey: newApiKey('emp'),
    subscription: { status: 'none', provider: null, providerRef: null, currentPeriodEnd: null },
    balanceCents: 0, createdAt: now()
  };
  await db.collection('employerAccounts').insertOne(account);
  const token = crypto.randomBytes(24).toString('base64url');
  await db.collection('sessions').insertOne({ _id: newId(), token, accountId: account._id, createdAt: now() });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ account: publicAccount(account) });
}));

app.post('/api/accounts/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const account = await db.collection('employerAccounts').findOne({ email: (email || '').toLowerCase() });
  if (!account || !verifyPassword(password || '', account.passwordHash)) return res.status(401).json({ error: 'Wrong email or password.' });
  if (account.suspended) return res.status(403).json({ error: 'This account has been suspended.' });
  const token = crypto.randomBytes(24).toString('base64url');
  await db.collection('sessions').insertOne({ _id: newId(), token, accountId: account._id, createdAt: now() });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 864e5 });
  res.json({ account: publicAccount(account) });
}));

app.post('/api/accounts/logout', requireAuth, wrap(async (req, res) => {
  await db.collection('sessions').deleteOne({ token: req.cookies.sid });
  res.clearCookie('sid'); res.json({ ok: true });
}));

app.get('/api/me', requireAuth, wrap(async (req, res) => res.json({ account: publicAccount(req.account) })));

app.patch('/api/me', requireAuth, wrap(async (req, res) => {
  const { fullName, email, password } = req.body || {};
  const set = {};
  if (fullName !== undefined) { if (!fullName.trim()) return res.status(400).json({ error: 'Name cannot be empty.' }); set.fullName = fullName.trim(); }
  if (email !== undefined) {
    const normalized = email.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (normalized !== req.account.email && await db.collection('employerAccounts').findOne({ email: normalized })) return res.status(409).json({ error: 'Another account already uses this email.' });
    set.email = normalized;
  }
  if (password !== undefined) { if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' }); set.passwordHash = hashPassword(password); }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update.' });
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $set: set });
  res.json({ ok: true });
}));

// Rotating invalidates the old key immediately -- there is no grace period.
app.post('/api/me/rotate-key', requireAuth, wrap(async (req, res) => {
  const apiKey = newApiKey('emp');
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $set: { apiKey } });
  res.json({ apiKey });
}));

// ---------------- subscription ----------------
app.post('/api/subscribe', requireAuth, wrap(async (req, res) => {
  const { returnBaseUrl } = req.body || {};
  const result = await payment.startSubscription({ returnBaseUrl: returnBaseUrl || `${req.protocol}://${req.get('host')}/`, accountId: req.account._id });
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $set: { 'subscription.providerRef': result.providerRef, 'subscription.provider': payment.PROVIDER, 'subscription.status': 'pending' } });
  res.json(result);
}));

app.post('/api/subscribe/confirm', requireAuth, wrap(async (req, res) => {
  const ref = req.account.subscription?.providerRef;
  if (!ref) return res.status(400).json({ error: 'No subscription in progress.' });
  const status = await payment.getSubscriptionStatus({ providerRef: ref });
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $set: { 'subscription.status': status.active ? 'active' : 'none', 'subscription.currentPeriodEnd': status.currentPeriodEnd || null } });
  res.json({ active: status.active });
}));

app.post('/api/subscribe/cancel', requireAuth, wrap(async (req, res) => {
  const ref = req.account.subscription?.providerRef;
  if (ref) await payment.cancelSubscription({ providerRef: ref });
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $set: { 'subscription.status': 'canceled' } });
  res.json({ ok: true });
}));

// ---------------- tokens (balance top-up) ----------------
app.post('/api/tokens/purchase', requireAuth, wrap(async (req, res) => {
  const { amountCents, returnBaseUrl } = req.body || {};
  const amount = parseInt(amountCents, 10);
  if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum purchase is $1.00.' });
  const ref = newId();
  const result = await payment.startOneTimePayment({ amountCents: amount, description: 'Vivacada query balance top-up', returnBaseUrl: returnBaseUrl || `${req.protocol}://${req.get('host')}/`, meta: { kind: 'tokens', ref, accountId: req.account._id, amountCents: amount } });
  await db.collection('pendingPayments').insertOne({ _id: ref, kind: 'tokens', accountId: req.account._id, amountCents: amount, providerRef: result.providerRef, status: 'pending', createdAt: now() });
  res.json({ ...result, ref });
}));

app.post('/api/tokens/purchase/confirm', requireAuth, wrap(async (req, res) => {
  const { ref } = req.body || {};
  const pending = await db.collection('pendingPayments').findOne({ _id: ref, accountId: req.account._id, kind: 'tokens' });
  if (!pending) return res.status(404).json({ error: 'Nothing to confirm.' });
  if (pending.status === 'paid') return res.json({ ok: true, alreadyProcessed: true });
  const { paid } = await payment.confirmOneTimePayment({ providerRef: pending.providerRef });
  if (!paid) return res.json({ ok: false });
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $inc: { balanceCents: pending.amountCents } });
  await db.collection('pendingPayments').updateOne({ _id: ref }, { $set: { status: 'paid' } });
  res.json({ ok: true });
}));

// ---------------- browse (subscription-gated) ----------------
app.get('/api/browse', requireAuth, requireSubscribed, wrap(async (req, res) => {
  const { subject, level, tier, institution, page } = req.query;
  const creds = await db.collection('credentials').find({ visibility: 'public' }).toArray();
  const out = [];
  for (const c of creds) {
    const holder = await db.collection('users').findOne({ _id: c.userId });
    if (!isEmployerEligible(c, holder)) continue;
    if (subject && !c.testRef.subject.toLowerCase().includes(subject.toLowerCase())) continue;
    const lvl = c.testRef.level || c.testRef.derivedLevel || null;
    if (level && lvl !== level) continue;
    if (tier && c.tier !== tier) continue;
    if (institution && !c.institutionName.toLowerCase().includes(institution.toLowerCase())) continue;
    out.push({ id: c._id, slug: c.publicSlug, name: holder.fullName, email: holder.email, subject: c.testRef.subject, level: lvl, tier: c.tier, institutionName: c.institutionName, institutionLabel: c.institutionLabel || null, score: c.score, issuedAt: c.issuedAt, showTranscript: !!c.showTranscript });
  }
  const pageSize = 25, p = Math.max(1, parseInt(page, 10) || 1);
  res.json({ total: out.length, page: p, pageSize, results: out.slice((p - 1) * pageSize, p * pageSize) });
}));

app.get('/api/browse/:id', requireAuth, requireSubscribed, wrap(async (req, res) => {
  const c = await db.collection('credentials').findOne({ _id: req.params.id });
  if (!c) return res.status(404).json({ error: 'Not found.' });
  const holder = await db.collection('users').findOne({ _id: c.userId });
  if (!isEmployerEligible(c, holder)) return res.status(404).json({ error: 'Not found.' });
  let transcript = null;
  if (c.showTranscript) { const sub = await db.collection('submissions').findOne({ _id: c.submissionId }); transcript = sub?.transcript || null; }
  res.json({ name: holder.fullName, email: holder.email, subject: c.testRef.subject, level: c.testRef.level || c.testRef.derivedLevel || null, tier: c.tier, institutionName: c.institutionName, institutionLabel: c.institutionLabel || null, score: c.score, modelUsed: c.modelUsed, issuedAt: c.issuedAt, transcript });
}));

// ---------------- AI query (token-funded) ----------------
app.post('/api/query', requireAuth, wrap(async (req, res) => {
  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Enter a search request.' });
  const ceiling = pricing.preCallCeilingCents(query);
  if (req.account.balanceCents < ceiling) return res.status(402).json({ error: `Insufficient balance. This query could cost up to $${(ceiling / 100).toFixed(2)}; your balance is $${(req.account.balanceCents / 100).toFixed(2)}.` });

  const { matches, usage } = await aiQuery.search({ db, queryText: query.trim() });
  const costCents = pricing.actualCostCents(usage);
  await db.collection('employerAccounts').updateOne({ _id: req.account._id }, { $inc: { balanceCents: -costCents } });
  await db.collection('aiQueries').insertOne({ _id: newId(), accountId: req.account._id, query: query.trim(), costCents, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, resultCount: matches.length, createdAt: now() });
  res.json({ matches, costCents, remainingBalanceCents: req.account.balanceCents - costCents });
}));

app.get('/api/usage', requireAuth, wrap(async (req, res) => {
  const rows = await db.collection('aiQueries').find({ accountId: req.account._id }).sort({ createdAt: -1 }).toArray();
  res.json({ queries: rows });
}));

// ---------------- special-catalog submissions ----------------
app.post('/api/catalog-submissions', requireAuth, wrap(async (req, res) => {
  const { subject, description } = req.body || {};
  let clean;
  try { clean = validateCatalogInput({ subject, description, catalogType: 'special' }); } catch (e) { return res.status(400).json({ error: e.message }); }
  try { await assertNoDuplicateSubject(db, clean.subject); } catch (e) { return res.status(409).json({ error: e.message }); }
  const submission = { _id: newId(), accountId: req.account._id, subject: clean.subject, description: clean.description, feeCents: payment.CATALOG_SUBMISSION_FEE_CENTS, paymentStatus: 'pending', paymentProviderRef: null, status: 'pending_payment', reviewedBy: null, reviewedAt: null, createdAt: now() };
  await db.collection('catalogSubmissions').insertOne(submission);
  res.json({ submission });
}));

app.post('/api/catalog-submissions/:id/pay', requireAuth, wrap(async (req, res) => {
  const sub = await db.collection('catalogSubmissions').findOne({ _id: req.params.id, accountId: req.account._id });
  if (!sub) return res.status(404).json({ error: 'Not found.' });
  const { returnBaseUrl } = req.body || {};
  const result = await payment.startOneTimePayment({ amountCents: sub.feeCents, description: `Vivacada special-catalog submission: ${sub.subject}`, returnBaseUrl: returnBaseUrl || `${req.protocol}://${req.get('host')}/`, meta: { kind: 'catalog', ref: sub._id, accountId: req.account._id } });
  await db.collection('catalogSubmissions').updateOne({ _id: sub._id }, { $set: { paymentProviderRef: result.providerRef } });
  res.json(result);
}));

app.post('/api/catalog-submissions/:id/pay/confirm', requireAuth, wrap(async (req, res) => {
  const sub = await db.collection('catalogSubmissions').findOne({ _id: req.params.id, accountId: req.account._id });
  if (!sub) return res.status(404).json({ error: 'Not found.' });
  if (sub.status !== 'pending_payment') return res.json({ ok: true, status: sub.status });
  const { paid } = await payment.confirmOneTimePayment({ providerRef: sub.paymentProviderRef });
  if (!paid) return res.json({ ok: false });
  // Payment is captured here and is non-refundable regardless of the review
  // outcome -- stated plainly in the ToS. Review only gates whether the
  // subject is ever added to the catalog, not whether the fee was charged.
  await db.collection('catalogSubmissions').updateOne({ _id: sub._id }, { $set: { paymentStatus: 'paid', status: 'pending' } });
  res.json({ ok: true, status: 'pending' });
}));

app.get('/api/catalog-submissions', requireAuth, wrap(async (req, res) => {
  const rows = await db.collection('catalogSubmissions').find({ accountId: req.account._id }).sort({ createdAt: -1 }).toArray();
  res.json({ submissions: rows });
}));

// ---------------- admin ----------------
app.get('/api/admin/catalog-submissions', requireAuth, requireAdmin, wrap(async (req, res) => {
  const status = req.query.status;
  const rows = await db.collection('catalogSubmissions').find(status ? { status } : { status: { $ne: 'pending_payment' } }).sort({ createdAt: 1 }).toArray();
  res.json({ submissions: rows });
}));

app.post('/api/admin/catalog-submissions/:id/approve', requireAuth, requireAdmin, wrap(async (req, res) => {
  const sub = await db.collection('catalogSubmissions').findOne({ _id: req.params.id });
  if (!sub) return res.status(404).json({ error: 'Not found.' });
  if (sub.status !== 'pending') return res.status(400).json({ error: 'Only pending submissions can be reviewed.' });
  let clean;
  try { clean = validateCatalogInput({ subject: sub.subject, description: sub.description, catalogType: 'special' }); } catch (e) { return res.status(400).json({ error: e.message }); }
  try { await assertNoDuplicateSubject(db, clean.subject); } catch (e) { return res.status(409).json({ error: e.message + ' (submission cannot be approved as-is)' }); }
  await db.collection('catalogEntries').insertOne({ _id: newId(), ...clean, createdAt: now() });
  await db.collection('catalogSubmissions').updateOne({ _id: sub._id }, { $set: { status: 'approved', reviewedBy: req.account._id, reviewedAt: now() } });
  res.json({ ok: true });
}));

app.post('/api/admin/catalog-submissions/:id/reject', requireAuth, requireAdmin, wrap(async (req, res) => {
  const sub = await db.collection('catalogSubmissions').findOne({ _id: req.params.id });
  if (!sub) return res.status(404).json({ error: 'Not found.' });
  if (sub.status !== 'pending') return res.status(400).json({ error: 'Only pending submissions can be reviewed.' });
  await db.collection('catalogSubmissions').updateOne({ _id: sub._id }, { $set: { status: 'rejected', reviewedBy: req.account._id, reviewedAt: now() } });
  res.json({ ok: true }); // no refund -- stated in the ToS at submission time
}));

app.get('/api/admin/employers', requireAuth, requireAdmin, wrap(async (req, res) => {
  const rows = await db.collection('employerAccounts').find({}).sort({ createdAt: -1 }).toArray();
  res.json({ accounts: rows.map((a) => ({ _id: a._id, email: a.email, fullName: a.fullName, role: a.role, suspended: a.suspended, subscriptionStatus: a.subscription?.status, balanceCents: a.balanceCents, createdAt: a.createdAt })) });
}));

app.post('/api/admin/employers/:id/suspend', requireAuth, requireAdmin, wrap(async (req, res) => {
  await db.collection('employerAccounts').updateOne({ _id: req.params.id }, { $set: { suspended: true } });
  res.json({ ok: true });
}));
app.post('/api/admin/employers/:id/reinstate', requireAuth, requireAdmin, wrap(async (req, res) => {
  await db.collection('employerAccounts').updateOne({ _id: req.params.id }, { $set: { suspended: false } });
  res.json({ ok: true });
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3300;
(async () => {
  db = await connect();
  const adminEmail = process.env.ADMIN_EMAIL, adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && !(await db.collection('employerAccounts').findOne({ email: adminEmail }))) {
    await db.collection('employerAccounts').insertOne({
      _id: newId(), email: adminEmail, fullName: 'Admin', passwordHash: hashPassword(adminPassword),
      role: 'admin', suspended: false, apiKey: newApiKey('adm'),
      subscription: { status: 'none', provider: null, providerRef: null, currentPeriodEnd: null }, balanceCents: 0, createdAt: now()
    });
    console.log('[employer-app] admin account seeded: ' + adminEmail);
  } else if (!adminEmail) {
    console.log('[employer-app] ADMIN_EMAIL/ADMIN_PASSWORD not set -- no admin account seeded.');
  }
  app.listen(PORT, () => console.log(`[employer-app] listening on http://localhost:${PORT}`));
})();
