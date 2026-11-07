// Crea un token de un solo uso de ElevenLabs para que el navegador hable
// directo con Scribe sin exponer la API key.
//   POST /api/scribe-token  { "type": "realtime" | "batch" }
//   → { token }
// El token vence a los 15 minutos y sirve para una sola conexión/subida.

const TOKEN_TYPES = { realtime: 'realtime_scribe', batch: 'batch_scribe' };

module.exports = async function (req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Clave opcional para que nadie de afuera gaste créditos.
  const passcode = process.env.APP_PASSCODE;
  if (passcode && req.headers['x-app-passcode'] !== passcode) {
    return res.status(401).json({ error: 'Clave de acceso incorrecta' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'Falta ELEVENLABS_API_KEY en Vercel' });
  }

  const type = TOKEN_TYPES[(req.body && req.body.type) || 'realtime'];
  if (!type) {
    return res.status(400).json({ error: 'type debe ser "realtime" o "batch"' });
  }

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/single-use-token/${type}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.token) {
      return res.status(502).json({ error: 'ElevenLabs no devolvió un token', detail: data });
    }
    return res.status(200).json({ token: data.token });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo contactar a ElevenLabs', detail: String(err) });
  }
};
