const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

module.exports = async function(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { content } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: `Eres un asistente especializado en enseñanza bíblica mesiánica hebrea para Iglesia Freedom. Analiza el texto y responde ÚNICAMENTE en JSON con: category (una de: Bases de la Fe, Doctrina, Historia, Arrepentimiento, Reflexión, Profecía), confidence, reasoning, strengths, recommendations, tags (array), analysis.`,
        messages: [{ role: 'user', content: `Analiza esta prédica:\n\n${content.substring(0, 3000)}` }]
      })
    });
    const data = await response.json();
