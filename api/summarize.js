// Convierte una transcripción con voces identificadas en un resumen al estilo Plaud.
//   POST /api/summarize
//   {
//     mode: "predica" | "reunion",
//     teacher: "Pastor Niko",            // quien enseña (solo en modo prédica)
//     title, date,
//     segments: [{ start: 12.3, speaker: "Pastor Niko", text: "..." }]
//   }
//   → { result: { ...JSON del resumen... } }

const CATEGORIES = ['Bases de la Fe', 'Doctrina', 'Historia', 'Arrepentimiento', 'Reflexión', 'Profecía'];

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const SCHEMA_PREDICA = `{
  "titulo": "título corto y fiel a la enseñanza",
  "resumen": "2 a 3 párrafos con lo que se enseñó",
  "ensenanza_central": "una o dos frases con el mensaje principal",
  "puntos_principales": [{ "titulo": "", "explicacion": "", "minuto": "m:ss" }],
  "versiculos": [{ "referencia": "Libro cap:vers", "como_se_uso": "" }],
  "terminos_hebreos": [{ "termino": "", "significado": "" }],
  "aplicaciones": ["aplicación práctica para la congregación"],
  "frases_destacadas": [{ "texto": "cita textual corta", "minuto": "m:ss" }],
  "preguntas_reflexion": ["pregunta para grupos pequeños"],
  "mapa_mental": "markdown: '# tema central', '## ramas', '- hojas' (máx. 3 niveles)",
  "categoria": "una de: ${CATEGORIES.join(', ')}",
  "tags": ["5 a 8 etiquetas"]
}`;

const SCHEMA_REUNION = `{
  "titulo": "título corto de la reunión",
  "resumen": "2 a 3 párrafos con lo que se habló",
  "temas": [{ "tema": "", "resumen": "", "minuto": "m:ss" }],
  "decisiones": ["decisión tomada"],
  "tareas": [{ "tarea": "", "responsable": "nombre o 'Sin asignar'", "fecha": "fecha mencionada o ''" }],
  "pendientes": ["tema que quedó abierto"],
  "participacion": [{ "nombre": "", "aportes": "qué aportó" }],
  "frases_destacadas": [{ "texto": "cita textual corta", "quien": "", "minuto": "m:ss" }],
  "mapa_mental": "markdown: '# tema central', '## ramas', '- hojas' (máx. 3 niveles)",
  "tags": ["5 a 8 etiquetas"]
}`;

function buildPrompt({ mode, teacher, title, date, segments }) {
  const lines = segments.map(s => `[${mmss(s.start)}] ${s.speaker}: ${s.text}`).join('\n');
  const head = `Título provisional: ${title || '(sin título)'}\nFecha: ${date || ''}\n`;

  if (mode === 'reunion') {
    return {
      system: `Eres el secretario de Iglesia Freedom, una congregación mesiánica hebrea en Florida. ` +
        `Recibes la transcripción de una reunión con el nombre de quien habló en cada línea. ` +
        `Escribe en español, claro y fiel a lo dicho; no inventes decisiones, responsables ni fechas. ` +
        `Respeta la terminología de la congregación (Yeshúa, Torá, Shabat, parashá, kehilá, Ruaj HaKodesh, etc.). ` +
        `Responde ÚNICAMENTE con JSON válido, sin texto antes ni después, con esta forma:\n${SCHEMA_REUNION}`,
      user: `${head}\nTranscripción:\n${lines}`
    };
  }

  return {
    system: `Eres un asistente de enseñanza bíblica mesiánica hebrea para Iglesia Freedom. ` +
      `Recibes la transcripción de una prédica o enseñanza, con el nombre de quien habló en cada línea. ` +
      `La enseñanza es la de "${teacher}": basa el resumen en lo que dijo esa persona y usa a los demás ` +
      `(lecturas, preguntas, anuncios, alabanza) solo como contexto. ` +
      `Escribe en español, fiel a lo que se predicó; no agregues doctrina que no se dijo. ` +
      `Si se citan versículos de memoria o parcialmente, identifica la referencia más probable. ` +
      `Respeta la terminología de la congregación (Yeshúa, Torá, Shabat, parashá, kehilá, Ruaj HaKodesh, etc.). ` +
      `Responde ÚNICAMENTE con JSON válido, sin texto antes ni después, con esta forma:\n${SCHEMA_PREDICA}`,
    user: `${head}Quien enseña: ${teacher}\n\nTranscripción:\n${lines}`
  };
}

function parseJson(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(clean.slice(a, b + 1));
  throw new Error('La IA no devolvió JSON válido');
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const passcode = process.env.APP_PASSCODE;
  if (passcode && req.headers['x-app-passcode'] !== passcode) {
    return res.status(401).json({ error: 'Clave de acceso incorrecta' });
  }

  const body = req.body || {};
  const segments = Array.isArray(body.segments) ? body.segments.filter(s => s && s.text) : [];
  if (!segments.length) {
    return res.status(400).json({ error: 'No hay transcripción para resumir' });
  }
  const mode = body.mode === 'reunion' ? 'reunion' : 'predica';
  const teacher = body.teacher || 'el pastor';
  const { system, user } = buildPrompt({ mode, teacher, title: body.title, date: body.date, segments });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: 'Error de Claude', detail: data });
    }
    const text = (data.content || []).map(c => c.text || '').join('');
    const result = parseJson(text);
    if (mode === 'predica' && !CATEGORIES.includes(result.categoria)) result.categoria = 'Reflexión';
    return res.status(200).json({ result, mode });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
