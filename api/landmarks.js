// Vercel serverless function (Node runtime, built-in fetch, no dependencies).
//
// GET /api/landmarks?route=42&dir=0&w=3&interest=history
//   -> the landmarks along one 1.5 km stretch ("window") of a route, for one
//      interest, as cards the app can surface when the bus gets close.
//
// Who does what:
//   - RULES choose the landmarks. OpenStreetMap places within ~60 m of the
//     route's own shape, ranked by a notability score (Wikipedia entry,
//     heritage status, ...), with a minimum bar per interest and spacing so
//     alerts don't bunch. "Which side" and "how far along" come from the
//     route's shape (SEPTA GTFS) — plain geometry, not GPS heading.
//   - WIKIPEDIA supplies each place's real description and photo.
//   - GEMINI only REWRITES that description into one short sentence for the
//     rider's interest. It doesn't pick anything, and its output is checked:
//     any number or capitalised name that isn't in the source description is
//     rejected and the plain description is used instead.
//
// The result depends only on (route, direction, window, interest), so it's
// sent with long cache headers: Vercel's CDN serves repeat requests from any
// rider without touching OpenStreetMap or Gemini again.
// The Gemini key stays server-side (GEMINI_API_KEY).

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// main, mirror, main again (a 504 from the main server is usually gone on the next try)
const OVERPASS_ATTEMPTS = [OVERPASS[0], OVERPASS[1], OVERPASS[0]];
const UA = 'PhillyBusRide/1.0 (UPenn course prototype; not affiliated with SEPTA)';
const MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash'];

const R = 6371000;
const WINDOW_M = 1000; // windows start every 1 km...
const OVERLAP_M = 500; // ...and each looks 500 m further, so nothing falls between windows
const NEAR_ROUTE_M = 60; // the search: a place's footprint must come within this of the route line
const MAX_CENTER_M = 150; // sanity limit on the distance from the route to a place's center point
const MAX_CARDS = 5;
const MIN_SPACING_M = 200; // no two cards closer than this along the route
const CACHE_SECONDS = 43200; // 12 h

const rad = (d) => (d * Math.PI) / 180;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// filters = which OpenStreetMap tags count for this interest; minScore = how
// notable a place must be (see scoreOf) before it's worth interrupting for.
const INTERESTS = {
  food: {
    label: 'Food', minScore: 1,
    filters: [
      '["amenity"~"^(restaurant|cafe|bakery|ice_cream|marketplace|food_court|pub|bar)$"]',
      '["shop"~"^(bakery|deli|pastry|confectionery|chocolate|cheese|coffee|seafood|butcher)$"]',
    ],
  },
  art: {
    label: 'Art + Design', minScore: 1,
    filters: ['["tourism"~"^(museum|gallery|artwork)$"]', '["amenity"~"^(arts_centre|theatre)$"]', '["shop"="art"]'],
  },
  history: {
    label: 'History', minScore: 3,
    filters: ['["historic"]', '["heritage"]', '["tourism"="museum"]'],
  },
  parks: {
    label: 'Parks', minScore: 0,
    filters: ['["leisure"~"^(park|garden|nature_reserve|playground|dog_park)$"]', '["tourism"="viewpoint"]'],
  },
  architecture: {
    label: 'Architecture', minScore: 2,
    filters: [
      '["building"]["wikipedia"]', '["building"]["wikidata"]', '["historic"="building"]',
      '["man_made"~"^(tower|bridge|clock)$"]', '["tourism"="attraction"]',
    ],
  },
  shopping: {
    label: 'Shopping', minScore: 1,
    filters: [
      '["shop"~"^(department_store|mall|books|clothes|antiques|gift|second_hand|records|music|art|jewelry|craft|variety_store|boutique|fashion|vintage)$"]',
      '["amenity"="marketplace"]',
    ],
  },
};

// ---------- small helpers ----------
async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...((opts && opts.headers) || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

// meters east/north of `ref`
function toXY(ref, p) {
  return { x: rad(p.lng - ref.lng) * Math.cos(rad(ref.lat)) * R, y: rad(p.lat - ref.lat) * R };
}

// ---------- the route (static data built from SEPTA's GTFS) ----------
const routeCache = new Map();
async function loadRoute(req, route) {
  const key = route.toUpperCase().replace(/[^A-Za-z0-9_-]/g, '_');
  if (routeCache.has(key)) return routeCache.get(key);
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
  const proto = (req.headers && req.headers['x-forwarded-proto']) || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  const r = await fetchWithTimeout(`${proto}://${host}/data/routes/${key}.json`, {}, 8000);
  if (!r.ok) return null;
  const doc = await r.json();
  routeCache.set(key, doc);
  return doc;
}

function prepareDir(dir) {
  if (dir.cum) return dir;
  const cum = [0];
  for (let i = 1; i < dir.shape.length; i++) {
    const a = { lat: dir.shape[i - 1][0], lng: dir.shape[i - 1][1] };
    const b = { lat: dir.shape[i][0], lng: dir.shape[i][1] };
    const d = toXY(a, b);
    cum.push(cum[i - 1] + Math.hypot(d.x, d.y));
  }
  dir.cum = cum;
  return dir;
}

// the route's polyline between two distances along it
function slicePath(dir, from, to) {
  const { shape, cum } = dir;
  const at = (s) => {
    s = Math.max(0, Math.min(cum[cum.length - 1], s));
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const span = cum[i + 1] - cum[i];
    const t = span > 0 ? (s - cum[i]) / span : 0;
    return { lat: shape[i][0] + t * (shape[i + 1][0] - shape[i][0]), lng: shape[i][1] + t * (shape[i + 1][1] - shape[i][1]) };
  };
  const pts = [at(from)];
  for (let i = 0; i < shape.length; i++) {
    if (cum[i] > from && cum[i] < to) pts.push({ lat: shape[i][0], lng: shape[i][1] });
  }
  pts.push(at(to));
  return pts;
}

// where is a place relative to the route: distance along it, distance off it, and which side
function projectOnPath(pts, from, place) {
  let best = null;
  let acc = from;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = toXY(place, pts[i]); // the place is the origin
    const b = toXY(place, pts[i + 1]);
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const segLen = Math.sqrt(len2);
    // Interior segments clamp to their ends; the first and last also extend outward, so a
    // place beyond this stretch gets its true position (and is left to the next window)
    // instead of being pinned to the edge.
    const rawT = len2 === 0 ? 0 : -(a.x * vx + a.y * vy) / len2;
    const t = Math.max(i === 0 ? -Infinity : 0, Math.min(i === pts.length - 2 ? Infinity : 1, rawT));
    const nx = a.x + t * vx;
    const ny = a.y + t * vy;
    const dist = Math.hypot(nx, ny);
    if (!best || dist < best.dist) {
      // driving along the segment, is the place on the left? (cross of direction of travel with route->place)
      const fx = len2 === 0 ? 0 : vx / segLen;
      const fy = len2 === 0 ? 0 : vy / segLen;
      const cross = fx * -ny - fy * -nx;
      best = { dist, s: acc + t * segLen, cross };
    }
    acc += segLen;
  }
  return best;
}

// ---------- notability + descriptions ----------
function kindOf(t) {
  if (t.tourism === 'artwork') return t.artwork_type === 'mural' ? 'Mural' : 'Public art';
  if (t.tourism === 'museum') return 'Museum';
  if (t.tourism === 'gallery') return 'Gallery';
  if (t.tourism === 'attraction') return 'Attraction';
  if (t.tourism === 'viewpoint') return 'Viewpoint';
  if (t.historic) return t.historic === 'memorial' ? 'Memorial' : t.historic === 'building' ? 'Historic building' : 'Historic site';
  if (t.leisure) return { park: 'Park', garden: 'Garden', nature_reserve: 'Nature area', playground: 'Playground', dog_park: 'Dog park' }[t.leisure] || 'Green space';
  if (t.amenity) {
    const m = {
      restaurant: 'Restaurant', cafe: 'Cafe', bakery: 'Bakery', ice_cream: 'Ice cream', marketplace: 'Market', food_court: 'Food court',
      pub: 'Pub', bar: 'Bar', theatre: 'Theater', arts_centre: 'Arts center', place_of_worship: 'Place of worship',
    };
    if (m[t.amenity]) return m[t.amenity];
  }
  if (t.shop) return cap(String(t.shop).replace(/_/g, ' ')) + ' shop';
  if (t.man_made) return cap(String(t.man_made).replace(/_/g, ' '));
  if (t.building) return 'Notable building';
  return 'Place';
}

// Notability: things with an encyclopedia entry or heritage status beat ordinary
// businesses; chains are less "discoverable".
function scoreOf(t) {
  let s = 0;
  if (t.wikipedia) s += 5;
  else if (t.wikidata) s += 3;
  if (t.heritage || t['heritage:operator']) s += 2;
  if (t.tourism === 'attraction' || t.tourism === 'museum' || t.tourism === 'gallery') s += 2;
  if (t.tourism === 'artwork') s += 1;
  if (t.historic) s += 1;
  if (t.website || t['contact:website'] || t.opening_hours) s += 1;
  if ((t.brand || t['brand:wikidata']) && !t.wikipedia) s -= 2;
  return s;
}

// The factual text about a place that Gemini is allowed to rewrite (and nothing more).
function describe(c) {
  if (c.wiki && c.wiki.extract) return c.wiki.extract.slice(0, 360);
  const t = c.tags;
  if (t.description) return String(t.description).slice(0, 360);
  const bits = [c.kind + '.'];
  if (t.cuisine) bits.push('Cuisine: ' + String(t.cuisine).replace(/[;_]/g, ', ') + '.');
  if (t.artist_name || t.artist) bits.push('Artist: ' + (t.artist_name || t.artist) + '.');
  if (t.architect) bits.push('Architect: ' + t.architect + '.');
  if (t.start_date) bits.push('Date: ' + t.start_date + '.');
  if (c.wiki && c.wiki.description) bits.push(c.wiki.description + '.');
  return bits.join(' ');
}

function plainSentence(desc) {
  // first sentence, without cutting at an initial or abbreviation ("Robert N. C. Nix", "St.", "U.S.")
  const text = String(desc).replace(/\s+/g, ' ').trim();
  let end = text.length;
  const re = /[.!?](?=\s+[A-Z])/g;
  let m;
  while ((m = re.exec(text))) {
    const word = text.slice(0, m.index).split(' ').pop();
    if (/^(?:[A-Z]|[A-Z][a-z]{0,2}|[A-Z](?:\.[A-Z])+)$/.test(word)) continue; // initial, Dr, Sr, Jr, St, U.S
    end = m.index + 1;
    break;
  }
  const first = text.slice(0, end);
  return first.length > 150 ? first.slice(0, 147).replace(/\s+\S*$/, '') + '…' : first;
}

// ---------- 1. candidates near the route (Overpass) ----------
function buildQuery(interest, pts) {
  // keep the query short: at most ~30 points along the stretch
  const step = Math.max(1, Math.ceil(pts.length / 30));
  const use = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const line = use.map((p) => p.lat.toFixed(5) + ',' + p.lng.toFixed(5)).join(',');
  const parts = INTERESTS[interest].filters.map((f) => `nwr(around:${NEAR_ROUTE_M},${line})${f}["name"];`);
  return `[out:json][timeout:25];(${parts.join('')});out center tags 300;`;
}

// Public Overpass servers are free but uneven (3-9 s, intermittent 504s). Start on
// the main one; if it fails or is slow, start the next attempt alongside it.
function overpass(query, timeoutMs = 15000, hedgeMs = 6000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = 0;
    let failures = 0;
    const startNext = () => {
      if (started >= OVERPASS_ATTEMPTS.length) return;
      const url = OVERPASS_ATTEMPTS[started++];
      fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) }, timeoutMs)
        .then((r) => {
          if (!r.ok) throw new Error(url + ' -> ' + r.status);
          return r.json();
        })
        .then((d) => {
          if (!settled) {
            settled = true;
            resolve(d.elements || []);
          }
        })
        .catch((e) => {
          failures++;
          if (settled) return;
          if (started < OVERPASS_ATTEMPTS.length) startNext();
          else if (failures >= OVERPASS_ATTEMPTS.length) {
            settled = true;
            reject(e);
          }
        });
    };
    startNext();
    setTimeout(() => {
      if (!settled) startNext();
    }, hedgeMs);
  });
}

// Turn raw map elements into candidates placed on the route.
function toCandidates(elements, pts, from, to, stops) {
  const seen = new Map();
  for (const e of elements) {
    const t = e.tags || {};
    const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
    if (!c || !t.name) continue;
    const place = { lat: c.lat, lng: c.lon };
    const p = projectOnPath(pts, from, place);
    // (the map server already matched footprints within NEAR_ROUTE_M; a big building's center can be much further back)
    if (!p || p.dist > MAX_CENTER_M || p.s < from - 5 || p.s > to + 5) continue;
    const near = stops.reduce((best, st) => (!best || Math.abs(st.s - p.s) < Math.abs(best.s - p.s) ? st : best), null);
    const cand = {
      key: e.type[0] + e.id, name: t.name, tags: t, lat: place.lat, lng: place.lng,
      s: Math.round(p.s), lateral: Math.round(p.dist),
      side: p.dist < 4 ? 'ahead' : p.cross > 0 ? 'left' : 'right',
      stop: near ? near.n : null, kind: kindOf(t), score: scoreOf(t),
    };
    const k = cand.name.toLowerCase();
    const prev = seen.get(k);
    if (!prev || cand.score > prev.score) seen.set(k, cand); // a place is often both a node and a way
  }
  return [...seen.values()];
}

// The rule that decides what's shown: notable enough, best first, spaced out along the route.
function chooseLandmarks(cands, minScore) {
  const eligible = cands
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.lateral - b.lateral);
  const chosen = [];
  for (const c of eligible) {
    if (chosen.length >= MAX_CARDS) break;
    if (chosen.some((o) => Math.abs(o.s - c.s) < MIN_SPACING_M)) continue;
    chosen.push(c);
  }
  return chosen.sort((a, b) => a.s - b.s);
}

// ---------- 2. real descriptions + photos (Wikipedia / Commons) ----------
async function wikiEnrich(cands) {
  const byTitle = new Map();
  for (const c of cands) {
    const w = c.tags.wikipedia;
    if (w && /^en:/.test(w)) {
      const title = w.slice(3);
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push(c);
    }
  }
  if (!byTitle.size) return;
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    prop: 'extracts|pageimages|description', exintro: '1', explaintext: '1', exsentences: '2',
    piprop: 'thumbnail', pithumbsize: '800', redirects: '1',
    titles: [...byTitle.keys()].slice(0, 20).join('|'),
  });
  const r = await fetchWithTimeout('https://en.wikipedia.org/w/api.php?' + params.toString(), {}, 8000);
  if (!r.ok) return;
  const q = (await r.json()).query || {};
  const norm = {};
  (q.normalized || []).forEach((n) => (norm[n.from] = n.to));
  const redir = {};
  (q.redirects || []).forEach((n) => (redir[n.from] = n.to));
  const pages = {};
  Object.values(q.pages || {}).forEach((p) => {
    if (p.missing === undefined) pages[p.title] = p;
  });
  for (const [title, group] of byTitle) {
    const p = pages[redir[norm[title] || title] || norm[title] || title];
    if (!p) continue;
    for (const c of group) c.wiki = { extract: p.extract || '', description: p.description || '', photo: p.thumbnail ? p.thumbnail.source : null };
  }
}

const NAME_STOP = new Set(['street', 'avenue', 'park', 'square', 'building', 'house', 'center', 'philadelphia', 'church', 'market', 'the', 'and']);

// For places with no photo yet: the nearest Wikipedia article whose title shares a
// distinctive word with the place's name (so we never show a confidently wrong picture).
async function geoPhoto(c) {
  const tokens = c.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !NAME_STOP.has(w));
  if (!tokens.length) return null;
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'geosearch',
    ggscoord: c.lat + '|' + c.lng, ggsradius: '150', ggslimit: '8',
    prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '800',
  });
  try {
    const r = await fetchWithTimeout('https://en.wikipedia.org/w/api.php?' + params.toString(), {}, 6000);
    if (!r.ok) return null;
    const pages = Object.values(((await r.json()).query || {}).pages || {});
    const hit = pages.find((p) => p.thumbnail && tokens.some((tk) => String(p.title).toLowerCase().includes(tk)));
    return hit ? hit.thumbnail.source : null;
  } catch (e) {
    return null;
  }
}

function photoFor(c) {
  const cm = c.tags.wikimedia_commons;
  if (cm && /^File:/i.test(cm)) {
    return { url: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(cm.replace(/^File:/i, '')) + '?width=800', credit: 'Wikimedia Commons' };
  }
  if (c.wiki && c.wiki.photo) return { url: c.wiki.photo, credit: 'Wikipedia' };
  return null;
}

// ---------- 3. Gemini: rewrite the description (never choose) ----------
function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(cleaned.slice(a, b + 1));
  } catch (e) {
    return null;
  }
}

// Words that may legitimately start or sit inside a rewritten sentence without being facts.
const SAFE_WORDS = new Set(['look', 'watch', 'notice', 'spot', 'keep', 'peek', 'see', 'you', 'your', 'this', 'that', 'here', 'the', 'its', 'it', 'a', 'an', 'and', 'for', 'with', 'if', 'on', 'in', 'at', 'one', 'built', 'home', 'known']);

// A rewrite may only contain facts the source description contains: every number
// must appear in the source, and every capitalised word after the first must too.
function isGrounded(sentence, source) {
  const src = source.toLowerCase();
  for (const n of sentence.match(/\d[\d,.]*/g) || []) {
    if (!src.includes(n.replace(/[.,]+$/, '').toLowerCase())) return false;
  }
  const words = sentence.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    if (/[.!?]$/.test(words[i - 1])) continue; // starts a new sentence: not evidence of a name
    const w = words[i].replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, '');
    if (w.length < 3 || w[0] !== w[0].toUpperCase() || w[0] === w[0].toLowerCase()) continue;
    if (SAFE_WORDS.has(w.toLowerCase())) continue;
    if (!src.includes(w.toLowerCase())) return false;
  }
  return true;
}

async function geminiRephrase(interestLabel, cards) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !cards.length) return null;
  const items = cards.map((c) => ({ id: c.key, name: c.name, kind: c.kind, description: c.desc }));
  const prompt =
    'You rewrite short factual descriptions of places for a bus rider. The rider\'s interest: "' + interestLabel + '".\n' +
    'For each place below write ONE friendly sentence (max 20 words) telling the rider what is worth noticing. Emphasise whatever in the ' +
    'description fits their interest; if nothing does, state the most interesting fact plainly. Use ONLY the given description: do not add ' +
    'any dates, numbers, names or claims that are not in it. No emoji, no quotation marks. You are rewriting, not choosing — write one sentence for every place.\n' +
    'Respond with ONLY JSON, no markdown: {"items":[{"id":"<id>","sentence":"<sentence>"}]}\n' +
    'Places: ' + JSON.stringify(items);
  const byId = new Map(cards.map((c) => [c.key, c]));
  for (const model of MODELS) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
      const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }, 16000);
      if (!r.ok) continue;
      const data = await r.json();
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      const parsed = extractJson(text);
      if (!parsed || !Array.isArray(parsed.items)) continue;
      const out = new Map();
      for (const it of parsed.items) {
        const c = it && byId.get(it.id);
        if (!c || typeof it.sentence !== 'string') continue;
        const s = it.sentence.trim().replace(/^"|"$/g, '');
        if (!s || s.length > 220) continue;
        if (!isGrounded(s, [c.name, c.kind, c.desc, c.stop || '', interestLabel].join(' '))) continue; // reject invented facts
        out.set(c.key, s);
      }
      return out;
    } catch (e) {
      /* try the next model */
    }
  }
  return null;
}

// ---------- handler ----------
module.exports = async (req, res) => {
  const q = req.query || {};
  const route = String(q.route || '').slice(0, 8);
  const dirId = Number(q.dir);
  const w = Number(q.w);
  const interest = String(q.interest || '');
  if (!route || !(dirId === 0 || dirId === 1) || !Number.isInteger(w) || w < 0 || w > 200 || !INTERESTS[interest]) {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  let doc;
  try {
    doc = await loadRoute(req, route);
  } catch (e) {
    doc = null;
  }
  const dir = doc && doc.dirs.find((d) => d.id === dirId);
  if (!dir) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'unknown route or direction' });
    return;
  }
  prepareDir(dir);

  const from = w * WINDOW_M;
  const to = Math.min(dir.cum[dir.cum.length - 1], from + WINDOW_M + OVERLAP_M);
  if (from >= dir.cum[dir.cum.length - 1] || to - from < 30) {
    res.setHeader('Cache-Control', 'public, s-maxage=' + CACHE_SECONDS);
    res.status(200).json({ cards: [], w, interest });
    return;
  }
  const pts = slicePath(dir, from, to);
  const stops = dir.stops.filter((s) => s.s >= from - 300 && s.s <= to + 300);

  let elements;
  try {
    elements = await overpass(buildQuery(interest, pts));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store'); // never cache a failure
    res.status(502).json({ error: 'landmark lookup failed', detail: String((e && e.message) || e) });
    return;
  }

  const cfg = INTERESTS[interest];
  const chosen = chooseLandmarks(toCandidates(elements, pts, from, to, stops), cfg.minScore);

  try {
    await wikiEnrich(chosen);
  } catch (e) {
    /* descriptions and photos are a bonus */
  }
  chosen.forEach((c) => (c.desc = describe(c)));

  const rewritten = await geminiRephrase(cfg.label, chosen); // Map(id -> sentence) or null

  const cards = await Promise.all(
    chosen.map(async (c) => {
      let photo = photoFor(c);
      if (!photo) {
        const url = await geoPhoto(c);
        if (url) photo = { url, credit: 'Wikipedia' };
      }
      const ai = !!(rewritten && rewritten.has(c.key));
      return {
        id: c.key, name: c.name, kind: c.kind, lat: c.lat, lng: c.lng,
        s: c.s, side: c.side, lateral: c.lateral, stop: c.stop,
        sentence: ai ? rewritten.get(c.key) : plainSentence(c.desc),
        ai, photo: photo ? photo.url : null, credit: photo ? photo.credit : null,
      };
    })
  );

  // If Gemini was expected but failed, this result is the plain-description fallback:
  // cache it only briefly so a good answer replaces it soon.
  const degraded = !!process.env.GEMINI_API_KEY && chosen.length > 0 && rewritten === null;
  res.setHeader('Cache-Control', degraded ? 'public, s-maxage=300' : 'public, s-maxage=' + CACHE_SECONDS + ', stale-while-revalidate=604800');
  res.status(200).json({ cards, w, interest });
};
