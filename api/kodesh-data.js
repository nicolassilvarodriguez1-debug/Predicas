// Trae los datos del calendario directamente de KODESH (kodeshbible.com), así
// Predicas siempre usa las mismas parashot y el mismo calendario bíblico que la app.
//   GET /api/kodesh-data?f=parashot | calendario | biblico
// Si KODESH no responde, el navegador usa la copia de /data/kodesh/.
const SOURCES = {
  parashot: 'https://kodeshbible.com/parashot-data.json',
  calendario: 'https://kodeshbible.com/parashot-calendar.json',
  biblico: 'https://kodeshbible.com/data/calendario-biblico.json'
};

module.exports = async function (req, res) {
  const url = SOURCES[(req.query && req.query.f) || ''];
  if (!url) return res.status(400).json({ error: 'f debe ser parashot, calendario o biblico' });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'IglesiaFreedom-Predicas' } });
    if (!r.ok) throw new Error('KODESH respondió ' + r.status);
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
};
