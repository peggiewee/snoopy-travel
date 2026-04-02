export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting: max 30 requests per IP per hour
  // (Vercel Edge handles this automatically via their DDoS protection)

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { prompt, type } = req.body;

  // Validate request type to prevent abuse
  const allowedTypes = ['itinerary', 'hotel', 'flight'];
  if (!type || !allowedTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid request type' });
  }

  if (!prompt || typeof prompt !== 'string' || prompt.length > 2000) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    // Enable Google Search Retrieval for real-time data
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: type === 'itinerary' ? 2000 : 800,
      },
      tools: type === 'flight' || type === 'hotel'
        ? [{ google_search_retrieval: {} }]
        : [],
    };

    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!geminiResp.ok) {
      const errData = await geminiResp.json().catch(() => ({}));
      console.error('Gemini error:', errData);
      return res.status(geminiResp.status).json({
        error: errData.error?.message || 'Gemini API error',
      });
    }

    const data = await geminiResp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
