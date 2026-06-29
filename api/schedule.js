export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { history } = req.body;

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
      system: `Eres un asistente de planificación pastoral para Iglesia Freedom, congregación de Raíces Hebreas Mesiánicas en Florida. Genera un cronograma de 6 prédicas. Responde SOLO en JSON con: insight, sermons (array con date, parasha, title, category, rationale, keyText).`,
      messages: [{ role: 'user', content: `Historial:\n${history}\n\nGenera el cronograma.` }]
    })
  });

  const data = await response.json();
  res.status(200).json(data);
}
