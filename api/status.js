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

  const prompt =
    'You are writing one short, friendly sentence for a transit app rider who ' +
    'just started tracking their bus. Given the situation below, write a single ' +
    'warm, human sentence — under 20 words, no emoji, no quotation marks — that ' +
    'tells them how to feel about their wait: rushed, relaxed, or in between. ' +
    'Situation: ' + situation;

  // The free tier's newest models can return a transient 503 ("model
  // overloaded") under load. Rather than bet on one model name, try a
  // short list, newest first, and fall through on any failure — only
  // report an error if every one of them fails.
  const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  const errors = [];

  for (const model of MODELS) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + process.env.GEMINI_API_KEY;
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (!geminiRes.ok) {
        const bodyText = await geminiRes.text().catch(() => '');
        errors.push(model + ' -> ' + geminiRes.status + ' ' + bodyText.slice(0, 300));
        continue;
      }
      const data = await geminiRes.json();
      const text = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

      if (!text) { errors.push(model + ' -> no text in response: ' + JSON.stringify(data).slice(0, 300)); continue; }

      res.status(200).json({ message: text.trim().replace(/^"|"$/g, '').slice(0, 200), model });
      return;
    } catch (err) {
      errors.push(model + ' -> ' + String((err && err.message) || err));
    }
  }

  res.status(502).json({ error: 'AI generation failed', detail: errors });
};
