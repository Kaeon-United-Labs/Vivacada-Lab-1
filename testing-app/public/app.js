const app = document.getElementById('app');
let TOKEN = null;
let PATRON_NAME = null; // set after email entry, shown in the corner until back at unlock
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
function typeset(el) { if (window.MathJax?.typesetPromise) MathJax.typesetPromise([el]).catch(() => {}); }

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(TOKEN ? { 'X-Session-Token': TOKEN } : {}) };
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; e.retryable = data.retryable; throw e; }
  return data;
}
function topbar(stage) {
  return `<div class="topbar"><div class="wordmark">Vivacada<span class="dot">.</span></div>
    <div class="topbar-right">${PATRON_NAME ? `<span class="patron-name">${esc(PATRON_NAME)}</span>` : ''}<div class="stage-label">${esc(stage)}</div></div></div>`;
}

/* ---------------- unlock ---------------- */
function renderUnlock() {
  PATRON_NAME = null;
  app.innerHTML = `
    ${topbar('Locked')}
    <div class="card" style="text-align:center;padding:2.5rem 1.5rem">
      <span class="stamp">Testing Kiosk</span>
      <h1 style="margin-top:1.2rem">Enter the unlock code</h1>
      <p class="muted">Ask institution staff if you don't have it.</p>
      <input type="password" id="code" placeholder="Unlock code" style="max-width:280px;margin:0 auto;text-align:center">
      <div style="margin-top:1rem"><button class="primary" id="go">Unlock</button></div>
      <div id="err"></div>
    </div>`;
  const submit = async () => {
    const code = $('#code').value.trim();
    if (!code) return;
    try {
      const r = await api('/api/unlock', { method: 'POST', body: { code } });
      TOKEN = r.sessionToken;
      renderEmail();
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  $('#go').onclick = submit;
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

/* ---------------- email ---------------- */
function renderEmail() {
  app.innerHTML = `
    ${topbar('Sign in')}
    <div class="card">
      <h1>What's your email?</h1>
      <div class="notice small" style="margin-bottom:1rem">
        <strong>A Vivacada account is expected.</strong> If you already have one, use that email and your result will attach to it automatically. If not, your result is archived under this email — sign up at Vivacada with the <em>same</em> email afterward to claim it. There's no other way to link a result to an account.
      </div>
      <label>Email</label>
      <input type="email" id="email" placeholder="you@example.com">
      <label>Birthdate</label>
      <input type="date" id="birthdate">
      <p class="small muted">Confirmed by the proctor, the same way the rest of this session is. Used only to determine when this specific credential can be considered for employer matching — it's never shown on the credential.</p>
      <div style="margin-top:1rem"><button class="primary" id="go">Continue</button></div>
      <div id="err"></div>
    </div>`;
  const submit = async () => {
    const email = $('#email').value.trim();
    const birthdate = $('#birthdate').value;
    try { const r = await api('/api/email', { method: 'POST', body: { email, birthdate } }); PATRON_NAME = r.session.patronName; renderSelect(); }
    catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  $('#go').onclick = submit;
  $('#email').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

/* ---------------- test selection ---------------- */
const normalizeSubjectName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function renderSelect() {
  app.innerHTML = `${topbar('Choose a test')}<div class="card"><p class="muted">Loading catalog…</p></div>`;
  const cat = await api('/api/catalog').catch(() => ({ main: [], special: [], levels: [] }));
  app.innerHTML = `
    ${topbar('Choose a test')}
    <div class="tabs">
      <button data-m="catalog" class="active">Catalog</button>
      <button data-m="special">Other tests</button>
    </div>
    <div class="card" id="panel"></div>
    <div id="err"></div>`;
  const panel = $('#panel');
  const renderCatalog = () => {
    panel.innerHTML = `
      <h2>Pick a subject and level</h2>
      <label>Subject</label>
      <select id="subject">${(cat.main || []).map((s) => `<option value="${esc(s.subject)}">${esc(s.subject)}</option>`).join('') || '<option disabled selected>No subjects available</option>'}</select>
      <label>Level</label>
      <select id="level">${(cat.levels || []).map((l) => `<option value="${esc(l)}">${esc(cap(l))}</option>`).join('')}</select>
      <div style="margin-top:1.2rem"><button class="primary" id="begin">Begin exam</button></div>`;
    $('#begin').onclick = () => begin({ mode: 'catalog', subject: $('#subject').value, level: $('#level').value });
  };
  const renderSpecial = () => {
    panel.innerHTML = `
      <h2>Search for a test</h2>
      <p class="muted small">These tests aren't in the main catalog. Type a name to search; pick one from the suggestions. There's no difficulty level to choose — it isn't part of these tests.</p>
      <label>Test name</label>
      <div style="position:relative">
        <input type="text" id="special-input" placeholder="Start typing…" autocomplete="off">
        <div id="special-suggestions" class="suggestions" style="display:none"></div>
      </div>
      <div style="margin-top:1.2rem"><button class="primary" id="begin" disabled>Begin exam</button></div>`;
    const input = $('#special-input'), sugg = $('#special-suggestions'), beginBtn = $('#begin');
    const list = cat.special || [];
    let resolved = null; // the exact matched entry, cleared whenever the input changes without a fresh match
    const showSuggestions = () => {
      const q = normalizeSubjectName(input.value);
      resolved = null; beginBtn.disabled = true;
      if (!q) { sugg.style.display = 'none'; return; }
      const matches = list.filter((s) => normalizeSubjectName(s.subject).includes(q));
      const exact = list.find((s) => normalizeSubjectName(s.subject) === q);
      if (exact) { resolved = exact; beginBtn.disabled = false; }
      if (!matches.length) { sugg.style.display = 'none'; return; }
      sugg.innerHTML = matches.map((s) => `<div class="suggestion" data-pick="${esc(s.subject)}">${esc(s.subject)}</div>`).join('');
      sugg.style.display = 'block';
      sugg.querySelectorAll('[data-pick]').forEach((el) => el.onclick = () => {
        input.value = el.dataset.pick;
        resolved = list.find((s) => normalizeSubjectName(s.subject) === normalizeSubjectName(el.dataset.pick));
        beginBtn.disabled = !resolved;
        sugg.style.display = 'none';
      });
    };
    input.oninput = showSuggestions;
    input.onblur = () => setTimeout(() => { sugg.style.display = 'none'; }, 150); // let a click land first
    input.onfocus = () => { if (input.value) showSuggestions(); };
    beginBtn.onclick = () => { if (resolved) begin({ mode: 'special', subject: resolved.subject }); };
  };
  const begin = async (body) => {
    $('#begin').disabled = true;
    try { const r = await api('/api/start', { method: 'POST', body }); renderInterview(r.session); }
    catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#begin').disabled = false; }
  };
  app.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
    app.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('active', x === b));
    b.dataset.m === 'catalog' ? renderCatalog() : renderSpecial();
  });
  renderCatalog();
}

/* ---------------- interview ---------------- */
function renderInterview(session) {
  const total = session.progress.total;
  let asked = session.progress.asked, mode = 'essay';
  app.innerHTML = `
    ${topbar('Exam in progress')}
    <h1>${esc(session.testRef.title)}${session.testRef.tier === 'catalog' ? ' · ' + cap(session.testRef.level) : ''}</h1>
    <div class="spread"><span class="mono small" id="qcount">Question ${asked} of ${total}</span><span class="small muted" id="qtopic"></span></div>
    <div class="progress-track"><div class="progress-fill" id="prog" style="width:${(asked - 1) / total * 100}%"></div></div>
    <div class="chat" id="chat"></div>
    <div class="card">
      <div class="tabs"><button class="tabm active" data-m="essay">Essay</button><button class="tabm" data-m="code">Code</button><button class="tabm" data-m="latex">LaTeX</button></div>
      <textarea class="essay" id="answer" placeholder="Write your answer…"></textarea>
      <div id="preview" class="small" style="display:none;margin-top:.4rem"></div>
      <div class="spread" style="margin-top:.8rem">
        <button class="danger" id="abandon">Abandon</button>
        <button class="primary" id="send">Send answer</button>
      </div>
      <div id="err"></div>
    </div>`;
  const chat = $('#chat');
  const addTurn = (role, content, topic) => {
    const d = document.createElement('div'); d.className = 'turn ' + role;
    d.innerHTML = (topic && role === 'assistant' ? `<span class="topic-tag">${esc(topic)}</span>` : '') + esc(content);
    chat.appendChild(d); typeset(d); d.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };
  for (const t of session.transcript) addTurn(t.role, t.content, t.threadLabel);
  const last = [...session.transcript].reverse().find((t) => t.role === 'assistant');
  const setMode = (m) => {
    mode = m || 'essay';
    $('#answer').className = mode === 'essay' ? 'essay' : '';
    $('#answer').placeholder = mode === 'code' ? 'Write code here…' : mode === 'latex' ? 'Write LaTeX, e.g. \\( \\int_0^1 x^2\\,dx \\)…' : 'Write your answer…';
    $('#preview').style.display = mode === 'latex' ? 'block' : 'none';
    app.querySelectorAll('.tabm').forEach((b) => b.classList.toggle('active', b.dataset.m === mode));
  };
  if (last) { setMode(last.mode); $('#qtopic').textContent = last.threadLabel || ''; }
  app.querySelectorAll('.tabm').forEach((b) => b.onclick = () => setMode(b.dataset.m));
  $('#answer').oninput = () => { if (mode === 'latex') { $('#preview').textContent = $('#answer').value; typeset($('#preview')); } };

  const doSend = async () => {
    const content = $('#answer').value.trim();
    if (!content) return;
    addTurn('user', content, null);
    $('#answer').value = ''; $('#preview').textContent = ''; $('#send').disabled = true;
    try {
      const r = await api('/api/message', { method: 'POST', body: { content } });
      addTurn('assistant', r.reply, r.topic);
      asked = r.progress.asked;
      $('#qcount').textContent = r.done ? 'Grading your answers…' : `Question ${asked} of ${total}`;
      $('#qtopic').textContent = r.done ? '' : (r.topic || '');
      $('#prog').style.width = Math.min(100, (r.done ? total : asked - 1) / total * 100) + '%';
      if (!r.done) { setMode(r.mode); $('#send').disabled = false; }
      else { $('#answer').disabled = true; $('#send').style.display = 'none'; renderComplete(r.result, r.feedback, session.testRef); }
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#send').disabled = false; }
  };
  $('#send').onclick = doSend;
  $('#answer').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSend(); };
  $('#abandon').onclick = async () => {
    if (!confirm('Abandon this exam? Nothing will be saved.')) return;
    await api('/api/abandon', { method: 'POST' }).catch(() => {});
    TOKEN = null; renderUnlock();
  };
}

/* ---------------- completion → release ---------------- */
function renderComplete(result, feedback, testRef) {
  app.innerHTML = `
    ${topbar('Awaiting proctor')}
    <div class="card" style="text-align:center;padding:2rem 1.5rem 1.5rem">
      <span class="stamp ${result.outcome === 'pass' ? '' : 'alert'}">${result.outcome === 'pass' ? 'Passed' : 'Not yet'}</span>
      <h1 style="margin-top:1rem">${esc(testRef.title)}${testRef.tier === 'catalog' ? ' · ' + cap(testRef.level) : ''}</h1>
      <p class="muted">Score ${Math.round(result.score * 100)}%</p>
    </div>
    <div class="card">
      <p>${esc(feedback.summary)}</p>
      ${result.perTopic.map((t) => `<div class="topic-rating"><span>${esc(t.topic)}</span><span>${esc(t.rating)}</span></div>`).join('')}
      ${feedback.studyPlan ? '<h3 style="margin-top:1rem">Study plan</h3><ul class="plain">' + feedback.studyPlan.map((s) => `<li><strong>${esc(s.topic)}</strong> — ${esc(s.why)}</li>`).join('') + '</ul>' : ''}
      ${feedback.advice ? `<p class="small muted" style="margin-top:.6rem">${esc(feedback.advice)}</p>` : ''}
    </div>
    <div class="card" style="text-align:center">
      <h2>Proctor: release this result</h2>
      <p class="small muted">Confirm you observed this exam, then enter the proctor code to send the result to Vivacada.</p>
      <input type="password" id="pcode" placeholder="Proctor code" style="max-width:280px;margin:0 auto;text-align:center">
      <div style="margin-top:1rem"><button class="primary" id="release">Release result</button></div>
      <div id="err"></div>
    </div>`;
  const doRelease = async () => {
    const proctorCode = $('#pcode').value.trim();
    if (!proctorCode) return;
    $('#release').disabled = true;
    try {
      await api('/api/release', { method: 'POST', body: { proctorCode } });
      renderReleased();
    } catch (e) {
      const retry = e.retryable !== false;
      $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
      if (e.status === 403) { setTimeout(() => { TOKEN = null; renderUnlock(); }, 1500); }
      $('#release').disabled = !retry ? true : false;
    }
  };
  $('#release').onclick = doRelease;
  $('#pcode').onkeydown = (e) => { if (e.key === 'Enter') doRelease(); };
}

function renderReleased() {
  app.innerHTML = `
    ${topbar('Complete')}
    <div class="card" style="text-align:center;padding:3rem 1.5rem">
      <span class="stamp">Released</span>
      <h1 style="margin-top:1.2rem">Result sent to Vivacada</h1>
      <p class="muted">The patron can sign in at Vivacada with the email they gave to view their credential.</p>
      <div style="margin-top:1.5rem"><button class="primary" id="next">Start next patron</button></div>
    </div>`;
  $('#next').onclick = () => { TOKEN = null; renderUnlock(); };
}

renderUnlock();
