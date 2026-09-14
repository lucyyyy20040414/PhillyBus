/* ============================================================
   Mock AI intent-interpretation layer.
   interpretTravelIntent(text) turns messy human travel language
   ("I'm late for class at Drexel") into the structured constraints
   the trip planner needs. No LLM is wired in here — the interface
   is deliberately shaped so a real one can be dropped in later
   (see the block comment at the bottom): swap this function's body
   for a call to a server route that asks an LLM for the same JSON
   shape, keep the trip-planning module untouched.

   This layer NEVER invents transit facts (routes, stops, times) —
   it only extracts what the RIDER meant. Everything transit-related
   is resolved separately in js/trip.js from live SEPTA data.
   ============================================================ */
(function(){
  window.PB = window.PB || {};

  var URGENT_WORDS = ['late', 'asap', 'hurry', 'urgent', 'right now', 'quickly', 'fast as possible', "can't be late", 'running late'];
  var LOW_WALK_WORDS = ["don't want to walk", "dont want to walk", "no walking", "not walk far", "hate walking", "can't walk far", "cant walk far", "minimal walk", "don't want to walk far", "avoid walking"];
  var HIGH_WALK_WORDS = ["don't mind walking", "dont mind walking", "happy to walk", "walk far", "love walking"];
  var ACCESSIBILITY_WORDS = [
    { words: ['wheelchair', 'ramp'], tag: 'wheelchair' },
    { words: ['cane', 'walker', 'mobility'], tag: 'mobility-aid' },
    { words: ['stroller'], tag: 'stroller' }
  ];

  function makeTimeToday(hour24, minute){
    var d = new Date();
    d.setHours(hour24, minute || 0, 0, 0);
    return d;
  }

  function resolveDeadline(hour, minute, meridiem){
    var now = new Date();
    var amCandidate = makeTimeToday(hour % 12, minute);
    var pmCandidate = makeTimeToday((hour % 12) + 12, minute);
    var candidates = meridiem === 'am' ? [amCandidate] : meridiem === 'pm' ? [pmCandidate] : [amCandidate, pmCandidate];

    var future = candidates.filter(function(d){ return d.getTime() > now.getTime(); });
    future.sort(function(a, b){ return a - b; });
    if(future.length) return future[0];

    // Every candidate for today has already passed — roll to tomorrow.
    // With no explicit am/pm, guess by what's typical for a travel
    // deadline: "before 5" usually means 5pm, "before 8" usually means
    // 8am/class time. The boundary is a judgment call, not a fact.
    var preferred;
    if(meridiem === 'am') preferred = amCandidate;
    else if(meridiem === 'pm') preferred = pmCandidate;
    else preferred = (hour >= 1 && hour <= 7) ? pmCandidate : amCandidate;
    var d = new Date(preferred.getTime());
    d.setDate(d.getDate() + 1);
    return d;
  }

  function extractDeadline(text){
    var m = text.match(/\b(?:before|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if(!m) return null;
    var hour = parseInt(m[1], 10);
    var minute = m[2] ? parseInt(m[2], 10) : 0;
    var meridiem = m[3] ? m[3].toLowerCase() : null;
    if(hour < 1 || hour > 12) return null;
    return resolveDeadline(hour, minute, meridiem);
  }

  function extractMaxWalkingMinutes(text){
    var m = text.match(/(\d{1,2})\s*min\w*\s*(?:of\s*)?walk/i) || text.match(/walk\w*\s*(?:of\s*)?(\d{1,2})\s*min/i);
    if(m) return parseInt(m[1], 10);
    return null;
  }

  function containsAny(text, words){
    for(var i = 0; i < words.length; i++){
      if(text.indexOf(words[i]) > -1) return true;
    }
    return false;
  }

  function matchDestination(text){
    var best = null, bestScore = 0, bestLen = 0;
    window.PB.GAZETTEER.forEach(function(dest){
      var score = 0, len = 0;
      var allPhrases = dest.keywords.concat([dest.name.toLowerCase()]);
      allPhrases.forEach(function(phrase){
        if(text.indexOf(phrase) > -1){
          score += 1;
          len = Math.max(len, phrase.length);
        }
      });
      if(score > bestScore || (score === bestScore && len > bestLen)){
        best = dest; bestScore = score; bestLen = len;
      }
    });
    if(!best || bestScore === 0) return { dest: null, confidence: 0 };
    var confidence = bestLen >= best.name.length * 0.6 ? 0.93 : Math.min(0.85, 0.55 + 0.15 * bestScore);
    return { dest: best, confidence: confidence };
  }

  function formatTime(d){
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if(h12 === 0) h12 = 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  function interpretTravelIntent(rawText){
    var text = String(rawText || '').toLowerCase().trim();

    var match = matchDestination(text);
    var urgency = containsAny(text, URGENT_WORDS) ? 'high' : 'normal';
    var deadline = extractDeadline(text);
    var explicitWalkCap = extractMaxWalkingMinutes(text);
    var lowWalk = containsAny(text, LOW_WALK_WORDS);
    var highWalk = containsAny(text, HIGH_WALK_WORDS);
    var maxWalkingMinutes = explicitWalkCap !== null ? explicitWalkCap : (lowWalk ? 5 : null);

    var priority = 'fastest';
    if(deadline) priority = 'arrive_by_deadline';
    else if(lowWalk && !highWalk) priority = 'minimize_walking';
    else if(urgency === 'high') priority = 'fastest';

    var accessibilityNeeds = [];
    ACCESSIBILITY_WORDS.forEach(function(group){
      if(containsAny(text, group.words)) accessibilityNeeds.push(group.tag);
    });

    var contextParts = [];
    if(match.dest) contextParts.push('Heading to ' + match.dest.name + '.');
    if(urgency === 'high') contextParts.push("You're in a hurry.");
    if(deadline) contextParts.push('Aiming to arrive by ' + formatTime(deadline) + '.');
    if(lowWalk) contextParts.push('Keeping the walk short.');
    else if(highWalk) contextParts.push("A longer walk is fine.");

    return {
      destinationName: match.dest ? match.dest.name : '',
      destinationCoordinates: match.dest ? { lat: match.dest.lat, lng: match.dest.lng } : { lat: null, lng: null },
      destinationType: match.dest ? match.dest.type : '',
      arrivalDeadline: deadline,
      urgency: urgency,
      maxWalkingMinutes: maxWalkingMinutes,
      priority: priority,
      accessibilityNeeds: accessibilityNeeds,
      inferredContext: contextParts.join(' '),
      confidence: match.dest ? match.confidence : 0,
      _destinationId: match.dest ? match.dest.id : null
    };
  }

  window.PB.interpretTravelIntent = interpretTravelIntent;
  window.PB.formatTime = formatTime;

  /* ------------------------------------------------------------
     To swap in a real LLM later:
     1. Add a server route (e.g. /api/interpret) that sends the
        rider's text to an LLM with a structured-output / JSON
        schema matching the object this function returns, and
        holds the API key server-side only.
     2. Replace the body of interpretTravelIntent with:
          return fetch('/api/interpret', {method:'POST', body: ...})
            .then(r => r.json());
        (making it async — callers in trip.js already treat the
        result as a value to pass forward, so wrap call sites in
        Promise.resolve(...).then(...) when you make this change.)
     3. Leave js/gazetteer.js and js/trip.js untouched — they only
        consume the structured shape, never the raw text.
     ------------------------------------------------------------ */
})();
