// Assistant: type a request (or tap a quick one), and the Worker's /api/agent answers it with the
// calendar, shopping and note tools (worker/agent.js). What really changed is listed under the
// answer from the tool results, not from the model's words. Changes the assistant may not make on
// its own (deleting an event) wait in "Needs your OK" until someone taps Approve or Cancel.
(function () {
  'use strict';
  var $ = App.$;
  var V = { el: null, busy: false, last: null, runs: [], approvals: [], rec: null };
  var REC_MAX_MS = 10e3;
  var QUICK = [
    { label: 'What’s on today?', prompt: 'What is on the calendar today?' },
    { label: 'This week', prompt: 'What is on the calendar this week?' },
    { label: 'Shopping list', prompt: 'What is on the shopping list?' },
    { label: 'Add groceries…', fill: 'Add ' },
    { label: 'Leave a note…', fill: 'Leave a note for everyone: ' },
  ];

  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : App.fmt.time(new Date(ms));
  }
  function meta(r) {
    var model = (r.model || '').split('/').pop().replace(/:free$/, '');
    return [r.provider === 'openrouter' ? 'OpenRouter' : r.provider === 'workers-ai' ? 'Workers AI' : 'No model', model, r.ms ? (r.ms / 1000).toFixed(1) + ' s' : '']
      .filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------ painting
  function paintAnswer() {
    var el = V.el.querySelector('.ag-answer'), r = V.last;
    if (V.rec) { el.innerHTML = '<div class="card ag-reply is-busy"><div class="label">Listening…</div><p class="serif ag-text">Speak now, then tap the mic to stop.</p></div>'; return; }
    if (V.busy) { el.innerHTML = '<div class="card ag-reply is-busy"><div class="label">Thinking…</div><p class="serif ag-text">' + App.esc(V.busy) + '</p></div>'; return; }
    if (!r) { el.innerHTML = '<div class="card ag-reply is-empty"><div class="label">Assistant</div><p class="serif ag-text">Ask about the calendar, the shopping list or notes.</p></div>'; return; }
    el.innerHTML = '<div class="card ag-reply' + (r.ok ? '' : ' is-error') + '">' +
      '<div class="label">' + App.esc(r.prompt) + '</div>' +
      '<p class="serif ag-text">' + App.esc(r.reply) + '</p>' +
      (r.actions && r.actions.length ? '<ul class="ag-done">' + r.actions.map(function (a) { return '<li>' + App.icon('check', 20) + App.esc(a) + '</li>'; }).join('') + '</ul>' : '') +
      (r.approvals && r.approvals.length ? '<div class="ag-waiting">' + App.icon('clock', 20) + r.approvals.length + ' waiting for your OK</div>' : '') +
      '<div class="ag-meta">' + App.esc(meta(r)) + '</div></div>';
  }
  function paintRuns() {
    var el = V.el.querySelector('.ag-runs');
    el.innerHTML = V.runs.length ? '<div class="label ag-runs-h">Recent</div>' + V.runs.map(function (r) {
      var tools = (r.tools || []).map(function (t) { return t.split(' ')[0]; });
      return '<div class="ag-run' + (r.error && !r.provider ? ' is-error' : '') + '">' +
        '<div class="ag-run-q">' + App.esc(r.prompt) + '<small>' + ago(r.at) + '</small></div>' +
        '<div class="ag-run-a">' + App.esc(r.reply || r.error || '') + '</div>' +
        '<div class="ag-meta">' + App.esc(meta(r)) + (tools.length ? ' · ' + App.esc(tools.join(', ')) : '') + '</div></div>';
    }).join('') : '';
  }
  function paintApprovals() {
    var el = V.el.querySelector('.ag-approvals');
    el.innerHTML = V.approvals.length ? '<div class="label">Needs your OK</div>' + V.approvals.map(function (a) {
      return '<div class="card ag-appr" data-appr="' + a.id + '"><b>' + App.esc(a.summary) + '</b><small>' + ago(a.at) + '</small>' +
        '<div class="ag-appr-btns"><button class="btn btn--ghost" data-decide="cancel">Cancel</button><button class="btn btn--solid" data-decide="approve">Approve</button></div></div>';
    }).join('') : '';
  }

  function render() {
    V.el.innerHTML = '<div class="agents">' +
      '<header class="ag-head"><div><div class="label">Ask in plain words</div><h1 class="serif">Assistant</h1></div></header>' +
      '<div class="ag-main"><div class="ag-answer"></div><div class="ag-runs"></div></div>' +
      '<aside class="ag-side">' +
      '  <form class="ag-ask"><label class="ag-input-wrap"><input class="ag-input" placeholder="e.g. Add milk" autocomplete="off" enterkeyhint="send" maxlength="500"></label>' +
      (canRecord() ? '  <button class="ag-mic" type="button" data-mic aria-label="Speak">' + App.icon('mic', 30) + '</button>' : '') +
      '  <button class="btn btn--solid ag-send" type="submit">Ask</button></form>' +
      '  <div class="ag-quick">' + QUICK.map(function (q, i) { return '<button class="chip" data-quick="' + i + '">' + App.esc(q.label) + '</button>'; }).join('') + '</div>' +
      '  <div class="ag-approvals"></div>' +
      '</aside></div>';
    paintAnswer(); paintRuns(); paintApprovals();
  }

  // ------------------------------------------------------------ data
  function loadSide() {
    return Promise.all([App.api('GET', '/approvals'), App.api('GET', '/agent/runs?limit=8')]).then(function (r) {
      V.approvals = r[0]; V.runs = r[1];
      if (V.el) { paintApprovals(); paintRuns(); }
    }).catch(function () { /* offline: keep what is shown */ });
  }

  // A typed prompt, or a recording (FormData) that the Worker turns into text first.
  function send(path, data, label) {
    V.busy = label; paintAnswer();
    // Waiting for an answer counts as use: don't let the idle timer leave this tab meanwhile.
    App.resetIdle();
    var awake = setInterval(App.resetIdle, 5000);
    var btn = V.el.querySelector('.ag-send'); btn.disabled = true;
    App.api('POST', path, data).then(function (r) {
      V.last = Object.assign({ prompt: r.transcript ? '“' + r.transcript + '”' : label }, r);
      if (r.actions && r.actions.length) { App.refresh('state'); App.refresh('calendar'); }
    }, function (err) {
      V.last = { prompt: label, ok: false, reply: 'Couldn’t reach the assistant · ' + err.message };
    }).then(function () {
      clearInterval(awake); App.resetIdle();
      V.busy = false; btn.disabled = false;
      var input = V.el.querySelector('.ag-input');
      if (V.last.ok && path === '/agent') input.value = '';
      paintAnswer(); loadSide();
    });
  }
  function ask(prompt) {
    prompt = prompt.trim();
    if (prompt && !V.busy && !V.rec) send('/agent', { prompt: prompt }, prompt);
  }

  // ------------------------------------------------------------ voice
  // Tap to start, tap again to stop (or it stops after 10 s). The mic is released as soon as the
  // recording ends, and nothing runs while idle.
  function canRecord() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
  function micButton() { return V.el && V.el.querySelector('.ag-mic'); }
  function startRec() {
    if (V.busy || V.rec) return;
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      var type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
      var rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 16000 } : { audioBitsPerSecond: 16000 });
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        clearTimeout(V.rec.timer);
        V.rec = null;
        var b = micButton(); if (b) b.classList.remove('is-rec');
        var blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
        chunks = null;
        if (blob.size < 1000) { paintAnswer(); return; } // a tap without speech
        var form = new FormData();
        form.append('audio', blob, 'voice.' + (/mp4/.test(blob.type) ? 'm4a' : 'webm'));
        send('/voice', form, 'Voice');
      };
      V.rec = { rec: rec, timer: setTimeout(function () { if (rec.state === 'recording') rec.stop(); }, REC_MAX_MS) };
      rec.start();
      App.resetIdle();
      var b = micButton(); if (b) b.classList.add('is-rec');
      paintAnswer();
    }, function (err) {
      App.toast(err && err.name === 'NotAllowedError' ? 'Microphone access is blocked' : 'No microphone found', { tone: 'error', icon: 'mic' });
    });
  }
  function stopRec() { if (V.rec && V.rec.rec.state === 'recording') V.rec.rec.stop(); }

  function decide(id, decision, btn) {
    btn.disabled = true;
    App.api('POST', '/approvals/' + id, { decision: decision }).then(function () {
      App.toast(decision === 'approve' ? 'Done' : 'Cancelled', { icon: decision === 'approve' ? 'check' : 'x', ms: 2000 });
      if (decision === 'approve') App.refresh('calendar');
    }, function (err) {
      App.toast('Couldn’t do that · ' + App.esc(err.message), { tone: 'error', icon: 'bolt' });
    }).then(loadSide);
  }

  function onClick(e) {
    var q = e.target.closest('[data-quick]'), d = e.target.closest('[data-decide]');
    if (e.target.closest('[data-mic]')) { if (V.rec) stopRec(); else startRec(); }
    else if (q) {
      var item = QUICK[+q.dataset.quick], input = V.el.querySelector('.ag-input');
      if (item.fill) { input.value = item.fill; input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      else ask(item.prompt);
    } else if (d) decide(d.closest('[data-appr]').dataset.appr, d.dataset.decide, d);
  }
  function onSubmit(e) {
    e.preventDefault();
    var input = V.el.querySelector('.ag-input');
    input.blur();
    ask(input.value);
  }

  App.register('agents', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); el.addEventListener('submit', onSubmit); }
      render();
      loadSide();
    },
    hide: stopRec
  });
})();
