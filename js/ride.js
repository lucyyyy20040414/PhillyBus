/* Ride engine: knows where the rider is ALONG the chosen route and decides, second by
   second, whether there is a landmark worth interrupting them for.

   - Position: every GPS (or tracked-bus) fix is snapped onto the route's shape, giving
     `s`, meters travelled along it. Between fixes it is dead-reckoned from measured speed.
   - Landmarks: fetched from /api/landmarks one 1 km stretch of the route at a time (the
     stretch the rider is in and the next one). The server picks them with fixed rules;
     an AI only rewrites each one's description.
   - Distance, ETA and which stop it is by are plain arithmetic on `s`. LEFT/RIGHT is worked
     out on the server from the route's own geometry and never changes as the bus moves. */
(function () {
  window.PB = window.PB || {};

  var WINDOW_M = 1000;       // must match WINDOW_M in api/landmarks.js
  var SHOW_WITHIN_M = 380;   // surface a card when a landmark is this close ahead
  var PASSED_M = -40;        // ...and retire it once it's this far behind
  var CARD_MAX_MS = 150000;
  var OFF_ROUTE_M = 150;     // farther than this from the route: not on it (yet)
  var STALE_MS = 75000;      // no fix for this long: say so instead of guessing
  var MIN_SPEED = 3;         // m/s floor for ETA math (avoids divide-by-~0 at a stop)
  var DEFAULT_SPEED = 5;     // ~11 mph city bus, until we've measured better
  var RETRY_MS = 20000;
  var FETCH_TIMEOUT_MS = 28000;

  function fetchWindow(route, dirId, w, interest) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS);
    var url = '/api/landmarks?route=' + encodeURIComponent(route) + '&dir=' + dirId + '&w=' + w + '&interest=' + encodeURIComponent(interest);
    return fetch(url, { signal: ctl.signal }).then(function (r) {
      if (!r.ok) throw new Error('landmarks ' + r.status);
      return r.json();
    }).then(function (d) { clearTimeout(timer); return d; },
            function (e) { clearTimeout(timer); throw e; });
  }

  // opts: { route, dir (prepared route direction), interest, onFrame(frame) }
  function start(opts) {
    var dir = opts.dir;
    var routeLen = dir.cum[dir.cum.length - 1];
    var maxWindow = Math.floor(routeLen / WINDOW_M);
    var s = {
      pos: null,            // { s, speed, rx }
      lastFix: 0, off: false,
      windows: {},          // w -> { state: 'pending' | 'done', retryAt }
      queue: {}, shown: {}, active: null, activeSince: 0,
      inflight: false, stopped: false, tickTimer: null
    };

    function feed(fix) {
      if (s.stopped) return;
      var sn = window.PB.route.snap(dir, fix.lat, fix.lng, s.pos ? s.pos.s : null);
      if (!sn) return;
      var now = Date.now();
      s.lastFix = now;
      if (sn.dist > OFF_ROUTE_M) { s.off = true; return; }
      s.off = false;
      if (!s.pos) {
        s.pos = { s: sn.s, speed: DEFAULT_SPEED, rx: now };
        return;
      }
      var dt = (now - s.pos.rx) / 1000;
      var ds = sn.s - s.pos.s;
      var sp = typeof fix.speed === 'number' && fix.speed >= 0 ? fix.speed : (dt > 1 ? Math.max(0, ds) / dt : s.pos.speed);
      if (sp <= 25) s.pos.speed = 0.5 * s.pos.speed + 0.5 * sp;
      if (!(ds < 0 && ds > -40)) s.pos.s = sn.s; // ignore small backward GPS jitter
      s.pos.rx = now;
    }

    function currentS(now) {
      var dt = Math.min(40, Math.max(0, (now - s.pos.rx) / 1000));
      var moving = s.pos.speed >= 1;
      return Math.min(routeLen, s.pos.s + (moving ? s.pos.speed * dt : 0));
    }

    function loadWindows(cs, now) {
      if (s.inflight) return;
      var w = Math.floor(cs / WINDOW_M);
      for (var k = w; k <= Math.min(w + 1, maxWindow); k++) {
        var st = s.windows[k];
        if (st && (st.state === 'done' || now < st.retryAt)) continue;
        request(k, cs);
        return;
      }
    }

    function request(w, cs) {
      s.inflight = true;
      s.windows[w] = { state: 'pending', retryAt: 0 };
      fetchWindow(opts.route, dir.id, w, opts.interest).then(function (d) {
        s.windows[w] = { state: 'done', retryAt: 0 };
        var cur = s.pos ? currentS(Date.now()) : cs;
        (d.cards || []).forEach(function (c) {
          if (s.shown[c.id] || s.queue[c.id]) return; // neighbouring stretches overlap; keep one copy
          if (c.s - cur < PASSED_M) return;           // already behind us by the time it arrived
          s.queue[c.id] = c;
          if (c.photo) { var img = new Image(); img.src = c.photo; } // preload so the card appears instantly
        });
      }).catch(function () {
        s.windows[w] = { state: 'failed', retryAt: Date.now() + RETRY_MS };
      }).then(function () { s.inflight = false; });
    }

    function tick() {
      if (s.stopped) return;
      var now = Date.now();
      var frame = {
        mode: 'calm', fresh: false, card: null,
        hasFix: !!s.pos, offRoute: s.off, stale: !!s.pos && now - s.lastFix > STALE_MS,
        atEnd: false, nextStop: null, nextMin: null, loading: s.inflight
      };
      if (!s.pos) { opts.onFrame(frame); return; }

      var cs = currentS(now);
      var speed = Math.max(s.pos.speed, MIN_SPEED);
      var ns = window.PB.route.nextStop(dir, cs);
      frame.nextStop = ns ? ns.n : null;
      frame.atEnd = routeLen - cs < 60;
      if (!s.off && !frame.stale) loadWindows(cs, now);

      Object.keys(s.queue).forEach(function (id) {
        var c = s.queue[id];
        c.along = c.s - cs;
        if (c.along < PASSED_M) {
          s.shown[id] = true;
          delete s.queue[id];
          if (s.active && s.active.id === id) s.active = null;
        }
      });

      if (s.active && now - s.activeSince > CARD_MAX_MS) {
        s.shown[s.active.id] = true;
        delete s.queue[s.active.id];
        s.active = null;
      }
      if (!s.active) {
        var next = null;
        Object.keys(s.queue).forEach(function (id) {
          var c = s.queue[id];
          if (c.along <= SHOW_WITHIN_M && c.along >= -25 && (!next || c.along < next.along)) next = c;
        });
        if (next) { s.active = next; s.activeSince = now; s.shown[next.id] = true; frame.fresh = true; }
      }

      var nextEta = null;
      Object.keys(s.queue).forEach(function (id) {
        var c = s.queue[id];
        if (s.active && s.active.id === id) return;
        var eta = Math.max(0, c.along) / speed;
        if (nextEta === null || eta < nextEta) nextEta = eta;
      });
      frame.nextMin = nextEta === null ? null : Math.max(1, Math.round(nextEta / 60));

      if (s.active) {
        var a = s.active;
        frame.mode = 'card';
        frame.card = {
          id: a.id, name: a.name, kind: a.kind, sentence: a.sentence, stop: a.stop,
          photo: a.photo, credit: a.credit, ai: a.ai, side: a.side,
          distanceM: Math.max(0, a.along), etaSec: Math.max(0, a.along) / speed
        };
      }
      opts.onFrame(frame);
    }

    s.tickTimer = setInterval(tick, 1000);
    tick();

    return {
      feed: feed,
      stop: function () { s.stopped = true; clearInterval(s.tickTimer); },
      position: function () { return s.pos ? currentS(Date.now()) : null; }
    };
  }

  window.PB.ride = { start: start };
})();
