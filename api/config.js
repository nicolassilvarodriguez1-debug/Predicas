// Configuración pública para el navegador.
// El Client ID de Google no es secreto: Google lo protege por los dominios autorizados.
//   GET /api/config → { googleClientId }
module.exports = function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
};
