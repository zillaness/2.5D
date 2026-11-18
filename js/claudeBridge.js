// Claude bridge: the 2.5D side of a review loop with Claude.
//
// Claude pre-traces an outline from a photo and publishes 2.5D with a
// `project.json` beside index.html: a normal project plus an optional
// `review` block marking the stretches it is unsure about. This module loads
// that project on start, draws the review marks on the trace canvas, lists
// them in a panel at the top of step 2, and hands the corrected trace back
// (the artifact's db store, or JSON on the clipboard).
//
// Everything here is inert unless a project is found: no project.json (404,
// file://, the offline build) leaves the app exactly as it was. All
// coordinates are mm, origin top-left of the rectified image, y down — the
// trace's own convention.
//
//   review: {
//     id, title,
//     spans:  [{ id, label, status: 'unsure'|'fixed'|'ok', note,
//                pts: [[x, y], ...], view: [x0, y0, x1, y1] }],
//     ghosts: [{ label, color, pts: [[x, y], ...], closed }],
//   }

const DRAFT_PREFIX = '2p5d-bridge-draft:';
const STORE_DOC = 'traces/current';
const STORE_MAX_BYTES = 256 * 1024; // the store's per-document cap
const STATUSES = ['unsure', 'fixed', 'ok'];
const STATUS_LABEL = { unsure: 'Unsure', fixed: 'Fixed', ok: 'OK as is' };
const UNSURE_COL = '#ffd257';
const DONE_COL = '#37d67a';
const GHOST_COL = '#ff6a1a';

const $ = id => document.getElementById(id);

// [x, y] or {x, y} -> {x, y} (mm), or null when it is not a finite point.
function toPt(p) {
  const x = Array.isArray(p) ? p[0] : p && p.x;
  const y = Array.isArray(p) ? p[1] : p && p.y;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

// A review block with the gaps filled in, so the rest can trust its shape.
// Unknown fields are kept (the block round-trips with the project).
function normalizeReview(r) {
  if (!r || typeof r !== 'object') return null;
  const list = a => (Array.isArray(a) ? a : []).filter(o => o && typeof o === 'object');
  return {
    ...r,
    spans: list(r.spans).map((s, i) => ({
      ...s,
      id: s.id != null ? String(s.id) : `s${i + 1}`,
      status: STATUSES.includes(s.status) ? s.status : 'unsure',
      pts: Array.isArray(s.pts) ? s.pts : [],
      userNote: typeof s.userNote === 'string' ? s.userNote : '',
    })),
    ghosts: list(r.ghosts).map(g => ({ ...g, pts: Array.isArray(g.pts) ? g.pts : [] })),
  };
}

const reviewId = review => (review && review.id != null ? review.id : null);

// Plain-JSON copy with numbers rounded to 0.1 µm: keeps a dense trace well
// inside the store's document cap and makes the clipboard text shorter.
const roundNum = (k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const plain = obj => JSON.parse(JSON.stringify(obj, roundNum));

// Fingerprint of the trace a project was handed over with, so a stored draft
// is only ever re-applied to the project it was made from.
function fingerprint(p) {
  const s = JSON.stringify([p.pxPerMm, p.trace, sectionLoops(p.regions)], roundNum) || '';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

// Drawn sections (regions[1..]) as { name, pts }: loops the user edits like the
// outline, e.g. a second face traced beside it. regions[0] is the base and
// always follows the outline, so it is never sent.
function sectionLoops(regions) {
  return (Array.isArray(regions) ? regions.slice(1) : [])
    .filter(r => r && Array.isArray(r.pts) && r.pts.length >= 3)
    .map(r => ({ name: String(r.name || ''), pts: r.pts }));
}

function isProject(p) {
  return !!p && typeof p === 'object' && (!p.app || p.app === '2.5D') &&
    !!p.trace && Array.isArray(p.trace.outer);
}

function pointCount(trace) {
  let n = trace && trace.outer ? trace.outer.length : 0;
  for (const h of (trace && trace.holes) || []) n += h.length;
  return n;
}

// Where the hand-off project lives: `?project=<url>` if given, else
// project.json beside the page. Same-origin http(s) only; an empty
// `?project=` switches the lookup off (the test-suite uses that).
function projectUrl() {
  try {
    if (!/^https?:$/.test(location.protocol)) return null; // file://: nothing to fetch
    const params = new URLSearchParams(location.search);
    if (params.has('project') && !params.get('project')) return null;
    const url = new URL(params.get('project') || 'project.json', document.baseURI);
    return url.origin === location.origin ? url.href : null;
  } catch { return null; }
}

// A stored draft with the saved trace + span statuses laid over the project.
function applyDraft(p, d) {
  const out = { ...p, trace: d.trace, arcs: d.arcs || [], lines: d.lines || [] };
  if (Array.isArray(d.sections) && Array.isArray(p.regions) && p.regions.length) {
    // Lay the edited section loops back over the project's sections, by name.
    const byName = new Map(d.sections.map(s => [s.name, s.pts]));
    out.regions = p.regions.map((r, i) =>
      (i > 0 && byName.has(String(r.name || '')) ? { ...r, pts: byName.get(String(r.name || '')) } : r));
  }
  if (Array.isArray(d.measurements)) out.measurements = d.measurements;
  if (Array.isArray(d.constraints)) out.constraints = d.constraints;
  const review = normalizeReview(p.review);
  if (review && Array.isArray(d.spans)) {
    const saved = new Map(d.spans.filter(Boolean).map(s => [String(s.id), s]));
    for (const s of review.spans) {
      const u = saved.get(s.id);
      if (!u) continue;
      if (STATUSES.includes(u.status)) s.status = u.status;
      if (typeof u.userNote === 'string') s.userNote = u.userNote;
    }
    out.review = review;
  }
  return out;
}

export function initClaudeBridge({ state, traceEditor, loadProject, toast }) {
  const el = {
    panel: $('bridgePanel'), progress: $('bridgeProgress'), title: $('bridgeTitle'),
    hint: $('bridgeHint'), spans: $('bridgeSpans'), showRow: $('bridgeShowRow'),
    showMarks: $('bridgeShowMarks'), showGhosts: $('bridgeShowGhosts'),
    send: $('bridgeSendBtn'), copy: $('bridgeCopyBtn'), reset: $('bridgeResetBtn'),
    sendNote: $('bridgeSendNote'), status: $('bridgeStatus'), copyText: $('bridgeCopyText'),
    lift: $('liftSlider'), liftVal: $('liftVal'), liftField: $('liftField'),
  };

  // ---------- lift shadows (always available in step 2) ----------
  // Brightens the photo layer only, so dark-on-dark edges can be judged
  // without washing out the outline.
  if (el.lift) {
    if (!('filter' in CanvasRenderingContext2D.prototype)) el.liftField.hidden = true;
    const applyLift = () => {
      const v = parseFloat(el.lift.value) || 1;
      el.liftVal.textContent = v > 1 ? `×${v.toFixed(1)}` : 'off';
      traceEditor.imageFilter = v > 1 ? `brightness(${v})` : '';
    };
    el.lift.addEventListener('input', () => { applyLift(); traceEditor.draw(); });
    applyLift();
  }

  const inert = { projectLoaded() {}, buildPayload: () => null };
  if (!el.panel) return inert;

  let source = null;     // how the current project arrived: 'fetch' | 'manual'
  let pending = null;    // set just before a load this module starts itself
  let baseText = null;   // the project as handed over (JSON), for Reset
  let baseHash = '';
  let dirty = false;     // edited since it was loaded
  let sent = false;      // ...and those edits already reached Claude
  let draftTimer = null;
  let db;                // undefined = not known yet, null = unavailable
  let dbPromise = null;
  let saving = false;
  let hooked = false;
  let resetArmed = null;

  const projectId = () => reviewId(state.review);
  const active = () => !!(state.review || source === 'fetch' || (source && db));

  // ---------- what goes back to Claude ----------

  function buildPayload() {
    const review = state.review;
    return plain({
      app: '2.5D', kind: 'trace-return',
      projectId: projectId(),
      sentAt: new Date().toISOString(),
      pxPerMm: state.rect ? state.rect.pxPerMm : null,
      trace: traceEditor.getTrace(),
      sections: sectionLoops(state.regions),
      arcs: traceEditor.arcs,
      lines: traceEditor.lines,
      measurements: traceEditor.measurements,
      constraints: traceEditor.constraints,
      spans: review
        ? review.spans.map(s => ({ id: s.id, status: s.status, userNote: s.userNote || '' }))
        : [],
    });
  }

  function setStatus(msg, cls = '') {
    el.status.textContent = msg || '';
    el.status.className = 'hint' + (cls ? ' ' + cls : '');
    el.status.hidden = !msg;
  }

  // ---------- draft safety (localStorage; may throw in an artifact) ----------

  const draftKey = id => DRAFT_PREFIX + id;

  function readDraft(id) {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
      return d && d.trace && Array.isArray(d.trace.outer) ? d : null;
    } catch { return null; }
  }

  function writeDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (!active() || !dirty) return;
    try {
      localStorage.setItem(draftKey(projectId()),
        JSON.stringify({ ...buildPayload(), base: baseHash, sent }));
    } catch { /* storage blocked or full — the draft is a convenience */ }
  }

  function clearDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    try { localStorage.removeItem(draftKey(projectId())); } catch { /* storage blocked */ }
  }

  // Called after every edit; the draft itself is written ~2 s after the last one.
  function touch() {
    if (!active()) return;
    if (sent) setStatus('Edited since it was sent — send again when you are done.');
    dirty = true;
    sent = false;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, 2000);
  }

  // ---------- review layer on the trace canvas ----------

  function strokePath(ctx, toScreen, pts, closed) {
    const sp = [];
    for (const p of pts) { const m = toPt(p); if (m) sp.push(toScreen(m)); }
    if (sp.length < 2) return sp;
    ctx.beginPath();
    ctx.moveTo(sp[0].x, sp[0].y);
    for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
    if (closed) ctx.closePath();
    return sp;
  }

  function pill(ctx, x, y, text, color) {
    ctx.font = 'bold 11px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10, h = 16;
    ctx.fillStyle = 'rgba(12, 16, 21, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  // Drawn over the photo and under the outline (TraceEditor.overlayHook), so
  // the marks never hide a vertex handle. They stay where Claude put them
  // while the outline is edited: they show where the doubt was.
  function drawReview(ctx, toScreen) {
    const review = state.review;
    if (!review) return;
    try {
      ctx.lineJoin = 'round';
      if (el.showGhosts.checked) {
        for (const g of review.ghosts) {
          ctx.strokeStyle = GHOST_COL;
          if (typeof g.color === 'string') ctx.strokeStyle = g.color; // ignored if invalid
          const col = ctx.strokeStyle;
          const sp = strokePath(ctx, toScreen, g.pts, !!g.closed);
          if (sp.length < 2) continue;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.stroke();
          const mid = sp[sp.length >> 1];
          if (g.label) pill(ctx, mid.x, mid.y - 12, String(g.label), col);
        }
      }
      if (el.showMarks.checked) {
        for (const s of review.spans) {
          const sp = strokePath(ctx, toScreen, s.pts, false);
          if (sp.length < 2) continue;
          const done = s.status !== 'unsure';
          if (done) {
            ctx.setLineDash([]);
            ctx.strokeStyle = DONE_COL;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            // A dashed band wider than the outline, dark-edged so it reads on
            // white paper too; the photo stays visible through the gaps.
            ctx.setLineDash([9, 6]);
            ctx.strokeStyle = 'rgba(12, 16, 21, 0.6)';
            ctx.lineWidth = 8;
            ctx.stroke();
            ctx.strokeStyle = UNSURE_COL;
            ctx.lineWidth = 5;
            ctx.stroke();
          }
          ctx.setLineDash([]);
          let top = sp[0];
          for (const p of sp) if (p.y < top.y) top = p;
          pill(ctx, top.x, top.y - 16, String(s.label || s.id), done ? DONE_COL : UNSURE_COL);
        }
      }
    } catch { /* a bad review block must never break the editor's draw */ }
  }

  // Zoom the trace view to a span's `view` box (mm), or to its points.
  function zoomTo(span) {
    let box = Array.isArray(span.view) && span.view.length === 4 &&
      span.view.every(Number.isFinite) ? span.view : null;
    if (!box) {
      const pts = span.pts.map(toPt).filter(Boolean);
      if (!pts.length) return;
      box = [
        Math.min(...pts.map(p => p.x)), Math.min(...pts.map(p => p.y)),
        Math.max(...pts.map(p => p.x)), Math.max(...pts.map(p => p.y)),
      ];
    }
    const k = traceEditor.pxPerMm;
    const x0 = Math.min(box[0], box[2]) * k, x1 = Math.max(box[0], box[2]) * k;
    const y0 = Math.min(box[1], box[3]) * k, y1 = Math.max(box[1], box[3]) * k;
    // A little margin: 12% of the box (at least 1 mm) on every side.
    const m = Math.max(k, 0.12 * Math.max(x1 - x0, y1 - y0));
    traceEditor.vp.fitBox(x0 - m, y0 - m, x1 + m, y1 + m);
    traceEditor.draw();
  }

  // ---------- the panel ----------

  function updateProgress() {
    const spans = state.review ? state.review.spans : [];
    const done = spans.filter(s => s.status !== 'unsure').length;
    el.progress.textContent = spans.length ? `${done}/${spans.length} checked` : '';
  }

  function spanRow(s) {
    const row = document.createElement('div');
    row.className = 'bridge-span';
    row.dataset.status = s.status;

    const head = document.createElement('div');
    head.className = 'bridge-span-head';
    const label = document.createElement('span');
    label.className = 'bridge-span-label';
    label.textContent = s.label || s.id;
    const go = document.createElement('button');
    go.className = 'btn small';
    go.textContent = 'Go';
    go.title = 'Zoom to this stretch of the outline';
    go.addEventListener('click', () => {
      for (const r of el.spans.children) r.classList.toggle('active', r === row);
      zoomTo(s);
    });
    head.append(label, go);
    row.append(head);

    if (s.note) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = s.note;
      row.append(note);
    }

    const ctl = document.createElement('div');
    ctl.className = 'bridge-span-ctl';
    const sel = document.createElement('select');
    sel.title = 'Unsure = still doubtful · Fixed = you corrected it · OK as is = Claude had it right';
    for (const st of STATUSES) sel.add(new Option(STATUS_LABEL[st], st));
    sel.value = s.status;
    sel.addEventListener('change', () => {
      s.status = sel.value;
      row.dataset.status = s.status;
      updateProgress();
      traceEditor.draw();
      touch();
    });
    const reply = document.createElement('input');
    reply.type = 'text';
    reply.maxLength = 300;
    reply.placeholder = 'Note to Claude (optional)';
    reply.value = s.userNote || '';
    reply.addEventListener('input', () => { s.userNote = reply.value; touch(); });
    ctl.append(sel, reply);
    row.append(ctl);
    return row;
  }

  function refreshSend() {
    el.send.disabled = saving || db === null;
    el.sendNote.hidden = db !== null;
  }

  // Rotating the view would move the trace out of the image frame Claude
  // works in, so the two rotate buttons are parked while a hand-off is open.
  function lockRotate(on) {
    for (const id of ['rotateLeftBtn', 'rotateRightBtn']) {
      const b = $(id);
      if (!b) continue;
      if (b.dataset.bridgeTitle == null) b.dataset.bridgeTitle = b.title;
      b.disabled = on;
      b.title = on ? 'Not available during a Claude review — the trace must stay in the frame Claude sent'
                   : b.dataset.bridgeTitle;
    }
  }

  function render() {
    const on = active();
    el.panel.hidden = !on;
    if (hooked) lockRotate(on);
    if (!on) return;
    const review = state.review;
    const spans = review ? review.spans : [];
    el.title.textContent = (review && review.title) || '';
    el.title.hidden = !el.title.textContent;
    el.hint.textContent = spans.length
      ? 'Claude traced this outline and marked the stretches it is unsure about. ' +
        'Check each one, fix the outline where needed, then send it back.'
      : source === 'fetch'
        ? 'Claude traced this outline. Correct it where needed, then send it back.'
        : 'Send this trace to Claude when it is ready.';
    el.spans.textContent = '';
    for (const s of spans) el.spans.append(spanRow(s));
    el.spans.hidden = !spans.length;
    const ghosts = review ? review.ghosts.length : 0;
    el.showRow.hidden = !spans.length && !ghosts;
    el.showMarks.parentElement.hidden = !spans.length;
    el.showGhosts.parentElement.hidden = !ghosts;
    el.reset.hidden = !baseText;
    updateProgress();
    refreshSend();
  }

  // ---------- hand-off: store + clipboard ----------

  // The artifact runtime's db namespace, or null (no runtime, not granted, or
  // no answer). `use` can take ~10 s to say no; never read window.claude.db.
  function probeDb() {
    if (dbPromise) return dbPromise;
    const c = window.claude;
    if (!c || typeof c.use !== 'function') {
      dbPromise = Promise.resolve(null);
    } else {
      dbPromise = Promise.race([
        Promise.resolve().then(() => c.use('db')),
        new Promise(res => setTimeout(() => res(null), 15000)),
      ]).then(d => d || null, () => null);
    }
    dbPromise.then(d => { db = d; render(); });
    return dbPromise;
  }

  async function send() {
    if (saving) return;
    saving = true;
    refreshSend();
    setStatus('Saving…');
    const payload = buildPayload();
    try {
      const store = await probeDb();
      if (!store) throw new Error('no store');
      await store.doc(STORE_DOC).set(payload);
      sent = true;
      if (dirty) { writeDraft(); }
      setStatus(`Saved ${pointCount(payload.trace)} points — tell Claude it's ready.`, 'info');
    } catch (err) {
      const tooBig = JSON.stringify(payload).length > STORE_MAX_BYTES;
      const code = err && typeof err.code === 'string' ? ` (${err.code})` : '';
      setStatus(tooBig
        ? 'Could not save — this trace is too large for the store. Use Copy for Claude.'
        : `Could not save${code} — use Copy for Claude instead.`, 'warn');
    }
    saving = false;
    refreshSend();
  }

  async function copy() {
    const payload = buildPayload();
    const text = JSON.stringify(payload);
    const okMsg = `Copied ${pointCount(payload.trace)} points — paste it into the chat with Claude.`;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    if (ok) {
      el.copyText.hidden = true;
      setStatus(okMsg, 'info');
      return;
    }
    // Clipboard blocked (embedded view): show the text, selected, to copy by hand.
    el.copyText.value = text;
    el.copyText.hidden = false;
    el.copyText.focus();
    el.copyText.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    setStatus(ok ? okMsg
      : 'Copy blocked — the text below is selected: press Ctrl+C, then paste it into the chat with Claude.',
      ok ? 'info' : 'warn');
  }

  function disarmReset() {
    clearTimeout(resetArmed);
    resetArmed = null;
    el.reset.textContent = "↺ Reset to Claude's trace";
  }

  function reset() {
    if (!baseText) return;
    // Two clicks instead of confirm(): modal dialogs can be blocked in an artifact.
    if (dirty && !resetArmed) {
      el.reset.textContent = 'Click again to discard your edits';
      resetArmed = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    clearDraft();
    openProject(baseText, { reset: true });
  }

  // ---------- loading ----------

  // Load a hand-off project from its JSON text. Returns false (and does
  // nothing) when the text is not a 2.5D project with a trace.
  function openProject(text, { restoreDraft = false, reset: isReset = false } = {}) {
    let p;
    try { p = JSON.parse(text); } catch { return false; }
    if (!isProject(p)) return false;
    const hash = fingerprint(p);
    let restored = null;
    if (restoreDraft) {
      const d = readDraft(reviewId(p.review));
      if (d && d.base === hash) { p = applyDraft(p, d); restored = d; }
    }
    pending = { text, hash, restored, reset: isReset, source: isReset ? source : 'fetch' };
    try { loadProject(p); } catch { pending = null; return false; }
    return true;
  }

  // First time a project arrives: hook the editor. Until then nothing is touched.
  function hook() {
    if (hooked) return;
    hooked = true;
    traceEditor.overlayHook = drawReview;
    for (const name of ['onChange', 'onAnnosChanged']) {
      const prev = traceEditor.cb[name];
      traceEditor.cb[name] = (...args) => { if (prev) prev(...args); touch(); };
    }
    // Don't lose the last couple of seconds of edits to a reload.
    const flush = () => { if (draftTimer) writeDraft(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    probeDb();
  }

  // main.js calls this at the end of every successful loadProject(p).
  function projectLoaded(p) {
    const mine = pending;
    pending = null;
    clearTimeout(draftTimer);
    draftTimer = null;
    disarmReset();
    state.review = normalizeReview(p && p.review);
    if (mine) {
      source = mine.source;
      baseText = mine.text;
      baseHash = mine.hash;
    } else {
      // A project pasted or opened by hand: keep it for Reset if it carries a review.
      source = 'manual';
      baseText = null;
      baseHash = '';
      if (state.review && isProject(p)) {
        try { baseText = JSON.stringify(p); baseHash = fingerprint(p); } catch { baseText = null; }
      }
    }
    dirty = !!(mine && mine.restored);
    sent = !!(mine && mine.restored && mine.restored.sent);
    el.copyText.hidden = true;
    setStatus('');
    if (state.review || source === 'fetch' || window.claude) hook();
    render();
    if (hooked) traceEditor.draw();
    if (mine && mine.restored) {
      toast(sent ? 'Your edits were restored (already sent to Claude).'
                 : 'Your unsent edits were restored from this browser.', 5000);
    } else if (mine && mine.reset) {
      toast("Reset to Claude's trace.");
    }
  }

  // ---------- wiring ----------

  el.send.addEventListener('click', send);
  el.copy.addEventListener('click', copy);
  el.reset.addEventListener('click', reset);
  el.showMarks.addEventListener('change', () => traceEditor.draw());
  el.showGhosts.addEventListener('change', () => traceEditor.draw());
  // Keep Delete/Backspace etc. in the copy box from hitting the canvas shortcuts.
  el.copyText.addEventListener('keydown', e => e.stopPropagation());

  // Fetch the hand-off project. Any failure — 404, network, file:// — is
  // silent and leaves the app as it is.
  (async () => {
    const url = projectUrl();
    if (!url) return;
    let text;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      text = await res.text();
    } catch { return; }
    if (state.image || state.rect) return; // the user already started on something
    openProject(text, { restoreDraft: true });
  })();

  return { projectLoaded, buildPayload };
}
