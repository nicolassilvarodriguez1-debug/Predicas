/* ════════════════════════════════════════════════════════════════════
   🎙️ GRABAR — "Plaud" de Iglesia Freedom
   1. Graba desde cualquier micrófono (incluido un micrófono 360 de sala).
   2. Transcribe en vivo con ElevenLabs Scribe v2 Realtime y deja marcar
      quién habla.
   3. Al terminar, Scribe v2 (por lotes) separa las voces con precisión.
   4. Se nombra cada voz (con muestra de audio) y Claude genera el resumen,
      la enseñanza, los versículos, el mapa mental o las tareas.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Configuración ─────────────────────────────────────────────────
  const LANG = 'es';
  const KEYTERMS = [
    'Yeshúa', 'Yeshua HaMashiaj', 'Mashiaj', 'Adonai', 'Elohim', 'YHWH', 'HaShem',
    'Torá', 'Tanaj', 'Brit Hadashá', 'Brit Jadashá', 'parashá', 'parashot', 'haftará',
    'Shabat', 'Shabbat Shalom', 'shalom', 'kehilá', 'Ruaj HaKodesh', 'emuná', 'teshuvá',
    'tzedaká', 'mitzvot', 'mitzvá', 'Halleluyah', 'Amén', 'rabí', 'Moshé', 'Avraham',
    'Yitzjak', 'Yaakov', 'Yerushalayim', 'Pésaj', 'Shavuot', 'Sukot', 'Yom Kipur',
    'Rosh Hashaná', 'Janucá', 'Purim', 'menorá', 'talit', 'shofar', 'bet midrash',
    'Iglesia Freedom', 'mesiánico', 'mesiánica', 'Kodesh', 'lashon hará', 'akedá'
  ];
  // El modo en vivo acepta hasta 50 términos de máx. 20 caracteres.
  const LIVE_KEYTERMS = KEYTERMS.filter(k => k.length <= 20).slice(0, 50);
  const STORE_KEY = 'freedom_grabaciones_v1';
  const PEOPLE_KEY = 'freedom_participantes_v1';
  const MARKMAP_SCRIPTS = [
    'https://cdn.jsdelivr.net/npm/d3@7',
    'https://cdn.jsdelivr.net/npm/markmap-view@0.18.13/dist/browser/index.js',
    'https://cdn.jsdelivr.net/npm/markmap-lib@0.18.13/dist/browser/index.iife.js'
  ];
  const SPEAKER_COLORS = ['#C9A84C', '#1A4A8B', '#1A6B3C', '#5B2D8E', '#C0392B', '#2C7A7B', '#8B6E2A', '#B83280'];

  // ── Estado ────────────────────────────────────────────────────────
  const S = {
    mode: 'predica',
    devices: [],
    deviceId: localStorage.getItem('freedom_mic') || '',
    browserDsp: false,
    participants: loadJSON(PEOPLE_KEY, ['Pastor']),
    liveSpeaker: null,

    // grabación
    stream: null, recorder: null, chunks: [], audioCtx: null, worklet: null,
    ws: null, wsWanted: false, pending: [], startedAt: 0, timer: null, wakeLock: null,
    partial: '', partialStart: null, liveLines: [],

    // previsualización del medidor (sin grabar)
    previewStream: null, previewCtx: null,

    // resultado
    rec: null // { id, mode, title, date, duration, audioUrl, audioBlob, segments, speakers, names, teacher, result, liveLines }
  };

  // ── Utilidades ────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function loadJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; }
  }
  function mmss(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }
  function toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg); }
  function today() { return new Date().toISOString().split('T')[0]; }
  function b64FromBuffer(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function setStatus(html, kind) {
    const el = $('gr-status');
    if (!el) return;
    el.className = 'gr-status' + (kind ? ' gr-status-' + kind : '');
    el.innerHTML = html;
    el.style.display = html ? 'flex' : 'none';
  }

  // ── Almacén local seguro (IndexedDB) ──────────────────────────────
  // Guarda el audio por pedazos MIENTRAS se graba y los datos de la sesión,
  // para poder recuperar todo si la pestaña se cierra o el navegador se cuelga.
  const DB = (function () {
    let opening = null;
    function open() {
      if (!window.indexedDB) return Promise.reject(new Error('Este navegador no tiene IndexedDB'));
      if (!opening) {
        opening = new Promise((res, rej) => {
          const r = indexedDB.open('freedom_grabar', 1);
          r.onupgradeneeded = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => { opening = null; rej(r.error); };
        });
      }
      return opening;
    }
    function tx(store, mode, fn) {
      return open().then(db => new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      }));
    }
    const range = id => IDBKeyRange.bound([id, 0], [id, Infinity]);
    return {
      putSession: sess => tx('sessions', 'readwrite', st => st.put(sess)),
      getSession: id => tx('sessions', 'readonly', st => st.get(id)),
      allSessions: () => tx('sessions', 'readonly', st => st.getAll()),
      putChunk: (recId, seq, blob) => tx('chunks', 'readwrite', st => st.put({ recId, seq, blob })),
      getAudio: (id, mime) => tx('chunks', 'readonly', st => st.getAll(range(id))).then(rows => {
        if (!rows || !rows.length) return null;
        rows.sort((a, b) => a.seq - b.seq);
        return new Blob(rows.map(r => r.blob), { type: mime || rows[0].blob.type || 'audio/webm' });
      }),
      remove: id => Promise.all([
        tx('sessions', 'readwrite', st => st.delete(id)),
        tx('chunks', 'readwrite', st => st.delete(range(id)))
      ])
    };
  })();
  function safe(p) { return Promise.resolve(p).catch(err => { console.warn('[Grabar] almacenamiento local:', err); return null; }); }
  function persistSession(changes) {
    if (!S.session) return Promise.resolve();
    Object.assign(S.session, changes || {});
    return safe(DB.putSession(Object.assign({}, S.session, { liveLines: (S.session.liveLines || []).slice() })));
  }
  function extOf(mime) { return (mime || '').includes('mp4') ? 'm4a' : (mime || '').includes('ogg') ? 'ogg' : 'webm'; }

  // Llama a las funciones de /api con la clave opcional de la app.
  async function apiPost(url, body, retried) {
    const headers = { 'Content-Type': 'application/json' };
    const pass = localStorage.getItem('freedom_passcode');
    if (pass) headers['x-app-passcode'] = pass;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    if (r.status === 401 && !retried) {
      const p = prompt('Escribe la clave de acceso de la app:');
      if (p) { localStorage.setItem('freedom_passcode', p); return apiPost(url, body, true); }
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }
  async function getToken(type) {
    const { token } = await apiPost('/api/scribe-token', { type });
    return token;
  }

  // ── Micrófonos ────────────────────────────────────────────────────
  function audioConstraints() {
    const c = {
      echoCancellation: S.browserDsp,
      noiseSuppression: S.browserDsp,
      autoGainControl: S.browserDsp
    };
    if (S.deviceId) c.deviceId = { exact: S.deviceId };
    return { audio: c };
  }

  async function refreshDevices(askPermission) {
    const sel = $('gr-mic');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      sel.innerHTML = '<option>Este navegador no permite grabar</option>';
      return;
    }
    try {
      if (askPermission) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      S.devices = all.filter(d => d.kind === 'audioinput');
      const hasLabels = S.devices.some(d => d.label);
      if (!hasLabels) {
        sel.innerHTML = '<option value="">Micrófono predeterminado</option>';
        $('gr-mic-permit').style.display = 'inline-block';
      } else {
        $('gr-mic-permit').style.display = 'none';
        if (S.deviceId && !S.devices.some(d => d.deviceId === S.deviceId)) S.deviceId = '';
        sel.innerHTML = S.devices.map((d, i) =>
          `<option value="${esc(d.deviceId)}" ${d.deviceId === S.deviceId ? 'selected' : ''}>${esc(d.label || 'Micrófono ' + (i + 1))}</option>`
        ).join('');
        if (!S.deviceId && S.devices[0]) S.deviceId = S.devices[0].deviceId;
        startPreview();
      }
    } catch (err) {
      sel.innerHTML = '<option value="">Permiso de micrófono denegado</option>';
      setStatus('⚠️ El navegador no dio permiso para el micrófono. Revisa el ícono del candado en la barra de direcciones.', 'error');
    }
  }

  // Medidor de nivel antes de grabar, para confirmar que es el micrófono correcto.
  async function startPreview() {
    stopPreview();
    if (S.stream) return; // ya grabando
    try {
      S.previewStream = await navigator.mediaDevices.getUserMedia(audioConstraints());
      S.previewCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = S.previewCtx.createMediaStreamSource(S.previewStream);
      const an = S.previewCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const data = new Float32Array(an.fftSize);
      const loop = () => {
        if (!S.previewCtx) return;
        an.getFloatTimeDomainData(data);
        let sq = 0; for (let i = 0; i < data.length; i++) sq += data[i] * data[i];
        setLevel(Math.sqrt(sq / data.length));
        requestAnimationFrame(loop);
      };
      loop();
    } catch (_) { /* se mostrará al grabar */ }
  }
  function stopPreview() {
    if (S.previewStream) S.previewStream.getTracks().forEach(t => t.stop());
    if (S.previewCtx) S.previewCtx.close().catch(() => {});
    S.previewStream = null; S.previewCtx = null;
    setLevel(0);
  }
  function setLevel(rms) {
    const el = $('gr-level-bar');
    if (!el) return;
    const pct = Math.min(100, Math.round(Math.sqrt(rms) * 160));
    el.style.width = pct + '%';
    el.style.background = pct > 90 ? 'var(--red)' : pct > 8 ? 'var(--green)' : 'var(--stone-light)';
  }

  // ── Participantes y "¿quién habla ahora?" ─────────────────────────
  function renderPeople() {
    const box = $('gr-people');
    box.innerHTML = S.participants.map((p, i) =>
      `<span class="gr-chip ${S.liveSpeaker === p ? 'on' : ''}" style="--c:${SPEAKER_COLORS[i % SPEAKER_COLORS.length]}" onclick="Grabar.tapSpeaker(${i})">
         <span class="gr-dot"></span>${esc(p)}
         <span class="gr-chip-x" onclick="event.stopPropagation();Grabar.removePerson(${i})" title="Quitar">×</span>
       </span>`
    ).join('') || '<span class="gr-muted">Agrega a quienes van a hablar</span>';
    const dl = $('gr-people-list');
    if (dl) dl.innerHTML = S.participants.map(p => `<option value="${esc(p)}">`).join('');
    const hint = $('gr-live-hint');
    if (hint) hint.textContent = S.liveSpeaker ? `Marcando lo que se diga como: ${S.liveSpeaker}` : 'Toca un nombre para marcar quién habla ahora (opcional).';
  }
  function addPerson() {
    const inp = $('gr-person-input');
    const name = inp.value.trim();
    if (!name) return;
    if (!S.participants.includes(name)) S.participants.push(name);
    saveJSON(PEOPLE_KEY, S.participants);
    inp.value = '';
    renderPeople();
  }
  function removePerson(i) {
    const p = S.participants[i];
    S.participants.splice(i, 1);
    if (S.liveSpeaker === p) S.liveSpeaker = null;
    saveJSON(PEOPLE_KEY, S.participants);
    renderPeople();
  }
  function tapSpeaker(i) {
    const p = S.participants[i];
    S.liveSpeaker = S.liveSpeaker === p ? null : p;
    renderPeople();
  }

  // ── Transcripción en vivo ─────────────────────────────────────────
  function elapsed() { return S.startedAt ? (Date.now() - S.startedAt) / 1000 : 0; }

  function renderLive() {
    const box = $('gr-live');
    const lines = S.liveLines.map((l, idx) => {
      const ci = l.speaker ? S.participants.indexOf(l.speaker) : -1;
      const color = ci >= 0 ? SPEAKER_COLORS[ci % SPEAKER_COLORS.length] : 'var(--stone-light)';
      return `<div class="gr-line">
        <span class="gr-time">${mmss(l.t)}</span>
        <span class="gr-who" style="--c:${color}" onclick="Grabar.cycleLineSpeaker(${idx})" title="Cambiar quién habla">${esc(l.speaker || '¿?')}</span>
        <span class="gr-text">${esc(l.text)}</span>
      </div>`;
    }).join('');
    const partial = S.partial ? `<div class="gr-line gr-partial"><span class="gr-time">${mmss(elapsed())}</span><span class="gr-who" style="--c:var(--stone-light)">${esc(S.liveSpeaker || '…')}</span><span class="gr-text">${esc(S.partial)}</span></div>` : '';
    box.innerHTML = lines + partial || '<div class="gr-muted" style="padding:16px;">La transcripción aparecerá aquí mientras hablan.</div>';
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (atBottom || S.recorder) box.scrollTop = box.scrollHeight;
  }
  function cycleLineSpeaker(idx) {
    const l = S.liveLines[idx];
    if (!l) return;
    const opts = [null].concat(S.participants);
    const cur = opts.indexOf(l.speaker || null);
    l.speaker = opts[(cur + 1) % opts.length];
    renderLive();
  }

  async function openRealtime() {
    if (!S.wsWanted) return;
    let token;
    try {
      token = await getToken('realtime');
    } catch (err) {
      setLiveBadge('error', 'Sin transcripción en vivo: ' + err.message + ' (se sigue grabando)');
      return;
    }
    const q = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      token,
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      language_code: LANG
    });
    LIVE_KEYTERMS.forEach(k => q.append('keyterms', k));
    const ws = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + q.toString());
    S.ws = ws;
    setLiveBadge('connecting', 'Conectando…');

    ws.onopen = () => {
      setLiveBadge('on', 'En vivo');
      const queued = S.pending.splice(0);
      queued.forEach(sendChunk);
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      const type = m.message_type || m.type || '';
      if (type === 'partial_transcript') {
        if (m.text && S.partialStart == null) S.partialStart = Math.max(0, elapsed() - 1);
        S.partial = m.text || '';
        renderLive();
      } else if (type === 'committed_transcript') {
        const text = (m.text || '').trim();
        if (text) {
          S.liveLines.push({ t: S.partialStart != null ? S.partialStart : Math.max(0, elapsed() - 2), text, speaker: S.liveSpeaker });
        }
        S.partial = ''; S.partialStart = null;
        renderLive();
      } else if (/error/i.test(type) || m.error) {
        setLiveBadge('error', 'En vivo: ' + (m.message || m.error || type));
      }
    };
    ws.onclose = () => {
      if (S.ws === ws) S.ws = null;
      if (S.wsWanted) {
        setLiveBadge('connecting', 'Reconectando…');
        setTimeout(openRealtime, 1500);
      } else {
        setLiveBadge('off', '');
      }
    };
    ws.onerror = () => { /* onclose se encarga */ };
  }
  function sendChunk(buf) {
    const ws = S.ws;
    if (!ws || ws.readyState !== 1) {
      if (S.wsWanted) { S.pending.push(buf); if (S.pending.length > 40) S.pending.shift(); }
      return;
    }
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64FromBuffer(buf), commit: false, sample_rate: 16000 }));
  }
  function setLiveBadge(kind, text) {
    const el = $('gr-live-badge');
    if (!el) return;
    el.className = 'gr-badge gr-badge-' + kind;
    el.textContent = text;
    el.style.display = text ? 'inline-block' : 'none';
  }

  // ── Grabar / detener ──────────────────────────────────────────────
  function pickMime() {
    const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const m of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  async function start() {
    if (S.recorder) return;
    if (!window.MediaRecorder) { setStatus('⚠️ Este navegador no puede grabar audio. Usa Chrome o Edge.', 'error'); return; }
    stopPreview();
    resetResult();
    S.liveLines = []; S.partial = ''; S.partialStart = null; S.pending = [];
    renderLive();

    try {
      S.stream = await navigator.mediaDevices.getUserMedia(audioConstraints());
    } catch (err) {
      setStatus('⚠️ No se pudo abrir el micrófono: ' + esc(err.message), 'error');
      S.stream = null;
      return;
    }

    // 1) Grabación completa (para separar voces al final y para descargar)
    const mime = pickMime();
    S.chunks = [];
    S.recorder = new MediaRecorder(S.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    const recId = Date.now();
    S.session = {
      id: recId, status: 'recording', source: 'mic', mode: S.mode,
      title: $('gr-title').value.trim(), date: $('gr-date').value || today(),
      mime: S.recorder.mimeType || mime || 'audio/webm', startedAt: recId, duration: 0,
      liveLines: S.liveLines
    };
    persistSession();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    let seq = 0;
    S.recorder.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      S.chunks.push(e.data);
      safe(DB.putChunk(recId, seq++, e.data));
    };
    S.recorder.start(1000);

    // 2) Audio en vivo a 16 kHz → ElevenLabs Realtime
    try {
      S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await S.audioCtx.audioWorklet.addModule('/pcm-worklet.js');
      const src = S.audioCtx.createMediaStreamSource(S.stream);
      S.worklet = new AudioWorkletNode(S.audioCtx, 'pcm16k');
      S.worklet.port.onmessage = e => {
        if (e.data.type === 'pcm') sendChunk(e.data.buf);
        else if (e.data.type === 'level') setLevel(e.data.rms);
      };
      const mute = S.audioCtx.createGain();
      mute.gain.value = 0;
      src.connect(S.worklet).connect(mute).connect(S.audioCtx.destination);
      S.wsWanted = true;
      openRealtime();
    } catch (err) {
      setLiveBadge('error', 'Sin transcripción en vivo en este navegador (se sigue grabando)');
    }

    S.startedAt = Date.now();
    let ticks = 0;
    S.timer = setInterval(() => {
      $('gr-timer').textContent = mmss(elapsed());
      if (++ticks % 10 === 0) persistSession({ duration: elapsed(), title: $('gr-title').value.trim() }); // cada 5 s
    }, 500);
    try { if (navigator.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}

    $('gr-rec-btn').style.display = 'none';
    $('gr-stop-btn').style.display = 'inline-flex';
    $('gr-mic').disabled = true;
    $('gr-upload-btn').disabled = true;
    $('gr-rec-dot').classList.add('on');
    setStatus('');
  }

  async function stop() {
    if (!S.recorder) return;
    const duration = elapsed();
    const mime = S.recorder.mimeType || 'audio/webm';

    // Cerrar la transcripción en vivo: pedir el último texto pendiente.
    S.wsWanted = false;
    if (S.ws && S.ws.readyState === 1) {
      try { S.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 })); } catch (_) {}
      const ws = S.ws;
      setTimeout(() => { try { ws.close(); } catch (_) {} }, 2500);
    }

    const blob = await new Promise(resolve => {
      S.recorder.onstop = () => resolve(new Blob(S.chunks, { type: mime }));
      S.recorder.stop();
    });
    S.recorder = null;
    S.stream.getTracks().forEach(t => t.stop());
    S.stream = null;
    if (S.audioCtx) S.audioCtx.close().catch(() => {});
    S.audioCtx = null; S.worklet = null;
    clearInterval(S.timer);
    if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }

    $('gr-rec-btn').style.display = 'inline-flex';
    $('gr-stop-btn').style.display = 'none';
    $('gr-mic').disabled = false;
    $('gr-upload-btn').disabled = false;
    $('gr-rec-dot').classList.remove('on');
    setLevel(0);

    setTimeout(() => {
      if (S.partial) { S.liveLines.push({ t: S.partialStart || duration, text: S.partial, speaker: S.liveSpeaker }); S.partial = ''; renderLive(); }
    }, 2600);

    const file = new File([blob], `grabacion-${today()}.${extOf(mime)}`, { type: mime });
    const recId = S.session ? S.session.id : Date.now();
    await persistSession({ status: 'stopped', duration, title: $('gr-title').value.trim() });
    setTimeout(() => persistSession(), 3000); // incluir las últimas líneas en vivo
    processAudio(file, duration, recId);
  }

  function onUpload(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    resetResult();
    S.liveLines = [];
    renderLive();
    if (!$('gr-title').value) $('gr-title').value = f.name.replace(/\.[^.]+$/, '');
    const recId = Date.now();
    S.session = {
      id: recId, status: 'stopped', source: 'upload', mode: S.mode, title: $('gr-title').value.trim(),
      date: $('gr-date').value || today(), mime: f.type || 'audio/mpeg', fileName: f.name,
      startedAt: recId, duration: 0, liveLines: S.liveLines
    };
    persistSession();
    safe(DB.putChunk(recId, 0, f));
    processAudio(f, null, recId);
  }

  // ── Separar voces (Scribe v2 por lotes) ───────────────────────────
  async function transcribeBatch(file) {
    const build = () => {
      const fd = new FormData();
      fd.append('model_id', 'scribe_v2');
      fd.append('file', file);
      fd.append('diarize', 'true');
      fd.append('language_code', LANG);
      fd.append('timestamps_granularity', 'word');
      fd.append('tag_audio_events', 'false');
      KEYTERMS.forEach(k => fd.append('keyterms', k));
      return fd;
    };
    // Intento 1: token en la URL. Intento 2: token como campo del formulario.
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken('batch');
      const fd = build();
      let url = 'https://api.elevenlabs.io/v1/speech-to-text';
      if (attempt === 0) url += '?token=' + encodeURIComponent(token);
      else fd.append('token', token);
      const r = await fetch(url, { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      lastErr = (data.detail && (data.detail.message || JSON.stringify(data.detail))) || `Error ${r.status}`;
      if (![400, 401, 403, 422].includes(r.status)) break;
    }
    throw new Error(lastErr);
  }

  // Agrupa palabras en intervenciones por voz.
  function buildSegments(data) {
    const words = (data.words || (data.transcripts && data.transcripts[0] && data.transcripts[0].words) || [])
      .filter(w => w.type !== 'audio_event');
    const segs = [];
    let cur = null;
    for (const w of words) {
      const spk = w.speaker_id || 'speaker_0';
      if (w.type === 'spacing') { if (cur) cur.text += w.text; continue; }
      const gap = cur ? w.start - cur.end : 0;
      const long = cur && (cur.end - cur.start > 75) && /[.?!]\s*$/.test(cur.text);
      if (!cur || cur.speakerId !== spk || gap > 2.5 || long) {
        if (cur) segs.push(cur);
        cur = { speakerId: spk, start: w.start, end: w.end, text: w.text };
      } else {
        cur.text += w.text;
        cur.end = w.end;
      }
    }
    if (cur) segs.push(cur);
    segs.forEach(s => { s.text = s.text.replace(/\s+/g, ' ').trim(); });
    return segs.filter(s => s.text);
  }

  function speakerStats(segs) {
    const map = {};
    segs.forEach(s => {
      const m = map[s.speakerId] || (map[s.speakerId] = { id: s.speakerId, secs: 0, turns: 0, samples: [] });
      m.secs += Math.max(0.5, s.end - s.start);
      m.turns++;
      if (s.text.split(' ').length >= 6) m.samples.push(s);
    });
    const total = Object.values(map).reduce((a, b) => a + b.secs, 0) || 1;
    return Object.values(map)
      .map(m => {
        m.pct = Math.round(m.secs / total * 100);
        m.samples = m.samples.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 2);
        if (!m.samples.length) m.samples = segs.filter(s => s.speakerId === m.id).slice(0, 1);
        return m;
      })
      .sort((a, b) => b.secs - a.secs);
  }

  // Usa las marcas hechas en vivo para sugerir el nombre de cada voz.
  function suggestNames(segs, stats, liveLines, mode) {
    const votes = {};
    liveLines.filter(l => l.speaker).forEach(l => {
      const hit = segs.find(s => l.t >= s.start - 3 && l.t <= s.end + 1);
      if (!hit) return;
      const v = votes[hit.speakerId] || (votes[hit.speakerId] = {});
      v[l.speaker] = (v[l.speaker] || 0) + 1;
    });
    const names = {};
    const used = new Set();
    stats.forEach(st => {
      const v = votes[st.id];
      if (!v) return;
      const best = Object.entries(v).sort((a, b) => b[1] - a[1]).find(([n]) => !used.has(n));
      if (best) { names[st.id] = best[0]; used.add(best[0]); }
    });
    if (mode === 'predica' && stats[0] && !names[stats[0].id]) {
      const pastor = S.participants.find(p => /pastor|rab/i.test(p)) || 'Pastor';
      if (!used.has(pastor)) names[stats[0].id] = pastor;
    }
    stats.forEach((st, i) => { if (!names[st.id]) names[st.id] = `Voz ${i + 1}`; });
    return names;
  }

  async function processAudio(file, duration, recId) {
    const audioUrl = URL.createObjectURL(file);
    S.rec = {
      id: recId || Date.now(),
      mode: S.mode,
      title: $('gr-title').value.trim() || (S.mode === 'predica' ? 'Prédica' : 'Reunión') + ' ' + today(),
      date: $('gr-date').value || today(),
      duration,
      audioUrl,
      audioBlob: file,
      liveLines: S.liveLines, // misma lista: incluye lo que llegue justo después de detener
      segments: [], speakers: [], names: {}, teacher: '', result: null
    };
    $('gr-audio').src = audioUrl;
    $('gr-download-audio').style.display = 'inline-flex';
    $('gr-step-voices').style.display = 'block';
    $('gr-voices').innerHTML = '';
    setStatus('<span class="gr-spin"></span> Separando las voces de toda la grabación con ElevenLabs… (en una prédica larga puede tardar unos minutos)', 'work');

    try {
      const data = await transcribeBatch(file);
      const segs = buildSegments(data);
      if (!segs.length) throw new Error('No se detectó voz en la grabación');
      const stats = speakerStats(segs);
      S.rec.segments = segs;
      S.rec.speakers = stats;
      S.rec.names = suggestNames(segs, stats, S.rec.liveLines, S.rec.mode);
      S.rec.duration = S.rec.duration || segs[segs.length - 1].end;
      renderVoices();
      renderTranscript();
      const saved = saveRecording(true);
      if (saved && S.session && S.session.id === S.rec.id) persistSession({ status: 'processed' });
      else if (saved) safe(DB.getSession(S.rec.id).then(x => x && DB.putSession(Object.assign(x, { status: 'processed' }))));
      setStatus(`✓ Se detectaron ${stats.length} ${stats.length === 1 ? 'voz' : 'voces'} y la transcripción ya quedó guardada. Ponle nombre a cada una y genera el resumen.`, 'ok');
    } catch (err) {
      setStatus('⚠️ No se pudo separar las voces: ' + esc(err.message) +
        '. El audio está a salvo en este navegador. <button class="btn btn-outline btn-sm" onclick="Grabar.retry()">Reintentar</button>', 'error');
    }
  }

  function retry() {
    const rec = S.rec;
    if (!rec || !rec.audioBlob) return;
    processAudio(rec.audioBlob, rec.duration, rec.id);
  }

  // Guarda cambios de nombres sin que el usuario tenga que tocar nada.
  let autosaveTimer = null;
  function autosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { if (S.rec && S.rec.segments.length) saveRecording(true); }, 600);
  }

  // ── Nombrar voces ─────────────────────────────────────────────────
  function renderVoices() {
    const rec = S.rec;
    const box = $('gr-voices');
    box.innerHTML = rec.speakers.map((st, i) => `
      <div class="gr-voice" style="--c:${SPEAKER_COLORS[i % SPEAKER_COLORS.length]}">
        <div class="gr-voice-head">
          <span class="gr-dot"></span>
          <input class="field-input gr-voice-name" list="gr-people-list" value="${esc(rec.names[st.id])}"
                 onchange="Grabar.renameVoice('${st.id}', this.value)" placeholder="Nombre">
          <span class="gr-muted">${st.pct}% del tiempo · ${st.turns} intervención${st.turns === 1 ? '' : 'es'}</span>
        </div>
        ${st.samples.map(s => `
          <div class="gr-sample">
            <button class="btn btn-outline btn-sm" onclick="Grabar.play(${s.start})" title="Escuchar">▶ ${mmss(s.start)}</button>
            <span>“${esc(s.text.length > 160 ? s.text.slice(0, 160) + '…' : s.text)}”</span>
          </div>`).join('')}
      </div>`).join('');

    const teacherRow = $('gr-teacher-row');
    if (rec.mode === 'predica') {
      teacherRow.style.display = 'flex';
      const sel = $('gr-teacher');
      const ids = rec.speakers.map(s => s.id);
      const current = rec.teacher && ids.includes(rec.teacher) ? rec.teacher : ids[0];
      rec.teacher = current;
      sel.innerHTML = rec.speakers.map(s => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(rec.names[s.id])}</option>`).join('');
    } else {
      teacherRow.style.display = 'none';
    }
    $('gr-summarize-btn').disabled = false;
  }
  function renameVoice(id, name) {
    name = (name || '').trim();
    if (!name || !S.rec) return;
    S.rec.names[id] = name;
    if (!/^Voz \d+$/.test(name) && !S.participants.includes(name)) {
      S.participants.push(name);
      saveJSON(PEOPLE_KEY, S.participants);
      renderPeople();
    }
    renderVoices();
    renderTranscript();
    autosave();
  }
  function setTeacher(id) { if (S.rec) { S.rec.teacher = id; autosave(); } }

  let stopAt = null;
  function play(t) {
    const a = $('gr-audio');
    if (!a.src) return;
    a.currentTime = Math.max(0, t - 0.3);
    stopAt = t + 9;
    a.play().catch(() => {});
  }
  function onAudioTime() {
    const a = $('gr-audio');
    if (stopAt != null && a.currentTime >= stopAt) { a.pause(); stopAt = null; }
  }

  // ── Transcripción final con nombres ───────────────────────────────
  function namedSegments(rec) {
    return rec.segments.map(s => ({ start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, speaker: rec.names[s.speakerId] || s.speakerId, text: s.text }));
  }
  function renderTranscript() {
    const rec = S.rec;
    if (!rec) return;
    const colorOf = id => SPEAKER_COLORS[Math.max(0, rec.speakers.findIndex(s => s.id === id)) % SPEAKER_COLORS.length];
    const segs = rec.segments || [];
    $('gr-tab-transcript').innerHTML = segs.length ? segs.map(s => `
      <div class="gr-line">
        <span class="gr-time gr-link" onclick="Grabar.play(${s.start})">${mmss(s.start)}</span>
        <span class="gr-who" style="--c:${colorOf(s.speakerId)}">${esc(rec.names[s.speakerId] || s.speakerId)}</span>
        <span class="gr-text">${esc(s.text)}</span>
      </div>`).join('') : '<div class="gr-muted">Sin transcripción.</div>';
  }

  // ── Resumen con Claude ────────────────────────────────────────────
  async function summarize() {
    const rec = S.rec;
    if (!rec || !rec.segments.length) return;
    rec.title = $('gr-title').value.trim() || rec.title;
    rec.date = $('gr-date').value || rec.date;
    const btn = $('gr-summarize-btn');
    btn.disabled = true;
    setStatus('<span class="gr-spin"></span> Claude está preparando el resumen' + (rec.mode === 'predica' ? ', la enseñanza y el mapa mental…' : ', las decisiones y las tareas…'), 'work');
    try {
      const { result } = await apiPost('/api/summarize', {
        mode: rec.mode,
        teacher: rec.mode === 'predica' ? rec.names[rec.teacher] : '',
        title: rec.title,
        date: rec.date,
        segments: namedSegments(rec).map(({ start, speaker, text }) => ({ start, speaker, text }))
      });
      rec.result = result;
      saveRecording(true);
      if (result.titulo && !$('gr-title').value.trim()) { rec.title = result.titulo; $('gr-title').value = result.titulo; }
      setStatus('✓ Resumen listo y guardado. Puedes agregarlo a Prédicas, copiarlo o descargarlo.', 'ok');
      renderResult();
    } catch (err) {
      setStatus('⚠️ No se pudo generar el resumen: ' + esc(err.message), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function list(arr, fn) { return (arr && arr.length) ? '<ul class="gr-list">' + arr.map(x => '<li>' + fn(x) + '</li>').join('') + '</ul>' : ''; }
  function block(title, inner) { return inner ? `<div class="gr-block"><div class="gr-block-title">${title}</div>${inner}</div>` : ''; }

  function renderResult() {
    const rec = S.rec;
    const r = rec && rec.result;
    $('gr-step-result').style.display = r || (rec && rec.segments.length) ? 'block' : 'none';
    $('gr-save-sermon').style.display = rec && rec.mode === 'predica' && r ? 'inline-flex' : 'none';
    if (!r) { $('gr-tab-summary').innerHTML = '<div class="gr-muted">Genera el resumen para verlo aquí.</div>'; $('gr-tab-map').innerHTML = ''; return; }

    let html = `<div class="gr-result-title">${esc(r.titulo || rec.title)}</div>`;
    if (rec.mode === 'predica') {
      html += `<div class="gr-muted" style="margin-bottom:12px;">${esc(rec.date)} · Enseñanza de ${esc(rec.names[rec.teacher] || '')}${r.categoria ? ' · ' + esc(r.categoria) : ''}</div>`;
      if (r.ensenanza_central) html += `<div class="gr-central">${esc(r.ensenanza_central)}</div>`;
      html += block('Resumen', (r.resumen || '').split(/\n+/).map(p => `<p>${esc(p)}</p>`).join(''));
      html += block('Puntos principales', list(r.puntos_principales, p => `<strong>${esc(p.titulo)}</strong>${p.minuto ? ` <span class="gr-time">${esc(p.minuto)}</span>` : ''}<br>${esc(p.explicacion)}`));
      html += block('Versículos', list(r.versiculos, v => `<strong>${esc(v.referencia)}</strong> — ${esc(v.como_se_uso)}`));
      html += block('Términos hebreos', list(r.terminos_hebreos, t => `<strong>${esc(t.termino)}</strong>: ${esc(t.significado)}`));
      html += block('Aplicaciones', list(r.aplicaciones, a => esc(a)));
      html += block('Frases destacadas', list(r.frases_destacadas, f => `“${esc(f.texto)}”${f.minuto ? ` <span class="gr-time">${esc(f.minuto)}</span>` : ''}`));
      html += block('Preguntas para reflexionar', list(r.preguntas_reflexion, q => esc(q)));
    } else {
      html += `<div class="gr-muted" style="margin-bottom:12px;">${esc(rec.date)} · Participantes: ${esc(Object.values(rec.names).join(', '))}</div>`;
      html += block('Resumen', (r.resumen || '').split(/\n+/).map(p => `<p>${esc(p)}</p>`).join(''));
      html += block('Decisiones', list(r.decisiones, d => esc(d)));
      html += block('Tareas', (r.tareas && r.tareas.length) ? `<table class="gr-table"><tr><th>Tarea</th><th>Responsable</th><th>Fecha</th></tr>${r.tareas.map(t => `<tr><td>${esc(t.tarea)}</td><td>${esc(t.responsable)}</td><td>${esc(t.fecha)}</td></tr>`).join('')}</table>` : '');
      html += block('Temas', list(r.temas, t => `<strong>${esc(t.tema)}</strong>${t.minuto ? ` <span class="gr-time">${esc(t.minuto)}</span>` : ''}<br>${esc(t.resumen)}`));
      html += block('Pendientes', list(r.pendientes, p => esc(p)));
      html += block('Participación', list(r.participacion, p => `<strong>${esc(p.nombre)}</strong>: ${esc(p.aportes)}`));
      html += block('Frases destacadas', list(r.frases_destacadas, f => `“${esc(f.texto)}” — ${esc(f.quien || '')}${f.minuto ? ` <span class="gr-time">${esc(f.minuto)}</span>` : ''}`));
    }
    if (r.tags && r.tags.length) html += `<div class="tag-list" style="margin-top:12px;">${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
    $('gr-tab-summary').innerHTML = html;
    renderMindmap(r.mapa_mental || `# ${r.titulo || rec.title}`);
  }

  // ── Mapa mental (Markmap, con lista como respaldo) ────────────────
  let markmapLoading = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('No cargó ' + src));
      document.head.appendChild(s);
    });
  }
  function loadMarkmap() {
    if (window.markmap && window.markmap.Markmap && window.markmap.Transformer) return Promise.resolve();
    if (!markmapLoading) {
      markmapLoading = MARKMAP_SCRIPTS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
        .catch(e => { markmapLoading = null; throw e; });
    }
    return markmapLoading;
  }
  function outlineHtml(md) {
    // Respaldo: árbol con sangrías a partir del markdown.
    return '<div class="gr-outline">' + md.split('\n').filter(l => l.trim()).map(l => {
      const h = l.match(/^(#+)\s*(.*)$/);
      const b = l.match(/^(\s*)[-*]\s+(.*)$/);
      if (h) return `<div class="gr-ol gr-ol-h${h[1].length}">${esc(h[2])}</div>`;
      if (b) return `<div class="gr-ol gr-ol-leaf" style="margin-left:${24 + b[1].length * 8}px">• ${esc(b[2])}</div>`;
      return `<div class="gr-ol">${esc(l)}</div>`;
    }).join('') + '</div>';
  }
  async function renderMindmap(md) {
    const box = $('gr-tab-map');
    box.innerHTML = '<svg id="gr-mm-svg" class="gr-mm"></svg>';
    try {
      await loadMarkmap();
      const { Transformer, Markmap } = window.markmap;
      const { root } = new Transformer().transform(md);
      // Si la pestaña está oculta, se dibuja al mostrarla.
      S._mm = { root, Markmap, drawn: false };
      if (box.offsetParent) drawMindmap();
    } catch (_) {
      box.innerHTML = outlineHtml(md);
    }
  }
  function drawMindmap() {
    const box = $('gr-tab-map');
    if (!S._mm || S._mm.drawn || !box.offsetParent) return;
    const svg = $('gr-mm-svg');
    svg.innerHTML = '';
    S._mm.inst = S._mm.Markmap.create(svg, { duration: 300, maxWidth: 260 }, S._mm.root);
    S._mm.drawn = true;
  }
  function downloadMindmapSvg() {
    const svg = $('gr-mm-svg');
    if (!svg || !S._mm || !S._mm.drawn) { toast('Abre la pestaña del mapa mental primero'); return; }
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const bb = svg.getBBox();
    clone.setAttribute('viewBox', `${bb.x - 20} ${bb.y - 20} ${bb.width + 40} ${bb.height + 40}`);
    clone.setAttribute('width', bb.width + 40);
    clone.setAttribute('height', bb.height + 40);
    clone.querySelector('g') && clone.querySelector('g').removeAttribute('transform');
    downloadBlob(new Blob([clone.outerHTML], { type: 'image/svg+xml' }), slug(S.rec.title) + '-mapa-mental.svg');
  }

  function showTab(name) {
    document.querySelectorAll('.gr-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    ['summary', 'map', 'transcript'].forEach(n => { $('gr-tab-' + n).style.display = n === name ? 'block' : 'none'; });
    if (name === 'map') drawMindmap();
  }

  // ── Exportar / guardar ────────────────────────────────────────────
  function slug(s) { return String(s || 'grabacion').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'grabacion'; }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function toMarkdown(rec) {
    const r = rec.result || {};
    const L = [];
    const items = (arr, fn) => (arr || []).forEach(x => L.push('- ' + fn(x)));
    L.push(`# ${r.titulo || rec.title}`, '', `**Fecha:** ${rec.date}  `);
    if (rec.mode === 'predica') {
      L.push(`**Enseñanza de:** ${rec.names[rec.teacher] || ''}  `, r.categoria ? `**Categoría:** ${r.categoria}` : '', '');
      if (r.ensenanza_central) L.push(`> ${r.ensenanza_central}`, '');
      if (r.resumen) L.push('## Resumen', '', r.resumen, '');
      if (r.puntos_principales && r.puntos_principales.length) { L.push('## Puntos principales', ''); items(r.puntos_principales, p => `**${p.titulo}**${p.minuto ? ` (${p.minuto})` : ''}: ${p.explicacion}`); L.push(''); }
      if (r.versiculos && r.versiculos.length) { L.push('## Versículos', ''); items(r.versiculos, v => `**${v.referencia}**: ${v.como_se_uso}`); L.push(''); }
      if (r.terminos_hebreos && r.terminos_hebreos.length) { L.push('## Términos hebreos', ''); items(r.terminos_hebreos, t => `**${t.termino}**: ${t.significado}`); L.push(''); }
      if (r.aplicaciones && r.aplicaciones.length) { L.push('## Aplicaciones', ''); items(r.aplicaciones, a => a); L.push(''); }
      if (r.frases_destacadas && r.frases_destacadas.length) { L.push('## Frases destacadas', ''); items(r.frases_destacadas, f => `“${f.texto}”${f.minuto ? ` (${f.minuto})` : ''}`); L.push(''); }
      if (r.preguntas_reflexion && r.preguntas_reflexion.length) { L.push('## Preguntas para reflexionar', ''); items(r.preguntas_reflexion, q => q); L.push(''); }
    } else {
      L.push(`**Participantes:** ${Object.values(rec.names).join(', ')}`, '');
      if (r.resumen) L.push('## Resumen', '', r.resumen, '');
      if (r.decisiones && r.decisiones.length) { L.push('## Decisiones', ''); items(r.decisiones, d => d); L.push(''); }
      if (r.tareas && r.tareas.length) { L.push('## Tareas', '', '| Tarea | Responsable | Fecha |', '|---|---|---|'); r.tareas.forEach(t => L.push(`| ${t.tarea} | ${t.responsable} | ${t.fecha || ''} |`)); L.push(''); }
      if (r.temas && r.temas.length) { L.push('## Temas', ''); items(r.temas, t => `**${t.tema}**${t.minuto ? ` (${t.minuto})` : ''}: ${t.resumen}`); L.push(''); }
      if (r.pendientes && r.pendientes.length) { L.push('## Pendientes', ''); items(r.pendientes, p => p); L.push(''); }
    }
    if (r.mapa_mental) L.push('## Mapa mental', '', '```markdown', r.mapa_mental, '```', '');
    if (rec.segments && rec.segments.length) {
      L.push('## Transcripción', '');
      namedSegments(rec).forEach(s => L.push(`**[${mmss(s.start)}] ${s.speaker}:** ${s.text}`, ''));
    }
    return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  }
  function copyMarkdown() {
    if (!S.rec) return;
    const md = toMarkdown(S.rec);
    (navigator.clipboard ? navigator.clipboard.writeText(md) : Promise.reject())
      .then(() => toast('Resumen copiado en Markdown'))
      .catch(() => downloadBlob(new Blob([md], { type: 'text/markdown' }), slug(S.rec.title) + '.md'));
  }
  function downloadMarkdown() { if (S.rec) downloadBlob(new Blob([toMarkdown(S.rec)], { type: 'text/markdown' }), slug(S.rec.title) + '.md'); }
  function downloadAudio() {
    if (!S.rec || !S.rec.audioBlob) return;
    const f = S.rec.audioBlob;
    const ext = (f.name && f.name.split('.').pop()) || 'webm';
    downloadBlob(f, slug(S.rec.title) + '.' + ext);
  }

  function serializable(rec) {
    return {
      id: rec.id, mode: rec.mode, title: rec.title, date: rec.date, duration: rec.duration,
      segments: rec.segments, speakers: rec.speakers.map(s => ({ id: s.id, secs: s.secs, turns: s.turns, pct: s.pct, samples: s.samples })),
      names: rec.names, teacher: rec.teacher, result: rec.result,
      driveFileId: rec.driveFileId || null, driveLink: rec.driveLink || null, savedAt: new Date().toISOString()
    };
  }
  function saveRecording(silent) {
    if (!S.rec || !S.rec.segments.length) { toast('No hay nada que guardar todavía'); return false; }
    S.rec.title = $('gr-title').value.trim() || S.rec.title;
    const all = loadJSON(STORE_KEY, []).filter(x => x.id !== S.rec.id);
    all.unshift(serializable(S.rec));
    let ok = saveJSON(STORE_KEY, all);
    while (!ok && all.length > 1) { all.pop(); ok = saveJSON(STORE_KEY, all); }
    if (!ok) { toast('No hay espacio para guardar. Descarga el Markdown.'); return false; }
    renderSaved();
    if (!silent) toast('✓ Grabación guardada (el audio descárgalo aparte)');
    return true;
  }
  function saveAsSermon() {
    const rec = S.rec;
    if (!rec || !rec.result) return;
    if (!saveRecording(true)) return;
    const r = rec.result;
    const content = [r.ensenanza_central, r.resumen,
      (r.puntos_principales || []).map(p => `• ${p.titulo}: ${p.explicacion}`).join('\n'),
      (r.versiculos || []).length ? 'Versículos: ' + r.versiculos.map(v => v.referencia).join('; ') : ''
    ].filter(Boolean).join('\n\n');
    const sermon = {
      id: rec.id,
      title: r.titulo || rec.title,
      date: rec.date,
      parasha: ($('gr-parasha') && $('gr-parasha').value) || 'General',
      category: r.categoria || 'Reflexión',
      content,
      aiAnalysis: `Enseñanza de ${rec.names[rec.teacher] || ''}. ${r.ensenanza_central || ''}`.trim(),
      tags: r.tags || [],
      recordingId: rec.id
    };
    if (window.FreedomApp) window.FreedomApp.upsertSermon(sermon);
    toast('✓ Guardada en el registro de prédicas');
  }

  // ── Google Drive (para usar en NotebookLM) ────────────────────────
  // Crea o actualiza un Google Doc por grabación dentro de una carpeta fija.
  // Permiso "drive.file": la app solo ve los archivos que ella misma creó.
  const DRIVE_FOLDER = 'Iglesia Freedom — Enseñanzas';
  const DRIVE_FOLDER_REUNIONES = 'Iglesia Freedom — Reuniones';
  const drive = { token: null, exp: 0, client: null, clientId: undefined };

  async function getClientId() {
    if (drive.clientId !== undefined) return drive.clientId;
    try {
      const r = await fetch('/api/config');
      const c = await r.json();
      drive.clientId = c.googleClientId || null;
    } catch (_) { drive.clientId = null; }
    return drive.clientId;
  }
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    return loadScript('https://accounts.google.com/gsi/client');
  }
  async function driveToken() {
    if (drive.token && Date.now() < drive.exp - 60000) return drive.token;
    const clientId = await getClientId();
    if (!clientId) throw new Error('Falta configurar GOOGLE_CLIENT_ID en Vercel');
    await loadGis();
    return new Promise((resolve, reject) => {
      if (!drive.client) {
        drive.client = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: () => {}
        });
      }
      drive.client.callback = resp => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        drive.token = resp.access_token;
        drive.exp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        resolve(drive.token);
      };
      drive.client.error_callback = err => reject(new Error(err && err.type === 'popup_closed' ? 'Se cerró la ventana de Google' : 'Google no dio acceso' + (err && err.type ? ' (' + err.type + ')' : '')));
      drive.client.requestAccessToken({ prompt: drive.token ? '' : undefined });
    });
  }
  async function gfetch(url, opts) {
    const token = await driveToken();
    const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, (opts && opts.headers) || {}) }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) { drive.token = null; }
      throw new Error((data.error && data.error.message) || 'Google Drive respondió ' + r.status);
    }
    return data;
  }
  async function ensureFolder(name) {
    const key = 'freedom_drive_folder_' + name;
    const cached = localStorage.getItem(key);
    if (cached) {
      try {
        const f = await gfetch('https://www.googleapis.com/drive/v3/files/' + cached + '?fields=id,trashed');
        if (f && f.id && !f.trashed) return f.id;
      } catch (_) { /* se busca o se crea de nuevo */ }
    }
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await gfetch('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + q);
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const created = await gfetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
      });
      id = created.id;
    }
    localStorage.setItem(key, id);
    return id;
  }

  // HTML sencillo que Google Docs convierte bien (títulos, listas, tablas).
  function docHtml(rec) {
    const r = rec.result || {};
    const h = [];
    const li = (arr, fn) => (arr && arr.length) ? '<ul>' + arr.map(x => '<li>' + fn(x) + '</li>').join('') + '</ul>' : '';
    const sec = (title, inner) => inner ? `<h2>${esc(title)}</h2>${inner}` : '';
    const paras = t => String(t || '').split(/\n+/).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
    h.push(`<h1>${esc(r.titulo || rec.title)}</h1>`);
    const meta = [`<b>Fecha:</b> ${esc(rec.date)}`, `<b>Tipo:</b> ${rec.mode === 'reunion' ? 'Reunión' : 'Prédica / enseñanza'}`];
    if (rec.mode === 'predica') {
      meta.push(`<b>Enseñanza de:</b> ${esc(rec.names[rec.teacher] || '')}`);
      if (r.categoria) meta.push(`<b>Categoría:</b> ${esc(r.categoria)}`);
    }
    meta.push(`<b>Participantes:</b> ${esc(Object.values(rec.names || {}).join(', '))}`);
    if (rec.duration) meta.push(`<b>Duración:</b> ${mmss(rec.duration)}`);
    h.push('<p>' + meta.join('<br>') + '</p>');
    if (rec.mode === 'predica') {
      if (r.ensenanza_central) h.push(sec('Enseñanza central', `<p><i>${esc(r.ensenanza_central)}</i></p>`));
      h.push(sec('Resumen', paras(r.resumen)));
      h.push(sec('Puntos principales', li(r.puntos_principales, p => `<b>${esc(p.titulo)}</b>${p.minuto ? ' (' + esc(p.minuto) + ')' : ''}: ${esc(p.explicacion)}`)));
      h.push(sec('Versículos', li(r.versiculos, v => `<b>${esc(v.referencia)}</b>: ${esc(v.como_se_uso)}`)));
      h.push(sec('Términos hebreos', li(r.terminos_hebreos, t => `<b>${esc(t.termino)}</b>: ${esc(t.significado)}`)));
      h.push(sec('Aplicaciones', li(r.aplicaciones, a => esc(a))));
      h.push(sec('Frases destacadas', li(r.frases_destacadas, f => `“${esc(f.texto)}”${f.minuto ? ' (' + esc(f.minuto) + ')' : ''}`)));
      h.push(sec('Preguntas para reflexionar', li(r.preguntas_reflexion, q => esc(q))));
    } else {
      h.push(sec('Resumen', paras(r.resumen)));
      h.push(sec('Decisiones', li(r.decisiones, d => esc(d))));
      if (r.tareas && r.tareas.length) {
        h.push(sec('Tareas', '<table border="1" cellpadding="4"><tr><th>Tarea</th><th>Responsable</th><th>Fecha</th></tr>' +
          r.tareas.map(t => `<tr><td>${esc(t.tarea)}</td><td>${esc(t.responsable)}</td><td>${esc(t.fecha || '')}</td></tr>`).join('') + '</table>'));
      }
      h.push(sec('Temas', li(r.temas, t => `<b>${esc(t.tema)}</b>${t.minuto ? ' (' + esc(t.minuto) + ')' : ''}: ${esc(t.resumen)}`)));
      h.push(sec('Pendientes', li(r.pendientes, p => esc(p))));
      h.push(sec('Participación', li(r.participacion, p => `<b>${esc(p.nombre)}</b>: ${esc(p.aportes)}`)));
    }
    if (r.mapa_mental) {
      // El mapa mental como esquema de texto (NotebookLM lo lee bien).
      const lines = r.mapa_mental.split('\n').filter(l => l.trim()).map(l => {
        const m = l.match(/^(#+)\s*(.*)$/); const b = l.match(/^(\s*)[-*]\s+(.*)$/);
        if (m) return `<li style="margin-left:${(m[1].length - 1) * 18}px"><b>${esc(m[2])}</b></li>`;
        if (b) return `<li style="margin-left:${36 + b[1].length * 9}px">${esc(b[2])}</li>`;
        return `<li>${esc(l)}</li>`;
      });
      h.push(sec('Mapa mental (esquema)', '<ul>' + lines.join('') + '</ul>'));
    }
    if (r.tags && r.tags.length) h.push(`<p><b>Etiquetas:</b> ${esc(r.tags.join(', '))}</p>`);
    if (rec.segments && rec.segments.length) {
      h.push('<h2>Transcripción completa</h2>');
      namedSegments(rec).forEach(sg => h.push(`<p><b>[${mmss(sg.start)}] ${esc(sg.speaker)}:</b> ${esc(sg.text)}</p>`));
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + h.filter(Boolean).join('\n') + '</body></html>';
  }

  async function saveToDrive() {
    const rec = S.rec;
    if (!rec || !rec.segments || !rec.segments.length) { toast('Primero procesa una grabación'); return; }
    rec.title = $('gr-title').value.trim() || rec.title;
    const btn = $('gr-drive-btn');
    if (btn) btn.disabled = true;
    try {
      // Pedir acceso primero, mientras el clic del usuario sigue "vivo" (evita que se bloquee la ventana).
      await driveToken();
      setStatus('<span class="gr-spin"></span> Guardando en Google Drive…', 'work');
      const folderId = await ensureFolder(rec.mode === 'reunion' ? DRIVE_FOLDER_REUNIONES : DRIVE_FOLDER);
      const name = `${rec.date} — ${(rec.result && rec.result.titulo) || rec.title}`;
      const boundary = 'freedom' + Date.now();
      const meta = rec.driveFileId
        ? { name }
        : { name, mimeType: 'application/vnd.google-apps.document', parents: [folderId], description: 'Generado por Iglesia Freedom — Centro de Enseñanza' };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${docHtml(rec)}\r\n--${boundary}--`;
      const url = rec.driveFileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${rec.driveFileId}?uploadType=multipart&fields=id,webViewLink`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
      let file;
      try {
        file = await gfetch(url, { method: rec.driveFileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
      } catch (err) {
        if (!rec.driveFileId) throw err;
        // El Doc anterior se borró: crear uno nuevo.
        rec.driveFileId = null;
        rec.driveLink = null;
        return saveToDrive();
      }
      const isUpdate = !!rec.driveFileId;
      rec.driveFileId = file.id;
      rec.driveLink = file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`;
      saveRecording(true);
      setStatus(`✓ ${isUpdate ? 'Actualizado' : 'Guardado'} en Google Drive, carpeta “${esc(rec.mode === 'reunion' ? DRIVE_FOLDER_REUNIONES : DRIVE_FOLDER)}”. <a href="${esc(rec.driveLink)}" target="_blank" rel="noopener">Abrir el Doc</a> · En NotebookLM: <b>Agregar fuente → Google Drive</b>.`, 'ok');
    } catch (err) {
      setStatus('⚠️ No se pudo guardar en Drive: ' + esc(err.message), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderSaved() {
    const all = loadJSON(STORE_KEY, []);
    const box = $('gr-saved');
    if (!box) return;
    box.innerHTML = all.length ? all.map(x => `
      <div class="gr-saved-item" onclick="Grabar.openSaved(${x.id})">
        <span>${x.mode === 'predica' ? '📜' : '👥'}</span>
        <div style="flex:1;min-width:0;">
          <div class="gr-saved-title">${esc((x.result && x.result.titulo) || x.title)}</div>
          <div class="gr-muted">${esc(x.date)} · ${mmss(x.duration)} · ${esc(Object.values(x.names || {}).join(', '))}</div>
        </div>
        <span class="gr-chip-x" title="Eliminar" onclick="event.stopPropagation();Grabar.deleteSaved(${x.id})">×</span>
      </div>`).join('') : '<div class="gr-muted">Todavía no hay grabaciones guardadas.</div>';
  }
  function openSaved(id) {
    const x = loadJSON(STORE_KEY, []).find(r => r.id === id);
    if (!x) { toast('No se encontró la grabación'); return; }
    if (typeof window.showView === 'function') window.showView('grabar');
    S.rec = Object.assign({ audioUrl: '', audioBlob: null, liveLines: [] }, x);
    setMode(x.mode, true);
    $('gr-title').value = x.title;
    $('gr-date').value = x.date;
    $('gr-audio').removeAttribute('src');
    $('gr-download-audio').style.display = 'none';
    $('gr-step-voices').style.display = 'block';
    renderVoices();
    renderTranscript();
    renderResult();
    showTab(x.result ? 'summary' : 'transcript');
    setStatus('Grabación guardada abierta.', 'ok');
    safe(DB.getSession(id).then(sess => DB.getAudio(id, sess && sess.mime).then(blob => {
      if (!blob || !S.rec || S.rec.id !== id) {
        if (S.rec && S.rec.id === id) setStatus('Grabación guardada abierta. Su audio no está en este navegador; usa el archivo descargado para escucharlo.', 'ok');
        return;
      }
      const file = new File([blob], slug(x.title) + '.' + extOf(blob.type), { type: blob.type });
      S.rec.audioBlob = file;
      S.rec.audioUrl = URL.createObjectURL(file);
      $('gr-audio').src = S.rec.audioUrl;
      $('gr-download-audio').style.display = 'inline-flex';
    })));
    $('gr-step-voices').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function deleteSaved(id) {
    if (!confirm('¿Eliminar esta grabación guardada?')) return;
    saveJSON(STORE_KEY, loadJSON(STORE_KEY, []).filter(x => x.id !== id));
    safe(DB.remove(id));
    renderSaved();
  }

  // ── Recuperar grabaciones interrumpidas ───────────────────────────
  async function checkRecovery() {
    const box = $('gr-recover');
    if (!box) return [];
    const all = (await safe(DB.allSessions())) || [];
    const pending = all
      .filter(x => (x.status === 'recording' || x.status === 'stopped') && !(S.recorder && S.session && S.session.id === x.id))
      .filter(x => !(S.rec && S.rec.id === x.id))
      .sort((a, b) => b.id - a.id);
    box.innerHTML = pending.map(x => {
      const when = new Date(x.startedAt || x.id);
      const label = when.toLocaleDateString('es', { day: 'numeric', month: 'short' }) + ' ' + when.toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
      return `<div class="gr-recover-item">
        <div style="flex:1;min-width:200px;">
          <strong>⚠️ ${x.status === 'recording' ? 'Grabación interrumpida' : 'Grabación sin procesar'}:</strong>
          ${esc(x.title || (x.mode === 'reunion' ? 'Reunión' : 'Prédica'))} · ${esc(label)}${x.duration ? ' · ' + mmss(x.duration) : ''}
        </div>
        <button class="btn btn-gold btn-sm" onclick="Grabar.recover(${x.id})">Recuperar y procesar</button>
        <button class="btn btn-outline btn-sm" onclick="Grabar.downloadPending(${x.id})">⬇ Audio</button>
        <button class="btn btn-outline btn-danger btn-sm" onclick="Grabar.discard(${x.id})">Descartar</button>
      </div>`;
    }).join('');
    box.style.display = pending.length ? 'block' : 'none';
    return pending;
  }
  async function recover(id) {
    if (S.recorder) { toast('Primero detén la grabación actual'); return; }
    const sess = await safe(DB.getSession(id));
    const blob = sess && await safe(DB.getAudio(id, sess.mime));
    if (!sess || !blob) { toast('No se encontró el audio de esa grabación'); safe(DB.remove(id)); checkRecovery(); return; }
    if (typeof window.showView === 'function') window.showView('grabar');
    S.session = sess;
    if (sess.status === 'recording') persistSession({ status: 'stopped' });
    S.liveLines = sess.liveLines || [];
    S.session.liveLines = S.liveLines;
    setMode(sess.mode || 'predica', true);
    $('gr-title').value = sess.title || '';
    $('gr-date').value = sess.date || today();
    resetResult();
    renderLive();
    const file = new File([blob], sess.fileName || `grabacion-${sess.date || today()}.${extOf(blob.type)}`, { type: blob.type });
    $('gr-recover').style.display = 'none';
    processAudio(file, sess.duration || null, id);
  }
  async function downloadPending(id) {
    const sess = await safe(DB.getSession(id));
    const blob = sess && await safe(DB.getAudio(id, sess.mime));
    if (!blob) { toast('No se encontró el audio'); return; }
    downloadBlob(blob, slug(sess.title || 'grabacion') + '-' + id + '.' + extOf(blob.type));
  }
  async function discard(id) {
    if (!confirm('¿Borrar esta grabación sin procesar? No se podrá recuperar.')) return;
    await safe(DB.remove(id));
    checkRecovery();
  }

  // ── Modo y limpieza ───────────────────────────────────────────────
  function setMode(mode, keepRec) {
    S.mode = mode === 'reunion' ? 'reunion' : 'predica';
    document.querySelectorAll('.gr-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));
    $('gr-parasha-group').style.display = S.mode === 'predica' ? 'flex' : 'none';
    if (S.rec && !keepRec) { S.rec.mode = S.mode; renderVoices(); renderResult(); }
  }
  function resetResult() {
    S.rec = null; S._mm = null;
    $('gr-step-voices').style.display = 'none';
    $('gr-step-result').style.display = 'none';
    $('gr-download-audio').style.display = 'none';
    $('gr-summarize-btn').disabled = true;
    setStatus('');
  }

  // ── Inicio ────────────────────────────────────────────────────────
  function init() {
    if (!$('view-grabar')) return;
    $('gr-date').value = today();
    const ps = $('gr-parasha');
    if (ps && window.PARASHOT_LIST) {
      ps.innerHTML = '<option value="">— General —</option>' + window.PARASHOT_LIST.map(p => `<option value="${esc(p.name)}">${esc(p.name)} — ${esc(p.hebrew)}</option>`).join('');
    }
    $('gr-mic').addEventListener('change', e => {
      S.deviceId = e.target.value;
      localStorage.setItem('freedom_mic', S.deviceId);
      startPreview();
    });
    $('gr-dsp').addEventListener('change', e => { S.browserDsp = e.target.checked; startPreview(); });
    $('gr-teacher').addEventListener('change', e => setTeacher(e.target.value));
    $('gr-person-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } });
    $('gr-audio').addEventListener('timeupdate', onAudioTime);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { if (!S.recorder) refreshDevices(false); });
    }
    window.addEventListener('beforeunload', e => { if (S.recorder) { e.preventDefault(); e.returnValue = ''; } });
    setMode('predica');
    renderPeople();
    renderLive();
    renderSaved();
    checkRecovery().then(p => { if (p && p.length) toast('Hay una grabación sin procesar. Ábrela en 🎙️ Grabar.'); });
  }

  // Se llama al abrir la vista.
  function onShow() {
    refreshDevices(false);
    renderSaved();
    checkRecovery();
  }
  function onHide() { if (!S.recorder) stopPreview(); }

  window.Grabar = {
    init, onShow, onHide, start, stop, onUpload, setMode, addPerson, removePerson, tapSpeaker,
    cycleLineSpeaker, renameVoice, play, summarize, showTab, copyMarkdown, downloadMarkdown,
    downloadAudio, downloadMindmapSvg, saveRecording, saveAsSermon, openSaved, deleteSaved,
    retry, recover, downloadPending, discard, saveToDrive,
    permit: () => refreshDevices(true),
    isRecording: () => !!S.recorder,
    // para pruebas
    _docHtml: docHtml, _buildSegments: buildSegments, _speakerStats: speakerStats, _suggestNames: suggestNames, _toMarkdown: toMarkdown
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
