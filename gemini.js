export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const RAPID_KEY  = process.env.RAPIDAPI_KEY;
  const { type, prompt, flightNumber, date } = req.body;

  const allowedTypes = ['itinerary', 'hotel', 'flight', 'destination'];
  if (!type || !allowedTypes.includes(type))
    return res.status(400).json({ error: 'Invalid request type' });

  // ── GEMINI helper ──
  async function callGemini(p, maxTokens=800, useSearch=false) {
    const url = `https://generativelanguage.googleapis.com/v1alpha/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_KEY}`;
    const body = {
      contents: [{ parts: [{ text: p }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      ...(useSearch ? { tools: [{ google_search_retrieval: {} }] } : {}),
    };
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error?.message || `HTTP ${r.status}`); }
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // ══════════════════════════════════════
  // FLIGHT — AeroDataBox 優先，Gemini 備援
  // ══════════════════════════════════════
  if (type === 'flight') {
    if (!flightNumber) return res.status(400).json({ error: 'Missing flightNumber' });
    const num = flightNumber.trim().toUpperCase();
    const dateStr = date || new Date().toISOString().split('T')[0];

    // 1. AeroDataBox
    if (RAPID_KEY) {
      try {
        const url = `https://aerodatabox.p.rapidapi.com/flights/number/${num}/${dateStr}`;
        const r = await fetch(url, {
          headers: { 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com', 'x-rapidapi-key': RAPID_KEY }
        });
        if (r.ok) {
          const data = await r.json();
          const f = Array.isArray(data) ? data[0] : data;
          if (f && (f.departure || f.arrival)) {
            const dL = f.departure?.scheduledTime?.local || '';
            const aL = f.arrival?.scheduledTime?.local  || '';
            const dep  = dL.includes('T') ? dL.split('T')[1].substring(0,5) : dL.substring(0,5);
            const arr  = aL.includes('T') ? aL.split('T')[1].substring(0,5) : aL.substring(0,5);
            const fDate= dL.includes('T') ? dL.split('T')[0] : dateStr;
            return res.status(200).json({
              source:  'aerodatabox',
              dep, arr,
              date:    fDate,
              airline: f.airline?.name || f.airline?.iata || '',
              from:    f.departure?.airport?.municipalityName || f.departure?.airport?.iata || '',
              to:      f.arrival?.airport?.municipalityName   || f.arrival?.airport?.iata   || '',
            });
          }
        }
      } catch(e) { console.warn('AeroDataBox failed:', e.message); }
    }

    // 2. Gemini fallback
    if (!GEMINI_KEY) return res.status(500).json({ error: 'No API keys configured' });
    try {
      const p = `查詢航班${num}（日期${dateStr}）的資訊，使用Google搜尋。只回傳JSON：{"dep":"HH:MM","arr":"HH:MM","airline":"航空公司中文全名","from":"出發城市中文","to":"目的地城市中文","date":"YYYY-MM-DD"}。只輸出JSON。`;
      const text = await callGemini(p, 400, true);
      const info = JSON.parse(text.replace(/```json|```/g,'').trim());
      return res.status(200).json({ source:'gemini', ...info });
    } catch(e) {
      return res.status(500).json({ error:'Flight lookup failed', detail: e.message });
    }
  }

  // ══════════════════════════════════════
  // DESTINATION search
  // ══════════════════════════════════════
  if (type === 'destination') {
    if (!prompt || prompt.length > 100) return res.status(400).json({ error: 'Invalid prompt' });
    if (!GEMINI_KEY) return res.status(500).json({ error: 'Gemini key not configured' });
    try {
      const p = `使用者輸入「${prompt}」，搜尋符合的旅遊目的地城市（最多5筆）。只回傳JSON陣列，每筆：{"city":"城市中文名","country":"國家中文名","airport":"主要機場中文全名","iata":"IATA代碼","emoji":"國旗emoji"}。只輸出JSON陣列。`;
      const text = await callGemini(p, 600, true);
      const results = JSON.parse(text.replace(/```json|```/g,'').trim());
      return res.status(200).json({ results });
    } catch(e) {
      return res.status(500).json({ error:'Destination search failed', detail: e.message });
    }
  }

  // ══════════════════════════════════════
  // ITINERARY / HOTEL
  // ══════════════════════════════════════
  if (!prompt || typeof prompt !== 'string' || prompt.length > 3000)
    return res.status(400).json({ error: 'Invalid prompt' });
  if (!GEMINI_KEY) return res.status(500).json({ error: 'Gemini key not configured' });

  try {
    const maxTok = type === 'itinerary' ? 2000 : 800;
    const useSearch = type === 'hotel';
    const text = await callGemini(prompt, maxTok, useSearch);
    return res.status(200).json({ text });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
