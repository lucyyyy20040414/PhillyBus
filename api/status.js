// Vercel serverless function (Node runtime, uses the platform's built-in
// fetch — no dependency, no package.json needed). Runs server-side only, so
// the Gemini API key never reaches the browser.
//
// Given the live trip situation (destination, how far out, any delay), asks
// Gemini for one short, human sentence telling the rider how to feel about
// their wait — "plenty of time" vs "might want to hustle". This is the
// AI's whole job: turning structured numbers into a feeling. It never sees
// or invents route/stop/schedule facts beyond what this function already
// computed from real SEPTA data and hands it as plain context.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const body = req.body || {};
  const destination = body.destination ? String(body.destination).slice(0, 120) : 'your stop';
  const minutesAway = Number.isFinite(body.minutesAway) ? Math.round(body.minutesAway) : null;
  const lateMinutes = Number.isFinite(body.lateMinutes) ? Math.round(body.lateMinutes) : null;

  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: 'AI not configured' });
    return;
  }

  let situation = 'Heading to ' + destination + '.';
  if (minutesAway !== null) situation += ' About ' + minutesAway + ' minutes until arrival.';
  if (lateMinutes !== null && lateMinutes > 0) situation += ' The bus is running ' + lateMinutes + ' minutes behind schedule.';
  else if (lateMinutes !== null && lateMinutes < 0) situation += ' The bus is running ' + Math.abs(lateMinutes) + ' minutes ahead of schedule.';

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text:
              'You are writing one short, friendly sentence for a transit app rider who ' +
              'just started tracking their bus. Given the situation below, write a single ' +
              'warm, human sentence — under 20 words, no emoji, no quotation marks — that ' +
              'tells them how to feel about their wait: rushed, relaxed, or in between. ' +
              'Situation: ' + situation
          }]
        }]
      })
    });

    if (!geminiRes.ok) throw new Error('Gemini request failed: ' + geminiRes.status);
    const data = await geminiRes.json();
    const text = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

    if (!text) throw new Error('no text in Gemini response');

    res.status(200).json({ message: text.trim().replace(/^"|"$/g, '').slice(0, 200) });
  } catch (err) {
    res.status(502).json({ error: 'AI generation failed', detail: String((err && err.message) || err) });
  }
};
