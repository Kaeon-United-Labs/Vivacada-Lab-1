const app = document.getElementById('app');
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

let ME = null;
let CONFIG = { mockMode: true, tokenPricingMode: 'flat', subscriptionPriceCents: 4900, catalogSubmissionFeeCents: 2500 };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}
async function refreshMe() { try { ME = (await api('/me')).account; } catch (_) { ME = null; } return ME; }
function wireLogout() { const el = $('#logout'); if (el) el.onclick = async () => { await api('/accounts/logout', { method: 'POST' }); ME = null; location.hash = '#/'; }; }
function scanBadge() { return `<div class="scan-badge"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>`; }

function topbar() {
  const links = ME
    ? `<a href="#/dashboard">Dashboard</a>${ME.role === 'admin' ? '<a href="#/admin">Admin</a>' : ''}<a href="#" id="logout">Log out</a>`
    : '<a href="#/login">Log in</a><a href="#/signup">Sign up</a>';
  return `<div class="topbar"><a href="#/" style="text-decoration:none;color:inherit"><span class="wordmark">Vivacada<span class="dot">.</span> for Employers</span></a><nav class="nav">${links}</nav></div>`;
}

/* ---------------- landing ---------------- */
function renderLanding() {
  app.innerHTML = `${topbar()}
    <div class="card" style="text-align:center;padding:2.5rem 1.5rem">
      ${scanBadge()}
      <h1 style="margin-top:1rem">Search verified candidates</h1>
      <p class="muted">Browse opted-in, human- and AI-proctored exam credentials, or describe who you're looking for in plain language. Anyone can sign up — subscribe to browse, fund a balance to search.</p>
      <div style="margin-top:1rem"><a href="#/signup"><button class="primary">Sign up</button></a> <a href="#/login"><button class="secondary">Log in</button></a></div>
    </div>`;
  wireLogout();
}

/* ---------------- signup / login ---------------- */
function renderSignup() {
  app.innerHTML = `${topbar()}
    <div class="card">
      <h1>Create an account</h1>
      <p class="small muted">Open to anyone — see our <a href="/legal/terms.txt" target="_blank">terms of use</a>. An API key is issued automatically.</p>
      <label>Full name</label><input type="text" id="fullName">
      <label>Email</label><input type="email" id="email">
      <label>Password</label><input type="password" id="password">
      <div style="margin-top:1rem"><button class="primary" id="go">Create account</button></div>
      <div id="err"></div>
    </div>`;
  wireLogout();
  $('#go').onclick = async () => {
    try { const r = await api('/accounts', { method: 'POST', body: { fullName: $('#fullName').value, email: $('#email').value, password: $('#password').value } }); ME = r.account; location.hash = '#/dashboard'; }
    catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
}
function renderLogin() {
  app.innerHTML = `${topbar()}
    <div class="card">
      <h1>Log in</h1>
      <label>Email</label><input type="email" id="email">
      <label>Password</label><input type="password" id="password">
      <div style="margin-top:1rem"><button class="primary" id="go">Log in</button></div>
      <p class="small muted" style="margin-top:1rem">No account? <a href="#/signup">Sign up</a></p>
      <div id="err"></div>
    </div>`;
  wireLogout();
  const submit = async () => { try { const r = await api('/accounts/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } }); ME = r.account; location.hash = '#/dashboard'; } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; } };
  $('#go').onclick = submit;
  $('#password').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

/* ---------------- dashboard ---------------- */
let DASH_TAB = 'browse';
async function renderDashboard() {
  if (!ME) { location.hash = '#/login'; return; }
  app.innerHTML = `${topbar()}
    <h1>Dashboard</h1>
    <div class="row" style="margin-bottom:1rem">
      <div class="card stat"><div class="num">${ME.subscription.status === 'active' ? 'Active' : 'None'}</div><div class="lbl">Subscription</div></div>
      <div class="card stat"><div class="num">${money(ME.balanceCents)}</div><div class="lbl">Query balance</div></div>
      <div class="card stat"><div class="num">${cap(ME.role)}</div><div class="lbl">Role</div></div>
    </div>
    <div class="tabs">
      <button data-t="browse" class="${DASH_TAB === 'browse' ? 'active' : ''}">Browse</button>
      <button data-t="search" class="${DASH_TAB === 'search' ? 'active' : ''}">AI Search</button>
      <button data-t="submit" class="${DASH_TAB === 'submit' ? 'active' : ''}">Submit a test</button>
      <button data-t="usage" class="${DASH_TAB === 'usage' ? 'active' : ''}">Usage</button>
      <button data-t="account" class="${DASH_TAB === 'account' ? 'active' : ''}">Account</button>
    </div>
    <div id="panel"></div>`;
  wireLogout();
  app.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { DASH_TAB = b.dataset.t; renderDashboard(); });
  const panel = $('#panel');
  if (DASH_TAB === 'browse') renderBrowse(panel);
  else if (DASH_TAB === 'search') renderSearch(panel);
  else if (DASH_TAB === 'submit') renderSubmit(panel);
  else if (DASH_TAB === 'usage') renderUsage(panel);
  else renderAccount(panel);
}

function candidateRow(c) {
  return `<div class="match-card">
    <div class="spread"><strong>${esc(c.name)}</strong><span class="pill">${esc(c.tier === 'special' ? 'special catalog' : cap(c.level || ''))}</span></div>
    <div class="small muted">${esc(c.email)}</div>
    <div class="small" style="margin-top:.3rem">${esc(c.subject)} · ${esc(c.institutionName)}${c.institutionLabel ? ` <span class="pill">${esc(c.institutionLabel)}</span>` : ''} · score ${Math.round((c.score || 0) * 100)}%</div>
    ${c.rationale ? `<div class="rationale">${esc(c.rationale)}</div>` : ''}
  </div>`;
}

async function renderBrowse(panel) {
  panel.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  if (ME.subscription.status !== 'active') {
    panel.innerHTML = `<div class="card"><h2>Subscribe to browse</h2><p class="muted">Unlimited browsing of opted-in, eligible profiles for ${money(CONFIG.subscriptionPriceCents)}/month.</p><button class="primary" id="sub">Subscribe</button><div id="err"></div></div>`;
    $('#sub').onclick = async () => {
      const r = await api('/subscribe', { method: 'POST', body: { returnBaseUrl: location.origin + location.pathname } });
      if (r.mock) { await api('/subscribe/confirm', { method: 'POST' }); ME = (await api('/me')).account; renderDashboard(); }
      else if (r.redirectUrl) location.href = r.redirectUrl;
    };
    return;
  }
  panel.innerHTML = `<div class="card">
    <div class="row"><input type="text" id="f-subject" placeholder="Subject"><input type="text" id="f-level" placeholder="Level"><input type="text" id="f-institution" placeholder="Institution"></div>
    <div style="margin-top:.6rem"><button class="secondary" id="filter">Filter</button></div>
    <div id="results" style="margin-top:1rem"></div>
  </div>`;
  const load = async () => {
    const params = new URLSearchParams({ subject: $('#f-subject').value, level: $('#f-level').value, institution: $('#f-institution').value });
    const r = await api('/browse?' + params.toString());
    $('#results').innerHTML = `<p class="small muted">${r.total} result${r.total === 1 ? '' : 's'}</p>` + r.results.map(candidateRow).join('') || '<p class="muted">No matches.</p>';
  };
  $('#filter').onclick = load;
  load();
}

function renderSearch(panel) {
  const costNote = CONFIG.tokenPricingMode === 'flat' ? `Flat ${money(CONFIG.tokenFlatCostCents)} per search.` : 'Cost scales with actual usage — you\'ll never be charged more than the estimate shown before you search.';
  panel.innerHTML = `<div class="card">
    <h2>Describe who you're looking for</h2>
    <p class="small muted">${costNote} Balance: ${money(ME.balanceCents)}. <a href="#" id="fund">Add funds</a></p>
    <textarea id="q" placeholder="e.g. Someone with strong algorithms fundamentals who can explain trade-offs clearly"></textarea>
    <div style="margin-top:.6rem"><button class="primary" id="go">Search</button></div>
    <div id="err"></div>
    <div id="results" style="margin-top:1rem"></div>
  </div>`;
  $('#fund').onclick = (e) => { e.preventDefault(); DASH_TAB = 'account'; renderDashboard(); };
  $('#go').onclick = async () => {
    $('#go').disabled = true; $('#err').innerHTML = '';
    try {
      const r = await api('/query', { method: 'POST', body: { query: $('#q').value } });
      ME.balanceCents = r.remainingBalanceCents;
      $('#results').innerHTML = `<p class="small muted">Charged ${money(r.costCents)} · balance now ${money(r.remainingBalanceCents)}</p>` + (r.matches.map(candidateRow).join('') || '<p class="muted">No matches.</p>');
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
    $('#go').disabled = false;
  };
}

async function renderSubmit(panel) {
  panel.innerHTML = `<div class="card">
    <h2>Propose a special-catalog test</h2>
    <p class="small muted">${money(CONFIG.catalogSubmissionFeeCents)}, non-refundable if not approved. Only offensive or nonsensical submissions are rejected — a good-faith request describing a real subject is almost always approved.</p>
    <label>Subject name</label><input type="text" id="subj">
    <label>Description</label><textarea id="desc" placeholder="What should this test cover? The exam is generated entirely from this description."></textarea>
    <div style="margin-top:.6rem"><button class="primary" id="go">Submit (${money(CONFIG.catalogSubmissionFeeCents)})</button></div>
    <div id="err"></div>
  </div>
  <div class="card" id="history"><p class="muted">Loading your submissions…</p></div>`;
  $('#go').onclick = async () => {
    try {
      const r = await api('/catalog-submissions', { method: 'POST', body: { subject: $('#subj').value, description: $('#desc').value } });
      const pay = await api(`/catalog-submissions/${r.submission._id}/pay`, { method: 'POST', body: { returnBaseUrl: location.origin + location.pathname } });
      if (pay.mock) { await api(`/catalog-submissions/${r.submission._id}/pay/confirm`, { method: 'POST' }); renderSubmit(panel); }
      else if (pay.redirectUrl) location.href = pay.redirectUrl;
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  const subs = await api('/catalog-submissions');
  $('#history').innerHTML = subs.submissions.length ? `<h2>Your submissions</h2><table><thead><tr><th>Subject</th><th>Status</th></tr></thead><tbody>${subs.submissions.map((s) => `<tr><td>${esc(s.subject)}</td><td><span class="pill ${s.status === 'approved' ? 'good' : s.status === 'rejected' ? 'bad' : 'warn'}">${esc(s.status)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No submissions yet.</p>';
}

async function renderUsage(panel) {
  panel.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  const r = await api('/usage');
  panel.innerHTML = `<div class="card"><h2>Search history</h2>${r.queries.length ? `<table><thead><tr><th>Query</th><th>Cost</th><th>Results</th></tr></thead><tbody>${r.queries.map((q) => `<tr><td>${esc(q.query)}</td><td>${money(q.costCents)}</td><td>${q.resultCount}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No searches yet.</p>'}</div>`;
}

function renderAccount(panel) {
  panel.innerHTML = `<div class="card">
    <h2>API key</h2>
    <p class="small muted">Use this for headless access — every UI feature is also available via the same JSON API with <code>Authorization: Bearer &lt;key&gt;</code>.</p>
    <div class="key-box">${esc(ME.apiKey)}</div>
    <div style="margin-top:.6rem"><button class="secondary" id="rotate">Rotate key</button></div>
  </div>
  <div class="card">
    <h2>Add funds</h2>
    <div class="row"><input type="number" id="amt" placeholder="Amount in dollars" min="1" step="1"><button class="primary" id="fund">Add funds</button></div>
    <div id="ferr"></div>
  </div>
  <div class="card">
    <h2>Subscription</h2>
    <p>${ME.subscription.status === 'active' ? `Active${ME.subscription.currentPeriodEnd ? ' until ' + new Date(ME.subscription.currentPeriodEnd).toLocaleDateString() : ''}.` : 'No active subscription.'}</p>
    ${ME.subscription.status === 'active' ? '<button class="danger" id="cancel">Cancel subscription</button>' : ''}
  </div>
  <div class="card">
    <h2>Profile</h2>
    <label>Full name</label><input type="text" id="fullName" value="${esc(ME.fullName)}">
    <label>Email</label><input type="email" id="email" value="${esc(ME.email)}">
    <div style="margin-top:.6rem"><button class="secondary" id="save">Save</button></div>
    <div id="perr"></div>
  </div>`;
  $('#rotate').onclick = async () => { if (!confirm('Rotate your API key? The old key stops working immediately.')) return; const r = await api('/me/rotate-key', { method: 'POST' }); ME.apiKey = r.apiKey; renderAccount(panel); };
  $('#fund').onclick = async () => {
    const amountCents = Math.round(parseFloat($('#amt').value) * 100);
    try {
      const r = await api('/tokens/purchase', { method: 'POST', body: { amountCents, returnBaseUrl: location.origin + location.pathname } });
      if (r.mock) { await api('/tokens/purchase/confirm', { method: 'POST', body: { ref: r.ref } }); ME = (await api('/me')).account; renderDashboard(); }
      else if (r.redirectUrl) location.href = r.redirectUrl;
    } catch (e) { $('#ferr').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  if ($('#cancel')) $('#cancel').onclick = async () => { await api('/subscribe/cancel', { method: 'POST' }); ME = (await api('/me')).account; renderDashboard(); };
  $('#save').onclick = async () => { try { await api('/me', { method: 'PATCH', body: { fullName: $('#fullName').value, email: $('#email').value } }); ME = (await api('/me')).account; renderAccount(panel); } catch (e) { $('#perr').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; } };
}

/* ---------------- admin ---------------- */
async function renderAdmin() {
  if (!ME || ME.role !== 'admin') { location.hash = '#/dashboard'; return; }
  app.innerHTML = `${topbar()}<h1>Admin</h1><div class="card"><p class="muted">Loading…</p></div>`;
  wireLogout();
  const [subs, emps] = await Promise.all([api('/admin/catalog-submissions?status=pending'), api('/admin/employers')]);
  app.innerHTML = `${topbar()}
    <h1>Admin</h1>
    <div class="card">
      <h2>Pending catalog submissions</h2>
      ${subs.submissions.length ? subs.submissions.map((s) => `
        <div class="match-card">
          <div class="spread"><strong>${esc(s.subject)}</strong><span>${money(s.feeCents)} paid</span></div>
          <p class="small">${esc(s.description)}</p>
          <button class="primary" data-approve="${s._id}">Approve</button>
          <button class="danger" data-reject="${s._id}">Reject (offensive/nonsensical)</button>
        </div>`).join('') : '<p class="muted">Nothing pending.</p>'}
    </div>
    <div class="card">
      <h2>Employer accounts</h2>
      <table><thead><tr><th>Email</th><th>Subscription</th><th>Balance</th><th>Status</th><th></th></tr></thead><tbody>
        ${emps.accounts.map((a) => `<tr><td>${esc(a.email)}</td><td>${esc(a.subscriptionStatus)}</td><td>${money(a.balanceCents)}</td><td>${a.suspended ? '<span class="pill bad">suspended</span>' : '<span class="pill good">active</span>'}</td><td>${a.role === 'admin' ? '' : `<a href="#" data-toggle="${a._id}" data-cur="${a.suspended}">${a.suspended ? 'Reinstate' : 'Suspend'}</a>`}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  app.querySelectorAll('[data-approve]').forEach((b) => b.onclick = async () => { await api('/admin/catalog-submissions/' + b.dataset.approve + '/approve', { method: 'POST' }); renderAdmin(); });
  app.querySelectorAll('[data-reject]').forEach((b) => b.onclick = async () => { if (!confirm('Reject this submission? The fee is not refunded, per the terms shown at submission.')) return; await api('/admin/catalog-submissions/' + b.dataset.reject + '/reject', { method: 'POST' }); renderAdmin(); });
  app.querySelectorAll('[data-toggle]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); const suspended = a.dataset.cur === 'true'; await api(`/admin/employers/${a.dataset.toggle}/${suspended ? 'reinstate' : 'suspend'}`, { method: 'POST' }); renderAdmin(); });
}

/* ---------------- payment return ---------------- */
async function handleReturn() {
  app.innerHTML = `${topbar()}<div class="card"><p class="muted">Confirming…</p></div>`;
  const params = new URLSearchParams(location.hash.replace(/^#\/return\?/, ''));
  const kind = params.get('kind');
  try {
    if (kind === 'subscription') await api('/subscribe/confirm', { method: 'POST' });
    else if (kind === 'tokens') await api('/tokens/purchase/confirm', { method: 'POST', body: { ref: params.get('ref') } });
    else if (kind === 'catalog') await api(`/catalog-submissions/${params.get('ref')}/pay/confirm`, { method: 'POST' });
  } catch (_) {}
  ME = (await api('/me').catch(() => ({ account: null }))).account;
  location.hash = '#/dashboard';
}

/* ---------------- router ---------------- */
function route() {
  const h = location.hash.slice(1) || '/';
  if (h.startsWith('/return')) return handleReturn();
  if (h === '/') return ME ? renderDashboard() : renderLanding();
  if (h === '/login') return renderLogin();
  if (h === '/signup') return renderSignup();
  if (h === '/dashboard') return renderDashboard();
  if (h === '/admin') return renderAdmin();
  ME ? renderDashboard() : renderLanding();
}
window.addEventListener('hashchange', route);
(async () => { try { CONFIG = await (await fetch('/api/config')).json(); } catch (_) {} await refreshMe(); route(); })();
