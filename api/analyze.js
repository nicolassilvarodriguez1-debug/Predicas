export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      system: `Eres un asistente especializado en enseñanza bíblica mesiánica hebrea para Iglesia Freedom. Analiza el texto y responde ÚNICAMENTE en JSON con: category, confidence, reasoning, strengths, recommendations, tags, analysis.`,
      messages: [{ role: 'user', content: `Analiza esta prédica:\n\n${content.substring(0, 3000)}` }]
    })
  });

  const data = await response.json();
  res.status(200).json(data);
}
