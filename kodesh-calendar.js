/* ════════════════════════════════════════════════════════════════════
   Calendario KODESH para Predicas
   - Parashot: las mismas fechas que la app KODESH (parashot-calendar.json,
     diáspora 2025–2056, con porciones dobles) y su contenido (parashot-data.json).
   - Fiestas: el calendario bíblico observado de KODESH (luna nueva visible desde
     Jerusalén + Aviv), igual que calendario.js de la app, con los ajustes del admin.
   Fuente: kodeshbible.com vía /api/kodesh-data; respaldo en /data/kodesh/.
   Expone window.KodeshData.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const ADJ_URL = 'https://fvknbqdsgqdmwirrgcvb.supabase.co/storage/v1/object/public/insignias/calendario.json';
  const FEASTS = {
    pesaj:   { n: 'Pésaj', alt: 'Pascua', he: 'פֶּסַח' },
    matzot:  { n: 'Matzot', alt: 'Panes sin levadura', he: 'מַצּוֹת' },
    bikurim: { n: 'Primicias', alt: 'Bikurim', he: 'בִּכּוּרִים' },
    shavuot: { n: 'Shavuot', alt: 'Semanas · Pentecostés', he: 'שָׁבוּעוֹת' },
    terua:   { n: 'Yom Teruá', alt: 'Día de las trompetas', he: 'יוֹם תְּרוּעָה' },
    kipur:   { n: 'Yom Kipur', alt: 'Día de las expiaciones', he: 'יוֹם הַכִּפֻּרִים' },
    sukot:   { n: 'Sukot', alt: 'Cabañas · Tabernáculos', he: 'סֻכּוֹת' }
  };
  const ORD = ['', 'Primer', 'Segundo', 'Tercer', 'Cuarto', 'Quinto', 'Sexto', 'Séptimo', 'Octavo', 'Noveno', 'Décimo', 'Undécimo', 'Duodécimo', 'Decimotercer'];
  const OLD = { 1: 'Aviv', 2: 'Ziv', 7: 'Etanim', 8: 'Bul' };

  let PARASHOT = [];      // 54 porciones de KODESH
  let CAL = {};           // { 'YYYY-MM-DD': [num, ...] } (sábados)
  let BIB = null;         // { months: [[evening, maybeEarlier]], nisan: { year: evening } }
  let ADJ = { m: {}, n: {}, c: {} };
  let SOURCE = 'kodesh';
  let loading = null;

  // ── Utilidades de fecha (todo en fecha local, sin zonas horarias) ──
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const at = (isoStr, n) => { const d = new Date(isoStr + 'T12:00:00'); d.setDate(d.getDate() + (n || 0)); return d; };
  const toDate = x => (x instanceof Date ? new Date(x.getFullYear(), x.getMonth(), x.getDate(), 12) : at(String(x).slice(0, 10)));

  async function getJSON(f, local) {
    try {
      const r = await fetch('/api/kodesh-data?f=' + f);
      if (r.ok) return await r.json();
      throw new Error(r.status);
    } catch (_) {
      SOURCE = 'copia';
      const r = await fetch(local);
      return r.json();
    }
  }

  function load() {
    if (!loading) {
      loading = Promise.all([
        getJSON('parashot', '/data/kodesh/parashot-data.json').then(j => { PARASHOT = j; }),
        getJSON('calendario', '/data/kodesh/parashot-calendar.json').then(j => { CAL = j; }),
        getJSON('biblico', '/data/kodesh/calendario-biblico.json').then(j => { BIB = j; }).catch(() => { BIB = null; }),
        fetch(ADJ_URL + '?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
          .then(j => { if (j && j.m) ADJ = j; }).catch(() => {})
      ]).then(() => api).catch(err => { loading = null; throw err; });
    }
    return loading;
  }

  // ── Parashot ──
  const byNum = n => PARASHOT.find(p => p.num === n);
  function label(nums) {
    return (nums || []).map(n => (byNum(n) || {}).nombre).filter(Boolean).join(' – ');
  }
  function hebrew(nums) {
    return (nums || []).map(n => (byNum(n) || {}).heb).filter(Boolean).join(' · ');
  }
  // Sábado de esa semana (la semana se nombra por la parashá del Shabat que viene).
  function shabbatOf(date) {
    const d = toDate(date);
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
    return d;
  }
  function parashaOn(date) { return CAL[iso(toDate(date))] || null; }
  // Parashá de la semana de una fecha. Si ese Shabat es una fiesta sin lectura
  // regular, se indica la fiesta y la siguiente parashá.
  function weekParasha(date) {
    const sat = shabbatOf(date);
    const nums = CAL[iso(sat)];
    if (nums) return { nums, label: label(nums), hebrew: hebrew(nums), shabbat: iso(sat) };
    const feast = feastsOn(sat)[0];
    const next = new Date(sat);
    for (let i = 0; i < 6; i++) {
      next.setDate(next.getDate() + 7);
      const n2 = CAL[iso(next)];
      if (n2) {
        return { nums: [], label: feast ? feast.name : 'Shabat especial', hebrew: feast ? feast.he : '', shabbat: iso(sat), feast, nextNums: n2, nextLabel: label(n2) };
      }
    }
    return { nums: [], label: feast ? feast.name : '', hebrew: '', shabbat: iso(sat), feast };
  }
  // Fechas (sábados) en que se lee una parashá, para unir prédicas antiguas.
  function datesOf(num) { return Object.keys(CAL).filter(k => CAL[k].includes(num)); }

  // ── Calendario bíblico observado (port de calendario.js de KODESH) ──
  function months() {
    return (BIB ? BIB.months : []).map(([e, p]) => ({
      pred: e, e: (ADJ.m && ADJ.m[e]) || e, p,
      fixed: !!((ADJ.m && ADJ.m[e]) || (ADJ.c && ADJ.c[e]))
    }));
  }
  function nisanIndex(y, ms) {
    const key = (ADJ.n && ADJ.n[y]) || (BIB && BIB.nisan && BIB.nisan[y]);
    return ms.findIndex(m => m.pred === key);
  }
  const dayOf = (m, n) => at(m.e, n);
  const yearCache = {};
  function feastYear(y) {
    if (!BIB) return null;
    if (yearCache[y] !== undefined) return yearCache[y];
    const ms = months(), i = nisanIndex(String(y), ms);
    if (i < 1 || i + 9 >= ms.length) return (yearCache[y] = null);
    const N = ms[i], S7 = ms[i + 6];
    let bik = null;
    for (let n = 15; n <= 21; n++) { const d = dayOf(N, n); if (d.getDay() === 0) { bik = d; break; } }
    const shav = new Date(bik); shav.setDate(bik.getDate() + 49);
    const f = (id, start, dias, m) => ({ id, start, dias, tentative: !!m.p && !m.fixed });
    return (yearCache[y] = [
      f('pesaj', dayOf(N, 14), 1, N), f('matzot', dayOf(N, 15), 7, N), f('bikurim', bik, 1, N), f('shavuot', shav, 1, N),
      f('terua', dayOf(S7, 1), 1, S7), f('kipur', dayOf(S7, 10), 1, S7), f('sukot', dayOf(S7, 15), 8, S7)
    ]);
  }
  // Fiestas que caen en una fecha (incluye el día n de fiestas de varios días).
  function feastsOn(date) {
    const d = toDate(date);
    const out = [];
    for (const y of [d.getFullYear() - 1, d.getFullYear()]) {
      (feastYear(y) || []).forEach(F => {
        const k = Math.round((d - F.start) / 864e5);
        if (k < 0 || k >= F.dias) return;
        const meta = FEASTS[F.id];
        let name = meta.n;
        if (F.id === 'sukot' && k === 7) name = 'Sheminí Atzéret';
        else if (F.dias > 1) name = `${meta.n} · día ${k + 1}`;
        out.push({ id: F.id, name, base: meta.n, alt: meta.alt, he: meta.he, day: k + 1, dias: F.dias, first: k === 0, tentative: F.tentative });
      });
    }
    return out;
  }
  function nextFeast(from) {
    const d = toDate(from || new Date());
    let best = null;
    for (const y of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
      (feastYear(y) || []).forEach(F => {
        const end = new Date(F.start); end.setDate(end.getDate() + F.dias - 1);
        if (end < d) return;
        if (!best || F.start < best.start) best = Object.assign({}, F, FEASTS[F.id], { end, now: F.start <= d });
      });
    }
    if (best) best.days = Math.max(0, Math.round((best.start - d) / 864e5));
    return best;
  }
  // Día 1 de cada mes bíblico (la mañana después del avistamiento).
  function monthStartOn(date) {
    if (!BIB) return null;
    const key = iso(toDate(date));
    const ms = months();
    for (let k = 0; k < ms.length; k++) {
      if (iso(at(ms[k].e, 1)) !== key) continue;
      const y = +ms[k].e.slice(0, 4);
      let ni = nisanIndex(String(y), ms);
      if (ni < 0 || ni > k) ni = nisanIndex(String(y - 1), ms);
      const num = ni < 0 ? null : k - ni + 1;
      return { num, name: num ? `${ORD[num] || num + '.º'} mes` : 'Luna nueva', old: OLD[num] || '', tentative: !!ms[k].p && !ms[k].fixed };
    }
    return null;
  }

  const api = {
    load, label, hebrew, weekParasha, parashaOn, shabbatOf, datesOf, feastsOn, nextFeast, monthStartOn, iso,
    byNum,
    get parashot() { return PARASHOT; },
    get source() { return SOURCE; },
    link: num => `https://kodeshbible.com/parashot?p=${num}`
  };
  window.KodeshData = api;
})();
