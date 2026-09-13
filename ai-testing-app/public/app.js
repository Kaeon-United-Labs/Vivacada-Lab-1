const app = document.getElementById('app');
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
function typeset(el) { if (window.MathJax?.typesetPromise) MathJax.typesetPromise([el]).catch(() => {}); }

let ATTEMPT_ID = localStorage.getItem('vivacada-ai-attempt') || null;
let SESSION_TOKEN = localStorage.getItem('vivacada-ai-token') || null;
let CONFIG = { mockMode: true, feeCents: 1000, questionsPerExam: 20, allowSpecialCatalog: true };

function persist() {
  if (ATTEMPT_ID && SESSION_TOKEN) { localStorage.setItem('vivacada-ai-attempt', ATTEMPT_ID); localStorage.setItem('vivacada-ai-token', SESSION_TOKEN); }
  else { localStorage.removeItem('vivacada-ai-attempt'); localStorage.removeItem('vivacada-ai-token'); }
}

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(SESSION_TOKEN ? { authorization: `Bearer ${SESSION_TOKEN}` } : {}) };
  const res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}
async function uploadClip(step, track, blob) {
  const buf = await blob.arrayBuffer();
  const res = await fetch(`/api/attempts/${ATTEMPT_ID}/clip?step=${step}&track=${track}`, { method: 'POST', headers: { authorization: `Bearer ${SESSION_TOKEN}` }, body: buf });
  if (!res.ok) throw new Error('Clip upload failed — check your connection and try this step again.');
}

function topbar(stage) {
  return `<div class="topbar"><div class="wordmark">Vivacada<span class="dot">.</span></div><div><span class="badge-tag">AI-Proctored</span> <span class="small muted mono" style="margin-left:.6rem">${esc(stage || '')}</span></div></div>`;
}
function feeDisplay() { return `$${(CONFIG.feeCents / 100).toFixed(2)}`; }

/* ==================== capture (webcam + screen, segmented per step) ==================== */
let webcamStream = null, screenStream = null;
let curWebcamRec = null, curScreenRec = null, curWebcamChunks = [], curScreenChunks = [];

async function startCapture() {
  webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
}
function startSegment() {
  curWebcamChunks = []; curScreenChunks = [];
  curWebcamRec = new MediaRecorder(webcamStream, { mimeType: 'video/webm' });
  curScreenRec = new MediaRecorder(screenStream, { mimeType: 'video/webm' });
  curWebcamRec.ondataavailable = (e) => { if (e.data.size) curWebcamChunks.push(e.data); };
  curScreenRec.ondataavailable = (e) => { if (e.data.size) curScreenChunks.push(e.data); };
  curWebcamRec.start(); curScreenRec.start();
}
function stopOne(rec, chunks) { return new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); rec.stop(); }); }
// Ends the current segment, uploads it as `step`, and immediately starts the
// next segment (unless `noRestart`) — the submit button and every
// Next/Retry click is a segment boundary; a Retry re-uploads the same step,
// which the server treats as superseding and immediately deletes the prior one.
async function cutSegment(step, noRestart) {
  const [webcamBlob, screenBlob] = await Promise.all([stopOne(curWebcamRec, curWebcamChunks), stopOne(curScreenRec, curScreenChunks)]);
  await Promise.all([uploadClip(step, 'webcam', webcamBlob), uploadClip(step, 'screen', screenBlob)]);
  if (!noRestart) startSegment();
}
function stopCaptureEntirely() {
  webcamStream?.getTracks().forEach((t) => t.stop());
  screenStream?.getTracks().forEach((t) => t.stop());
  webcamStream = screenStream = null;
}

/* ==================== terms ==================== */
async function renderTerms() {
  app.innerHTML = `${topbar('terms')}<div class="card"><p class="muted">Loading…</p></div>`;
  let terms;
  try { terms = await (await fetch('/legal/terms.txt')).text(); } catch (_) { terms = 'Terms could not be loaded.'; }
  app.innerHTML = `${topbar('terms')}
    <h1>AI-proctored exam — ${feeDisplay()} per attempt</h1>
    <p class="muted">Adults only. Read the terms below before continuing.</p>
    <div class="card">
      <div class="terms-body">${esc(terms)}</div>
      <label class="small" style="display:flex;gap:.5rem;align-items:flex-start;margin-top:1rem"><input type="checkbox" id="agree" style="width:auto;margin-top:.2rem"><span>I have read and agree to the terms above, including that the AI may flag me incorrectly, that a rejected attempt is not refunded, and that a valid ID and face match are required.</span></label>
      <div style="margin-top:1rem"><button class="primary" id="go" disabled>Agree &amp; Pay ${feeDisplay()}</button></div>
      <div id="err"></div>
    </div>`;
  $('#agree').onchange = (e) => { $('#go').disabled = !e.target.checked; };
  $('#go').onclick = async () => {
    $('#go').disabled = true;
    try {
      const r = await api('/attempts', { method: 'POST', body: { agreedToTerms: true } });
      ATTEMPT_ID = r.attemptId; SESSION_TOKEN = r.sessionToken; persist();
      renderPay();
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#go').disabled = false; }
  };
}

/* ==================== payment ==================== */
async function renderPay() {
  app.innerHTML = `${topbar('payment')}<div class="card"><h1>Pay ${feeDisplay()}</h1><p class="muted">Redirecting to payment…</p><div id="err"></div></div>`;
  try {
    const r = await api(`/attempts/${ATTEMPT_ID}/pay`, { method: 'POST', body: { returnBaseUrl: location.origin + location.pathname } });
    if (r.mock) {
      // Demo mode: no real provider round-trip. Confirm immediately.
      await api(`/attempts/${ATTEMPT_ID}/pay/confirm`, { method: 'POST' });
      renderSelect();
    } else if (r.redirectUrl) {
      location.href = r.redirectUrl; // browser leaves the site; returns via the return_url with #/return
    } else {
      throw new Error('Payment could not be started.');
    }
  } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}
async function handleReturn() {
  app.innerHTML = `${topbar('payment')}<div class="card"><p class="muted">Confirming payment…</p><div id="err"></div></div>`;
  try {
    const r = await api(`/attempts/${ATTEMPT_ID}/pay/confirm`, { method: 'POST' });
    if (r.paid) { location.hash = ''; renderSelect(); }
    else throw new Error('Payment was not completed. You can try again.');
  } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div><div style="margin-top:.8rem"><button class="secondary" id="retry">Try payment again</button></div>`; $('#retry').onclick = renderPay; }
}

/* ==================== selection (mirrors the kiosk's catalog/special tabs) ==================== */
const normalizeSubjectName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
async function renderSelect() {
  app.innerHTML = `${topbar('select a test')}<div class="card"><p class="muted">Loading catalog…</p></div>`;
  const cat = await api('/catalog').catch(() => ({ main: [], special: [], levels: [] }));
  app.innerHTML = `${topbar('select a test')}
    <h1>What are you testing on?</h1>
    <label>Email</label><input type="email" id="email" placeholder="you@example.com">
    <p class="small muted">Your Vivacada account (existing or one you create afterward with this same email) will receive the credential.</p>
    <div class="tabs">
      <button data-m="catalog" class="active">Catalog</button>
      ${CONFIG.allowSpecialCatalog ? '<button data-m="special">Other tests</button>' : ''}
    </div>
    <div class="card" id="panel"></div>
    <div id="err"></div>`;
  const panel = $('#panel');
  const renderCatalog = () => {
    panel.innerHTML = `
      <label>Subject</label>
      <select id="subject">${(cat.main || []).map((s) => `<option value="${esc(s.subject)}">${esc(s.subject)}</option>`).join('') || '<option disabled selected>No subjects available</option>'}</select>
      <label>Level</label>
      <select id="level">${(cat.levels || []).map((l) => `<option value="${esc(l)}">${esc(cap(l))}</option>`).join('')}</select>
      <div style="margin-top:1.2rem"><button class="primary" id="begin">Continue</button></div>`;
    $('#begin').onclick = () => begin({ mode: 'catalog', subject: $('#subject').value, level: $('#level').value });
  };
  const renderSpecial = () => {
    panel.innerHTML = `
      <p class="muted small">Type a test name to search; pick one from the suggestions. No level applies to these.</p>
      <label>Test name</label>
      <div style="position:relative"><input type="text" id="special-input" autocomplete="off"><div id="special-suggestions" class="suggestions" style="display:none"></div></div>
      <div style="margin-top:1.2rem"><button class="primary" id="begin" disabled>Continue</button></div>`;
    const input = $('#special-input'), sugg = $('#special-suggestions'), beginBtn = $('#begin');
    const list = cat.special || [];
    let resolved = null;
    const show = () => {
      const q = normalizeSubjectName(input.value);
      resolved = null; beginBtn.disabled = true;
      if (!q) { sugg.style.display = 'none'; return; }
      const matches = list.filter((s) => normalizeSubjectName(s.subject).includes(q));
      const exact = list.find((s) => normalizeSubjectName(s.subject) === q);
      if (exact) { resolved = exact; beginBtn.disabled = false; }
      sugg.innerHTML = matches.map((s) => `<div class="suggestion" data-pick="${esc(s.subject)}">${esc(s.subject)}</div>`).join('');
      sugg.style.display = matches.length ? 'block' : 'none';
      sugg.querySelectorAll('[data-pick]').forEach((el) => el.onclick = () => { input.value = el.dataset.pick; resolved = list.find((s) => normalizeSubjectName(s.subject) === normalizeSubjectName(el.dataset.pick)); beginBtn.disabled = !resolved; sugg.style.display = 'none'; });
    };
    input.oninput = show;
    input.onblur = () => setTimeout(() => { sugg.style.display = 'none'; }, 150);
    beginBtn.onclick = () => { if (resolved) begin({ mode: 'special', subject: resolved.subject }); };
  };
  const begin = async (rest) => {
    const email = $('#email').value.trim();
    if (!email) { $('#err').innerHTML = `<div class="error-box">Enter an email.</div>`; return; }
    $('#begin').disabled = true;
    try {
      const body = { email, ...rest };
      if (CONFIG.mockMode && location.hash.includes('mockReject')) body.mockOverride = { forceReject: true };
      const r = await api(`/attempts/${ATTEMPT_ID}/select`, { method: 'POST', body });
      renderRecordingIntro(r.attempt);
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#begin').disabled = false; }
  };
  app.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => { app.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('active', x === b)); b.dataset.m === 'catalog' ? renderCatalog() : renderSpecial(); });
  renderCatalog();
}

/* ==================== recording steps ==================== */
function renderRecordingIntro(attempt) {
  app.innerHTML = `${topbar('recording setup')}
    <h1>Before you begin</h1>
    <p>You'll be recorded (webcam and screen) for the rest of this attempt. You'll show your face, show a photo ID, perform a short series of gestures, and pan your camera around the room — then take the exam. Recording stops the moment you submit.</p>
    <div style="margin-top:1rem"><button class="primary" id="start-cap">Start recording</button></div>
    <div id="err"></div>`;
  $('#start-cap').onclick = async () => {
    $('#start-cap').disabled = true;
    try { await startCapture(); startSegment(); renderStepFace(attempt); }
    catch (e) { $('#err').innerHTML = `<div class="error-box">Camera/screen access is required: ${esc(e.message)}</div>`; $('#start-cap').disabled = false; }
  };
}
function recFrame() {
  return `<div class="rec-frame"><video id="preview" autoplay muted playsinline></video><div class="rec-indicator"><span class="rec-dot"></span>REC</div></div>`;
}
function wirePreview() { const v = $('#preview'); if (v && webcamStream) v.srcObject = webcamStream; }

function renderStepFace(attempt) {
  app.innerHTML = `${topbar('step 1 of 4 — face')}<h1>Show your face</h1><p class="muted">Look directly at the camera.</p><div class="card">${recFrame()}<button class="primary" id="next">Next</button><div id="err"></div></div>`;
  wirePreview();
  $('#next').onclick = async () => { $('#next').disabled = true; try { await cutSegment('face'); renderStepId(attempt); } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#next').disabled = false; } };
}
function renderStepId(attempt) {
  app.innerHTML = `${topbar('step 2 of 4 — id')}<h1>Show a photo ID</h1><p class="muted">Hold a government-issued ID up to the camera, clearly legible.</p><div class="card">${recFrame()}<button class="primary" id="next">Next</button><div id="err"></div></div>`;
  wirePreview();
  $('#next').onclick = async () => { $('#next').disabled = true; try { await cutSegment('id'); renderStepGestures(attempt); } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#next').disabled = false; } };
}
async function renderStepGestures(attempt) {
  app.innerHTML = `${topbar('step 3 of 4 — gestures')}<h1>Follow these gestures</h1><p class="muted">Loading your gesture list…</p>`;
  const { gestureList } = await api(`/attempts/${ATTEMPT_ID}/gestures`, { method: 'POST' });
  app.innerHTML = `${topbar('step 3 of 4 — gestures')}
    <h1>Follow these gestures</h1>
    <ul class="small">${gestureList.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
    <div class="card">${recFrame()}
      <button class="secondary" id="retry">Retry</button>
      <button class="primary" id="next">Next</button>
      <div id="err"></div>
    </div>`;
  wirePreview();
  $('#retry').onclick = async () => { $('#retry').disabled = true; $('#next').disabled = true; try { await cutSegment('gestures'); } catch (_) {} $('#retry').disabled = false; $('#next').disabled = false; }; // re-uploading supersedes the prior take
  $('#next').onclick = async () => { $('#next').disabled = true; try { await cutSegment('gestures'); renderStepSweep(attempt); } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#next').disabled = false; } };
}
function renderStepSweep(attempt) {
  app.innerHTML = `${topbar('step 4 of 4 — room sweep')}<h1>Slowly pan the camera around your room</h1><p class="muted">Show the space around you, then begin the exam.</p><div class="card">${recFrame()}<button class="primary" id="next">Begin Exam</button><div id="err"></div></div>`;
  wirePreview();
  $('#next').onclick = async () => { $('#next').disabled = true; try { await cutSegment('sweep'); renderInterview(attempt); } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#next').disabled = false; } };
}

/* ==================== exam (same shape as the kiosk) ==================== */
function renderInterview(attempt) {
  const total = attempt.progress.total;
  let asked = attempt.progress.asked, mode = 'essay';
  app.innerHTML = `${topbar('exam in progress')}
    <h1>${esc(attempt.testRef.title)}${attempt.testRef.tier === 'catalog' ? ' · ' + cap(attempt.testRef.level) : ''}</h1>
    <div class="spread"><span class="mono small" id="qcount">Question ${asked} of ${total}</span><span class="small muted" id="qtopic"></span></div>
    <div class="progress-track"><div class="progress-fill" id="prog" style="width:${(asked - 1) / total * 100}%"></div></div>
    <div class="chat" id="chat"></div>
    <div class="card">
      <div class="tabs"><button class="tabm active" data-m="essay">Essay</button><button class="tabm" data-m="code">Code</button><button class="tabm" data-m="latex">LaTeX</button></div>
      <textarea id="answer" placeholder="Write your answer…"></textarea>
      <div id="preview" class="small" style="display:none;margin-top:.4rem"></div>
      <div class="spread" style="margin-top:.8rem"><span></span><button class="primary" id="send">Send answer</button></div>
      <div id="err"></div>
    </div>`;
  const chat = $('#chat');
  const addTurn = (role, content, topic) => { const d = document.createElement('div'); d.className = 'turn ' + role; d.innerHTML = (topic && role === 'assistant' ? `<span class="topic-tag">${esc(topic)}</span>` : '') + esc(content); chat.appendChild(d); typeset(d); d.scrollIntoView({ behavior: 'smooth', block: 'end' }); };
  for (const t of attempt.transcript) addTurn(t.role, t.content, t.threadLabel);
  const last = [...attempt.transcript].reverse().find((t) => t.role === 'assistant');
  const setMode = (m) => { mode = m || 'essay'; $('#answer').placeholder = mode === 'code' ? 'Write code here…' : mode === 'latex' ? 'Write LaTeX…' : 'Write your answer…'; $('#preview').style.display = mode === 'latex' ? 'block' : 'none'; app.querySelectorAll('.tabm').forEach((b) => b.classList.toggle('active', b.dataset.m === mode)); };
  if (last) { setMode(last.mode); $('#qtopic').textContent = last.threadLabel || ''; }
  app.querySelectorAll('.tabm').forEach((b) => b.onclick = () => setMode(b.dataset.m));
  $('#answer').oninput = () => { if (mode === 'latex') { $('#preview').textContent = $('#answer').value; typeset($('#preview')); } };

  const doSubmitFinal = async (result, feedback) => {
    $('#send').style.display = 'none';
    const g = document.createElement('div'); g.className = 'turn assistant'; g.innerHTML = '<em>Stopping recording and submitting…</em>'; chat.appendChild(g);
    try {
      await cutSegment('exam', true); // final segment, no restart — recording ends here
      stopCaptureEntirely();
      const sub = await api(`/attempts/${ATTEMPT_ID}/submit`, { method: 'POST' });
      renderResults(sub, attempt.testRef);
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
  };
  $('#send').onclick = async () => {
    const content = $('#answer').value.trim();
    if (!content) return;
    addTurn('user', content, null);
    $('#answer').value = ''; $('#preview').textContent = ''; $('#send').disabled = true;
    try {
      const r = await api(`/attempts/${ATTEMPT_ID}/message`, { method: 'POST', body: { content } });
      addTurn('assistant', r.reply, r.topic);
      asked = r.progress.asked;
      $('#qcount').textContent = r.done ? `All ${total} questions complete` : `Question ${asked} of ${total}`;
      $('#prog').style.width = Math.min(100, (r.done ? total : asked - 1) / total * 100) + '%';
      if (!r.done) { setMode(r.mode); $('#send').disabled = false; $('#qtopic').textContent = r.topic || ''; }
      else { $('#answer').disabled = true; await doSubmitFinal(r.result, r.feedback); }
    } catch (e) { $('#err').innerHTML = `<div class="error-box">${esc(e.message)}</div>`; $('#send').disabled = false; }
  };
  $('#answer').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#send').click(); };
}

/* ==================== results ==================== */
function renderResults(sub, testRef) {
  if (sub.outcome === 'fail') {
    app.innerHTML = `${topbar('result')}
      <div class="card" style="text-align:center;padding:2rem 1.5rem">
        <span class="pill fail">Not yet</span>
        <h1 style="margin-top:1rem">${esc(testRef.title)}</h1>
        <p class="muted">Score ${Math.round(sub.result.score * 100)}%</p>
        <p>${esc(sub.feedback.summary)}</p>
        <p class="small muted">All footage has been discarded. You're welcome to try again for another ${feeDisplay()}.</p>
        <div style="margin-top:1rem"><button class="primary" id="retry">Try again</button></div>
      </div>`;
    $('#retry').onclick = () => { ATTEMPT_ID = null; SESSION_TOKEN = null; persist(); renderTerms(); };
    return;
  }
  app.innerHTML = `${topbar('result')}
    <div class="card" style="text-align:center;padding:2rem 1.5rem">
      <span class="pill pass">Passed</span>
      <h1 style="margin-top:1rem">${esc(testRef.title)}</h1>
      <p class="muted">Score ${Math.round(sub.result.score * 100)}%</p>
      <p>${esc(sub.feedback.summary)}</p>
      <p class="small muted" style="margin-top:1rem">Your exam passed. It still has to clear automated proctoring review before it's sent to Vivacada — that happens without you doing anything else. Check back on this link any time.</p>
      <div style="margin-top:1rem"><button class="primary" id="check">Check proctor status</button></div>
    </div>`;
  $('#check').onclick = renderStatus;
}

/* ==================== proctor status ==================== */
async function renderStatus() {
  app.innerHTML = `${topbar('proctor status')}<div class="card" style="text-align:center;padding:2rem 1.5rem"><p class="muted">Checking…</p></div>`;
  try {
    const r = await api(`/attempts/${ATTEMPT_ID}/proctor-status`);
    const copy = {
      checking: ['Still reviewing', 'Automated review is in progress. This can take a few minutes — check back any time.'],
      approved: ['Approved', 'Your result has been sent to Vivacada. Sign in there with the email you used here to see your credential.'],
      rejected: ['Not approved', 'This attempt did not pass automated review. Nothing was sent to Vivacada. You can try again for another ' + feeDisplay() + '.'],
      not_submitted: ['Not submitted', 'This attempt was never queued for review.']
    }[r.status] || ['Unknown', ''];
    app.innerHTML = `${topbar('proctor status')}
      <div class="card" style="text-align:center;padding:2rem 1.5rem">
        <span class="pill ${r.status === 'approved' ? 'pass' : r.status === 'rejected' ? 'fail' : ''}">${esc(copy[0])}</span>
        <p style="margin-top:1rem">${esc(copy[1])}</p>
        ${r.status === 'checking' ? '<div style="margin-top:1rem"><button class="secondary" id="refresh">Refresh</button></div>' : ''}
        ${r.status === 'rejected' ? '<div style="margin-top:1rem"><button class="primary" id="retry">Try again</button></div>' : ''}
      </div>`;
    if ($('#refresh')) $('#refresh').onclick = renderStatus;
    if ($('#retry')) $('#retry').onclick = () => { ATTEMPT_ID = null; SESSION_TOKEN = null; persist(); renderTerms(); };
  } catch (e) {
    app.innerHTML = `${topbar('proctor status')}<div class="card"><div class="error-box">${esc(e.message)}</div></div>`;
  }
}

/* ==================== boot ==================== */
(async () => {
  try { CONFIG = await (await fetch('/api/config')).json(); } catch (_) {}
  const params = new URLSearchParams(location.hash.replace(/^#\/return\?/, ''));
  if (location.hash.startsWith('#/return') && ATTEMPT_ID && SESSION_TOKEN) { handleReturn(); return; }
  if (ATTEMPT_ID && SESSION_TOKEN) {
    try { const { attempt } = await api(`/attempts/${ATTEMPT_ID}`); if (attempt.stage && attempt.stage !== 'terms_agreed') { renderSelect(); return; } } catch (_) { ATTEMPT_ID = null; SESSION_TOKEN = null; persist(); }
  }
  renderTerms();
})();
