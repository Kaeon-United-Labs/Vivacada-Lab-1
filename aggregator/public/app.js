const app = document.getElementById('app');
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
let ME = null; // { email, fullName, dataSharing, role } | null
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function refreshMe() { try { ME = (await api('/me')).user; } catch (_) { ME = null; } return ME; }
function topbar() {
  const links = ME
    ? `<a href="#/about">About</a><a href="#/dashboard">Dashboard</a><a href="#/institutions">Find an institution</a>${ME.role === 'admin' ? '<a href="#/admin">Admin</a>' : ''}<a href="#" id="logout">Log out</a>`
    : '<a href="#/about">About</a><a href="#/institutions">Find an institution</a><a href="#/login">Log in</a><a href="#/signup">Sign up</a>';
  return `<div class="topbar"><a href="#/" style="text-decoration:none;color:inherit"><span class="wordmark">Vivacada<span class="dot">.</span></span></a><nav class="nav">${links}</nav></div>`;
}
function wireLogout() { const el = $('#logout'); if (el) el.onclick = async () => { await api('/accounts/logout', { method: 'POST' }); ME = null; location.hash = '#/'; }; }

function subjectOf(testRef) { return testRef.subject; } // both tiers carry .subject now
function institutionDisplay(name, label) { return label ? `${esc(name)} <span class="pill">${esc(label)}</span>` : esc(name); }

/* ---------------- about ---------------- */
function renderAbout() {
  app.innerHTML = `${topbar()}
    <div class="card" style="text-align:center;padding:2.5rem 1.5rem">
      <div class="seal"><span class="lvl">Registry</span><span class="sub">Vivacada</span></div>
      <h1 style="margin-top:1.2rem">Credentials, verified.</h1>
      <p class="muted">An AI-interviewed, human-proctored way to prove what you know — without a semester, a degree program, or an admissions process.</p>
      ${!ME ? '<div style="margin-top:1rem"><a href="#/login"><button class="primary">Log in</button></a> <a href="#/signup"><button class="secondary">Sign up</button></a></div>' : ''}
    </div>
    <div class="card">
      <h2>What Vivacada is</h2>
      <p>Vivacada lets someone prove they know a subject, at a real and calibrated level of depth, by taking a structured oral-style exam administered by an AI interviewer and watched in person by a human proctor. Pass, and you get a verifiable, shareable credential. It's built for people who are competent but credential-poor: career-changers, self-taught practitioners, and anyone who wants to prove a specific skill without the time or cost of a full degree.</p>
    </div>
    <div class="card">
      <h2>How a test works</h2>
      <p>You take the exam at a participating institution — usually a walk-up kiosk. A staff proctor watches the session in person; there's no remote AI surveillance, no webcam monitoring, no browser lockdown software. The exam itself is a fixed-length Socratic interview: concrete tasks mixed with conceptual questions, generated fresh for every attempt so no two exams are identical. When it's done, the proctor confirms what they witnessed and releases the result to Vivacada.</p>
    </div>
    <div class="card">
      <h2>Why an institution, not a webcam</h2>
      <p>Vivacada doesn't try to build trust from nothing. The testing software is open source and self-hosted — an institution runs it, supplies its own AI compute, and its own staff proctor the exams, the same way many institutions already proctor GED tests or professional certifications. That in-person trust is what makes a Vivacada credential hard to fake, and it's why the software is deliberately not a centralized, remotely-monitored testing platform.</p>
    </div>
    <div class="card">
      <h2>What Vivacada (this site) does</h2>
      <p>This is the registry: it holds accounts, the shared subject catalog every institution draws from, and the credentials and badges that come out of a passing exam. You control what's public and what's private per credential, including whether its full interview transcript is visible. Vivacada doesn't charge for testing or for holding a credential — the only paid product is employer access to a pool of candidates who've explicitly opted in.</p>
    </div>
    <div class="card">
      <h2>For employers</h2>
      <p>Employers can match against public, opted-in credentials by subject and level. Data sharing is off by default for every account, and anyone under 18 at the time a given credential was earned is excluded from matching entirely, regardless of their sharing settings.</p>
    </div>`;
  wireLogout();
}

/* ---------------- signup / login ---------------- */
function renderSignup() {
  app.innerHTML = `${topbar()}
    <div class="card">
      <h1>Create your account</h1>
      <label>Full name</label><input type="text" id="fullName" placeholder="Jordan Rivera">
      <p class="small muted">Shown on your credentials, alongside your email.</p>
      <label>Email</label><input type="email" id="email">
      <label>Password</label><input type="password" id="password">
      <div style="margin-top:1rem"><button class="primary" id="go">Create account</button></div>
      <div id="err"></div>
    </div>`;
  wireLogout();
  $('#go').onclick = async () => {
    try {
      const r = await api('/accounts', { method: 'POST', body: { fullName: $('#fullName').value, email: $('#email').value, password: $('#password').value } });
      ME = r.user;
      if (r.claimed > 0) sessionStorage.setItem('vivacada-signup-notice', `Attached ${r.claimed} result${r.claimed > 1 ? 's' : ''} already submitted under this email${r.credentialsCreated ? ` — ${r.credentialsCreated} new credential${r.credentialsCreated > 1 ? 's' : ''}.` : '.'}`);
      location.hash = '#/dashboard';
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
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
  const submit = async () => {
    try { const r = await api('/accounts/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } }); ME = r.user; location.hash = '#/dashboard'; }
    catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  $('#go').onclick = submit;
  $('#password').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

/* ---------------- dashboard ---------------- */
async function renderDashboard() {
  let me;
  try { me = await api('/me'); ME = me.user; } catch (_) { return (location.hash = '#/login'); }
  const notice = sessionStorage.getItem('vivacada-signup-notice');
  if (notice) sessionStorage.removeItem('vivacada-signup-notice');
  app.innerHTML = `${topbar()}
    <h1>Your credentials</h1>
    ${notice ? `<div class="notice" style="margin-bottom:1rem">${esc(notice)}</div>` : ''}
    <div class="card">
      <div class="spread"><h2>Credentials</h2></div>
      ${me.credentials.length ? me.credentials.map((c) => `
        <div class="spread" style="padding:.8rem 0;border-bottom:1px solid var(--line)">
          <div><strong>${esc(subjectOf(c.testRef))}</strong>${c.tier === 'special' ? ' <span class="pill">special catalog</span>' : ` · ${cap(c.testRef.level)}`}
            <div class="small muted">${institutionDisplay(c.institutionName, c.institutionLabel)} · ${esc(c.modelUsed.provider)}/${esc(c.modelUsed.name)} · <a href="#/c/${esc(c.publicSlug)}" target="_blank">public page</a></div></div>
          <div class="row" style="text-align:right">
            <div class="toggle-row"><input type="checkbox" data-vis="${c._id}" ${c.visibility === 'public' ? 'checked' : ''}><label style="margin:0">Public</label></div>
            <div class="toggle-row"><input type="checkbox" data-tx="${c._id}" ${c.showTranscript ? 'checked' : ''}><label style="margin:0">Show transcript</label></div>
          </div>
        </div>`).join('') : '<p class="muted">No credentials yet. Take an exam at a participating institution — sign in there with this same email and your result will attach here automatically.</p>'}
    </div>
    <div class="card">
      <div class="toggle-row"><input type="checkbox" id="sharing" ${me.user.dataSharing ? 'checked' : ''}><label style="margin:0;font-weight:600">Share my profile with employers</label></div>
      <p class="small muted">Off by default. When on, opted-in employers can match you to roles based on your public credentials. Age is checked per credential against the birthdate given at test time — a credential earned while you were under 18 becomes eligible for matching on its own, the moment your recorded birthdate implies you've turned 18, with nothing further needed from you.</p>
    </div>
    <div class="card">
      <h2>Profile</h2>
      <p class="small muted">Your name and email appear on your public credentials.</p>
      <label>Full name</label><input type="text" id="profile-name" value="${esc(me.user.fullName || '')}">
      <label>Email</label><input type="email" id="profile-email" value="${esc(me.user.email)}">
      <div style="margin-top:.8rem"><button class="primary" id="profile-save">Save</button></div>
      <div id="profile-err"></div>
      <div id="profile-notice"></div>
    </div>`;
  wireLogout();
  app.querySelectorAll('[data-vis]').forEach((cb) => cb.onchange = () => api('/credentials/' + cb.dataset.vis, { method: 'PATCH', body: { visibility: cb.checked ? 'public' : 'hidden' } }).catch(() => { cb.checked = !cb.checked; }));
  app.querySelectorAll('[data-tx]').forEach((cb) => cb.onchange = () => api('/credentials/' + cb.dataset.tx, { method: 'PATCH', body: { showTranscript: cb.checked } }).catch(() => { cb.checked = !cb.checked; }));
  $('#sharing').onchange = (e) => api('/me', { method: 'PATCH', body: { dataSharing: e.target.checked } }).catch(() => { e.target.checked = !e.target.checked; });
  $('#profile-save').onclick = async () => {
    const fullName = $('#profile-name').value.trim();
    const email = $('#profile-email').value.trim();
    $('#profile-err').innerHTML = ''; $('#profile-notice').innerHTML = '';
    try {
      const r = await api('/me', { method: 'PATCH', body: { fullName, email } });
      ME = { ...ME, fullName, email };
      if (r.claimed > 0) $('#profile-notice').innerHTML = `<div class="notice" style="margin-top:.6rem">Attached ${r.claimed} result${r.claimed > 1 ? 's' : ''} already submitted under your new email${r.credentialsCreated ? ` — ${r.credentialsCreated} new credential${r.credentialsCreated > 1 ? 's' : ''}.` : '.'}</div>`;
      renderDashboard();
    } catch (e) { $('#profile-err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
}

/* ---------------- public credential page ---------------- */
async function renderCredential(slugId) {
  app.innerHTML = `${topbar()}<div class="card"><p class="muted">Loading…</p></div>`;
  let data;
  try { data = await api('/credentials/' + slugId); } catch (e) { app.innerHTML = `${topbar()}<div class="card"><div class="error-box">${esc(e.message)}</div></div>`; return; }
  const c = data.credential;
  const uncal = c.tier === 'special';
  app.innerHTML = `${topbar()}
    <div class="card" style="text-align:center;padding:2.5rem 1.5rem">
      <div class="seal ${uncal ? 'uncal' : ''}"><span class="lvl">${uncal ? 'Special' : cap(c.testRef.level)}</span><span class="sub">${esc(subjectOf(c.testRef))}</span></div>
      <h1 style="margin-top:1.2rem">${esc(subjectOf(c.testRef))}</h1>
      <p>${uncal ? '<span class="pill">special catalog</span>' : `${cap(c.testRef.level)} <span class="pill public">Vivacada verified</span>`}</p>
      <p>${data.holder ? `<strong>${esc(data.holder.fullName || 'Unnamed holder')}</strong> · ${esc(data.holder.email)}` : ''}</p>
      <p class="small muted">Proctored by ${institutionDisplay(c.institutionName, c.institutionLabel)} · Model: ${esc(c.modelUsed.provider)}/${esc(c.modelUsed.name)}</p>
      <p class="small mono">Credential ${esc(c.publicSlug)}</p>
      <div class="notice" style="text-align:left;max-width:460px;margin:1rem auto 0"><code>&lt;img src="${location.origin}/api/badge/${esc(c.publicSlug)}.svg"&gt;</code></div>
    </div>
    ${data.transcript ? `<div class="card"><h2>Interview transcript</h2><p class="small muted">Shared by the credential holder.</p>
      ${(data.feedback || {}).summary ? `<p>${esc(data.feedback.summary)}</p>` : ''}
      ${data.transcript.map((t) => `<div style="margin:.5rem 0;padding:.6rem .8rem;border-radius:6px;background:${t.role === 'assistant' ? 'var(--paper)' : '#fff'};border:1px solid var(--line);white-space:pre-wrap">${esc(t.content)}</div>`).join('')}</div>` : ''}`;
  wireLogout();
}

/* ---------------- admin dashboard ---------------- */
async function renderAdmin() {
  if (!ME || ME.role !== 'admin') { location.hash = '#/dashboard'; return; }
  app.innerHTML = `${topbar()}<h1>Admin</h1><div class="card"><p class="muted">Loading…</p></div>`;
  wireLogout();
  let institutions, catalog, labelsResp;
  try { [institutions, catalog, labelsResp] = await Promise.all([api('/institutions'), api('/catalog'), api('/institution-labels')]); }
  catch (e) { app.innerHTML = `${topbar()}<div class="card"><div class="error-box">${esc(e.message)}</div></div>`; wireLogout(); return; }
  const labels = labelsResp.labels || [];

  const statusPill = (s) => `<span class="pill ${s === 'approved' ? 'public' : s === 'revoked' ? 'fail' : ''}">${esc(s)}</span>`;
  const labelSelect = (id, current) => `<select data-labelfor="${id}"><option value="">No label</option>${labels.map((l) => `<option value="${esc(l)}" ${current === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  app.innerHTML = `${topbar()}
    <h1>Admin</h1>

    <div class="card">
      <h2>Institutions</h2>
      <p class="small muted">New institutions start <strong>pending</strong> and cannot submit results until approved. Label is optional and describes how an institution actually proctors — it shows everywhere the institution's name appears.</p>
      <table><thead><tr><th>Name</th><th>Status</th><th>Label</th><th>API key</th><th>Actions</th></tr></thead><tbody>
        ${institutions.institutions.map((i) => `
          <tr>
            <td>${esc(i.name)}${i.contact ? `<div class="small muted">${esc(i.contact)}</div>` : ''}</td>
            <td>${statusPill(i.status)}</td>
            <td>${labelSelect(i._id, i.label || '')}</td>
            <td class="mono small">${esc(i.apiKey)} <a href="#" data-copy="${esc(i.apiKey)}" class="small">copy</a></td>
            <td>
              ${i.status !== 'approved' ? `<button class="secondary" data-approve="${i._id}">Approve</button>` : ''}
              ${i.status !== 'revoked' ? `<button class="danger" data-revoke="${i._id}">Revoke</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No institutions yet.</td></tr>'}
      </tbody></table>
      <h3 style="margin-top:1.2rem">Add institution</h3>
      <label>Name</label><input type="text" id="inst-name" placeholder="Riverside Community Institution">
      <label>Contact (optional)</label><input type="text" id="inst-contact" placeholder="email or phone">
      <label>Label (optional)</label><select id="inst-label"><option value="">No label</option>${labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
      <div style="margin-top:.8rem"><button class="primary" id="inst-create">Create</button></div>
      <div id="inst-err"></div>
    </div>

    <div class="card">
      <h2>Catalog</h2>
      <p class="small muted"><strong>Main catalog</strong> subjects are browsable, with the five fixed difficulty levels applying uniformly. <strong>Special catalog</strong> subjects aren't browsed — a student finds one only by typing its exact name; there's no chosen level, and the exam is generated entirely from the description, so a description is required.</p>
      <table><thead><tr><th>Subject</th><th>Catalog</th><th>Description</th><th>Actions</th></tr></thead><tbody>
        ${[...catalog.main, ...catalog.special].map((s) => {
          const isSpecial = catalog.special.some((x) => x._id === s._id);
          return `
          <tr>
            <td>${esc(s.subject)}</td>
            <td><span class="pill${isSpecial ? '' : ' public'}">${isSpecial ? 'Special' : 'Main'}</span></td>
            <td class="small muted">${esc(s.description || '—')}</td>
            <td>
              <a href="#" data-edit="${s._id}" data-cursubj="${esc(s.subject)}" data-curdesc="${esc(s.description || '')}" class="small">edit</a> ·
              <a href="#" data-move="${s._id}" data-totype="${isSpecial ? 'main' : 'special'}" class="small">move to ${isSpecial ? 'main' : 'special'}</a> ·
              <a href="#" data-remove="${s._id}" class="small" style="color:var(--alert)">remove</a>
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="4" class="muted">No subjects yet.</td></tr>'}
      </tbody></table>
      <h3 style="margin-top:1.2rem">Add subject</h3>
      <label>Subject name</label><input type="text" id="cat-subject" placeholder="Algorithms & Data Structures">
      <label>Catalog</label>
      <select id="cat-type"><option value="main">Main (browsable, leveled)</option><option value="special">Special (autocomplete only, no level)</option></select>
      <label>Description <span id="cat-desc-required" class="small muted"></span></label>
      <textarea id="cat-desc" placeholder="Brief context to help the test generator."></textarea>
      <div style="margin-top:.8rem"><button class="primary" id="cat-create">Add subject</button></div>
      <div id="cat-err"></div>
    </div>`;
  wireLogout();

  app.querySelectorAll('[data-copy]').forEach((a) => a.onclick = (e) => { e.preventDefault(); navigator.clipboard?.writeText(a.dataset.copy); a.textContent = 'copied'; setTimeout(() => (a.textContent = 'copy'), 1200); });
  app.querySelectorAll('[data-approve]').forEach((b) => b.onclick = async () => { await api('/institutions/' + b.dataset.approve, { method: 'PATCH', body: { status: 'approved' } }); renderAdmin(); });
  app.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => { if (!confirm('Revoke this institution\'s API key? It stops working immediately.')) return; await api('/institutions/' + b.dataset.revoke, { method: 'PATCH', body: { status: 'revoked' } }); renderAdmin(); });
  app.querySelectorAll('[data-labelfor]').forEach((sel) => sel.onchange = async () => {
    try { await api('/institutions/' + sel.dataset.labelfor, { method: 'PATCH', body: { label: sel.value } }); }
    catch (e) { $('#inst-err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  });
  app.querySelectorAll('[data-remove]').forEach((a) => a.onclick = async (e) => {
    e.preventDefault();
    if (!confirm('Remove this subject from the catalog? Existing credentials referencing it are unaffected.')) return;
    try { await api('/catalog/' + a.dataset.remove, { method: 'DELETE' }); renderAdmin(); }
    catch (e2) { $('#cat-err').innerHTML = `<div class="error-box">${esc(e2.message)}</div>`; }
  });
  app.querySelectorAll('[data-move]').forEach((a) => a.onclick = async (e) => {
    e.preventDefault();
    try { await api('/catalog/' + a.dataset.move, { method: 'PATCH', body: { catalogType: a.dataset.totype } }); renderAdmin(); }
    catch (e2) { $('#cat-err').innerHTML = `<div class="error-box">${esc(e2.message)}</div>`; }
  });
  app.querySelectorAll('[data-edit]').forEach((a) => a.onclick = async (e) => {
    e.preventDefault();
    const subject = prompt('Subject name:', a.dataset.cursubj);
    if (subject === null) return;
    const description = prompt('Description:', a.dataset.curdesc);
    if (description === null) return;
    try { await api('/catalog/' + a.dataset.edit, { method: 'PATCH', body: { subject, description } }); renderAdmin(); }
    catch (e2) { $('#cat-err').innerHTML = `<div class="error-box">${esc(e2.message)}</div>`; }
  });

  $('#inst-create').onclick = async () => {
    const name = $('#inst-name').value.trim();
    if (!name) return;
    try { await api('/institutions', { method: 'POST', body: { name, contact: $('#inst-contact').value.trim(), label: $('#inst-label').value } }); renderAdmin(); }
    catch (e) { $('#inst-err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  const syncDescRequired = () => { $('#cat-desc-required').textContent = $('#cat-type').value === 'special' ? '(required for special)' : '(optional)'; };
  syncDescRequired();
  $('#cat-type').onchange = syncDescRequired;
  $('#cat-create').onclick = async () => {
    const subject = $('#cat-subject').value.trim();
    if (!subject) return;
    try { await api('/catalog', { method: 'POST', body: { subject, description: $('#cat-desc').value.trim(), catalogType: $('#cat-type').value } }); renderAdmin(); }
    catch (e) { $('#cat-err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
}

/* ---------------- institutions directory (public) ---------------- */
async function renderInstitutionsDirectory() {
  app.innerHTML = `${topbar()}<h1>Find an institution</h1><div class="card"><p class="muted">Loading…</p></div>`;
  wireLogout();
  let data;
  try { data = await api('/institutions/directory'); }
  catch (e) { app.innerHTML = `${topbar()}<div class="card"><div class="error-box">${esc(e.message)}</div></div>`; wireLogout(); return; }
  app.innerHTML = `${topbar()}
    <h1>Find an institution</h1>
    <p class="muted">Vivacada-approved institutions offering proctored testing.</p>
    <div class="card">
      <table><tbody>
        ${data.institutions.map((i) => `<tr><td><strong>${esc(i.name)}</strong>${i.label ? ` <span class="pill">${esc(i.label)}</span>` : ''}${i.contact ? `<div class="small muted">${esc(i.contact)}</div>` : ''}</td></tr>`).join('') || '<tr><td class="muted">No approved institutions yet.</td></tr>'}
      </tbody></table>
    </div>`;
  wireLogout();
}

/* ---------------- router ---------------- */
function route() {
  const h = location.hash.slice(1) || '/';
  if (h === '/') return ME ? renderDashboard() : renderAbout();
  if (h === '/about') return renderAbout();
  if (h === '/login') return renderLogin();
  if (h === '/signup') return renderSignup();
  if (h === '/dashboard') return renderDashboard();
  if (h === '/admin') return renderAdmin();
  if (h === '/institutions') return renderInstitutionsDirectory();
  const credM = h.match(/^\/c\/(.+)$/); if (credM) return renderCredential(credM[1]);
  ME ? renderDashboard() : renderAbout();
}
window.addEventListener('hashchange', route);
refreshMe().then(route);
