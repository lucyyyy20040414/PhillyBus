/* UI + flow:  ENTER ROUTE → CHOOSE DIRECTION → CHOOSE INTEREST → RIDE.
   The route's ordered stops come from data/routes/*.json (SEPTA's published schedule
   data, built offline — nothing live). To follow along, the rider picks their bus from
   SEPTA's live vehicle feed and the app tracks that bus's reported position along the
   route; no device location is used. Landmarks near the stops ahead come from
   /api/landmarks. All the "is a landmark coming up" logic lives in js/ride.js; this
   file only moves between screens and paints what the engine reports. */
(function () {
  var PB = window.PB;
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    routeForm: $('routeForm'), routeInput: $('routeInput'), routeBtn: $('routeBtn'), routeNote: $('routeNote'),
    dirBullet: $('dirBullet'), dirName: $('dirName'), dirList: $('dirList'), dirBack: $('dirBack'),
    interestBullet: $('interestBullet'), interestGrid: $('interestGrid'),
    ride: $('screenRide'), rideBullet: $('rideBullet'), rideDir: $('rideDir'), rideInterest: $('rideInterest'),
    soundBtn: $('soundBtn'), endRideBtn: $('endRideBtn'), locRoute: $('locRoute'),
    pickTitle: $('pickTitle'), pickNote: $('pickNote'), pickList: $('pickList'), pickRetry: $('pickRetry'),
    calmSub: $('calmSub'), rideNext: $('rideNext'),
    card: $('card'), cardPhoto: $('cardPhoto'), cardImg: $('cardImg'), cardNone: $('cardNone'), cardCredit: $('cardCredit'),
    look: $('look'), lookText: $('lookText'), cardName: $('cardName'), cardStop: $('cardStop'), cardKind: $('cardKind'),
    cardWhen: $('cardWhen'), cardWhy: $('cardWhy'), cardAi: $('cardAi')
  };

  var state = {
    route: '', doc: null, dir: null, interest: null,
    engine: null, vehTimer: null, simTimer: null,
    token: 0, lastCardId: null
  };
  var soundOn = true;
  try { soundOn = localStorage.getItem('pb.sound') !== 'off'; } catch (e) {}

  /* ---------- screens ---------- */
  var SCREENS = { route: 'screenRoute', dir: 'screenDir', interest: 'screenInterest', ride: 'screenRide' };
  function show(name) {
    document.body.dataset.screen = name;
    Object.keys(SCREENS).forEach(function (n) { $(SCREENS[n]).classList.toggle('active', n === name); });
    window.scrollTo(0, 0);
  }
  function setRideState(s) { if (el.ride.dataset.state !== s) el.ride.dataset.state = s; }
  function note(msg, isErr) {
    el.routeNote.textContent = msg || '';
    el.routeNote.classList.toggle('form-note--err', !!isErr);
  }

  /* ---------- 1 · route ---------- */
  // Resolves { doc } once the route's stops and shape are loaded, or false.
  function lookupRoute(raw) {
    var q = PB.route.normalize(raw);
    if (!q) { note('Type the number on the front of your bus.', true); return Promise.resolve(false); }
    el.routeBtn.disabled = true;
    note('Looking up Route ' + q + '…');
    return PB.route.lookup(q).then(function (info) {
      if (!info) {
        note("We couldn't find a SEPTA bus route \"" + q + '". Check the number on the front of the bus.', true);
        return false;
      }
      return PB.route.load(info).then(function (doc) {
        state.route = info.route;
        state.doc = doc;
        try { localStorage.setItem('pb.route', info.route); } catch (e) {}
        note('');
        return true;
      });
    }).catch(function () {
      note("Couldn't load that route just now. Try again in a moment.", true);
      return false;
    }).then(function (ok) { el.routeBtn.disabled = false; return ok; });
  }

  /* ---------- 2 · direction ---------- */
  var CARDINAL = { north: 0, east: 90, south: 180, west: 270 };
  function dirAngle(d) {
    var m = /^(north|east|south|west)/i.exec(d.label || '');
    if (m) return CARDINAL[m[1].toLowerCase()];
    var a = d.shape[0], b = d.shape[d.shape.length - 1];
    return PB.geo.bearing({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
  }
  function dirTitle(d) { return d.label || ('To ' + (d.to || d.headsign || 'end of line')); }

  function fillDirections() {
    el.dirBullet.textContent = state.route;
    el.dirName.textContent = state.doc.name || 'SEPTA Route ' + state.route;
    el.dirList.innerHTML = '';
    state.doc.dirs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dir-btn';
      b.innerHTML = '<span class="dir-btn__arrow" style="transform:rotate(' + Math.round(dirAngle(d) - 90) + 'deg)">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h17M13 5l7 7-7 7"/></svg></span>' +
        '<span class="dir-btn__txt"><strong></strong><span></span></span>';
      b.querySelector('strong').textContent = dirTitle(d);
      b.querySelector('.dir-btn__txt span').textContent = d.label && d.to ? 'to ' + d.to : (d.stops.length + ' stops');
      b.addEventListener('click', function () { chooseDir(d); });
      el.dirList.appendChild(b);
    });
  }

  function chooseDir(d) {
    state.dir = d;
    buildInterests();
    el.interestBullet.textContent = state.route;
    show('interest');
  }

  // Straight from the route screen: one-direction routes skip the direction question.
  function afterRoute() {
    if (state.doc.dirs.length === 1) { chooseDir(state.doc.dirs[0]); return; }
    fillDirections();
    show('dir');
  }

  /* ---------- 3 · interest ---------- */
  function buildInterests() {
    if (el.interestGrid.children.length) return;
    PB.INTERESTS.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.style.setProperty('--c', it.color);
      b.innerHTML = it.icon + '<span>' + it.label + '</span>';
      b.addEventListener('click', function () { chooseInterest(it.key); });
      el.interestGrid.appendChild(b);
    });
  }

  function chooseInterest(key, simFrom) {
    var it = PB.interestByKey(key);
    if (!it) return;
    state.interest = it;
    document.documentElement.style.setProperty('--accent', it.color);
    unlockAudio(); // this tap is the user gesture that lets the chime play later
    el.rideBullet.textContent = state.route;
    el.locRoute.textContent = 'Route ' + state.route;
    el.rideInterest.textContent = it.label;
    el.rideDir.textContent = dirTitle(state.dir) + (state.dir.label && state.dir.to ? ' · to ' + state.dir.to : '');
    el.rideNext.textContent = state.doc.name || 'Route ' + state.route;
    el.cardNone.innerHTML = it.icon;
    show('ride');
    if (simFrom !== undefined) startSimulated(simFrom); else startLocating();
  }

  /* ---------- 4 · ride: follow the rider's bus along the route ---------- */
  function stopTracking() {
    state.token++;
    if (state.engine) { state.engine.stop(); state.engine = null; }
    clearInterval(state.vehTimer); state.vehTimer = null;
    clearInterval(state.simTimer); state.simTimer = null;
    state.lastCardId = null;
  }

  function newEngine() {
    return PB.ride.start({ route: state.route, dir: state.dir, interest: state.interest.key, onFrame: onFrame });
  }

  // Let the rider pick their bus from SEPTA's live list for this direction.
  function startLocating() {
    stopTracking();
    setRideState('locating');
    var token = state.token;
    PB.septa.vehicles(state.route).then(function (vs) { return { vs: vs }; }, function () { return { vs: [], failed: true }; })
      .then(function (r) {
        if (token !== state.token) return; // rider ended the ride or started over
        var mine = r.vs.filter(function (v) {
          var sn = PB.route.snap(state.dir, v.lat, v.lng, null);
          if (!sn || sn.dist > 100) return false;
          v.snapS = sn.s;
          return v.heading === null || PB.geo.angleDiff(v.heading, sn.bearing) <= 90;
        });
        showPicker(mine, r.failed ? "Couldn't reach SEPTA just now." : !mine.length ? 'No Route ' + state.route + ' ' + (state.dir.label || 'buses') + ' are reporting right now.' : '');
      });
  }

  function showPicker(vs, message) {
    el.pickTitle.textContent = vs.length ? 'Pick your bus' : 'No bus yet';
    el.pickNote.textContent = message || '';
    el.pickList.innerHTML = '';
    vs.slice().sort(function (a, b) { return a.snapS - b.snapS; }).slice(0, 8).forEach(function (v) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-btn';
      var ns = PB.route.nextStop(state.dir, v.snapS);
      var strong = document.createElement('strong');
      strong.textContent = 'Bus ' + v.label;
      var span = document.createElement('span');
      span.textContent = ns ? 'Next stop · ' + ns.n : 'Near the end of the line';
      b.appendChild(strong); b.appendChild(span);
      b.addEventListener('click', function () { trackVehicle(v); });
      li.appendChild(b);
      el.pickList.appendChild(li);
    });
    setRideState('pick');
  }

  function trackVehicle(v) {
    var token = state.token;
    var lastTs = null, misses = 0;
    setRideState('calm');
    el.calmSub.textContent = 'Watching the road ahead.';
    state.engine = newEngine();
    state.engine.feed({ lat: v.lat, lng: v.lng, speed: null });
    lastTs = v.ts;
    state.vehTimer = setInterval(function () {
      PB.septa.vehicles(state.route).then(function (list) {
        if (token !== state.token || !state.engine) return;
        var cur = null;
        for (var i = 0; i < list.length; i++) if (list[i].id === v.id) { cur = list[i]; break; }
        if (!cur) { if (++misses >= 3) startLocating(); return; }
        misses = 0;
        if (cur.ts !== lastTs) { lastTs = cur.ts; state.engine.feed({ lat: cur.lat, lng: cur.lng, speed: null }); } // only real new reports
      }).catch(function () {});
    }, 10000);
    keepAwake();
  }

  // Demo/testing: ?sim=<meters along the route> rides a pretend bus from that point at ~27 mph.
  function pointAt(dir, m) {
    var cum = dir.cum, i = 0;
    m = Math.max(0, Math.min(cum[cum.length - 1], m));
    while (i < cum.length - 2 && cum[i + 1] < m) i++;
    var span = cum[i + 1] - cum[i], t = span > 0 ? (m - cum[i]) / span : 0;
    var a = dir.shape[i], b = dir.shape[i + 1];
    return { lat: a[0] + t * (b[0] - a[0]), lng: a[1] + t * (b[1] - a[1]) };
  }
  function startSimulated(fromM) {
    stopTracking();
    setRideState('calm');
    el.calmSub.textContent = 'Demo ride.';
    state.engine = newEngine();
    var m = fromM, V = 12;
    var step = function () {
      var p = pointAt(state.dir, m);
      state.engine.feed({ lat: p.lat, lng: p.lng, speed: V });
      m += V;
    };
    step();
    state.simTimer = setInterval(step, 1000);
  }

  /* ---------- painting engine frames ---------- */
  function onFrame(f) {
    el.rideNext.textContent = f.nextStop ? 'Next stop · ' + f.nextStop : (state.doc.name || 'Route ' + state.route);
    if (f.mode === 'card') {
      renderCard(f.card, f.fresh);
      setRideState('card');
    } else {
      el.calmSub.textContent = !f.hasFix ? 'Waiting for your bus’s next position…'
        : f.atEnd ? 'End of the line. Thanks for riding!'
        : f.offRoute ? "This bus looks to be off Route " + state.route + ' right now.'
        : f.stale ? 'Waiting for a position update…'
        : f.nextMin ? 'Next discovery in ~' + f.nextMin + ' min.'
        : f.loading ? 'Scanning ahead…'
        : 'Watching the road ahead.';
      setRideState('calm');
    }
  }

  function whenLabel(c) {
    if (c.distanceM < 40) return 'Right now';
    var s = Math.round(c.etaSec / 5) * 5;
    var t = s < 10 ? '~5 sec' : s < 90 ? '~' + s + ' sec' : '~' + Math.round(s / 60) + ' min';
    return t + ' · ' + PB.geo.feetLabel(c.distanceM);
  }

  function renderCard(c, fresh) {
    if (c.id !== state.lastCardId) {
      state.lastCardId = c.id;
      el.cardName.textContent = c.name;
      el.cardStop.textContent = c.stop ? 'By the ' + c.stop + ' stop' : '';
      el.cardKind.textContent = c.kind;
      el.cardWhy.textContent = c.sentence;
      el.cardAi.hidden = !c.ai;
      el.cardImg.onerror = function () { el.cardPhoto.classList.add('no-photo'); };
      if (c.photo) {
        el.cardPhoto.classList.remove('no-photo');
        el.cardImg.src = c.photo;
        el.cardCredit.textContent = 'Photo: ' + (c.credit || 'Wikipedia');
      } else {
        el.cardPhoto.classList.add('no-photo');
        el.cardImg.removeAttribute('src');
      }
      el.card.classList.remove('pop');
      void el.card.offsetWidth; // restart the pop-in animation
      el.card.classList.add('pop');
    }
    el.look.className = 'look look--' + c.side;
    el.lookText.textContent = 'LOOK ' + c.side.toUpperCase();
    el.cardWhen.textContent = whenLabel(c);
    if (fresh) alertRider();
  }

  /* ---------- nudge: chime + buzz ---------- */
  var audioCtx = null;
  function unlockAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  function tone(freq, start, dur) {
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.25, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(start); o.stop(start + dur + 0.05);
  }
  function alertRider() {
    // browsers only allow vibration after the page has been tapped at least once
    var tapped = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (navigator.vibrate && tapped) navigator.vibrate([140, 70, 140]);
    if (soundOn && audioCtx && audioCtx.state === 'running') {
      var t = audioCtx.currentTime + 0.02;
      tone(880, t, 0.28);
      tone(1318.5, t + 0.16, 0.45);
    }
  }

  var ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.500 9a4 4 0 0 1 0 6M19 6.500a8 8 0 0 1 0 11"/></svg>';
  var ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.500l5 5M22 9.500l-5 5"/></svg>';
  function paintSound() {
    el.soundBtn.innerHTML = soundOn ? ICON_ON : ICON_OFF;
    el.soundBtn.setAttribute('aria-pressed', String(soundOn));
    el.soundBtn.setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
  }
  el.soundBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    try { localStorage.setItem('pb.sound', soundOn ? 'on' : 'off'); } catch (e) {}
    if (soundOn) unlockAudio();
    paintSound();
  });

  /* ---------- keep the screen awake while riding ---------- */
  var wake = null;
  function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wake) {
        navigator.wakeLock.request('screen').then(function (l) {
          wake = l;
          l.addEventListener('release', function () { wake = null; });
        }).catch(function () {});
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && document.body.dataset.screen === 'ride') keepAwake();
  });

  /* ---------- end / back ---------- */
  function endRide() {
    stopTracking();
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
    show('route');
  }

  /* ---------- wiring ---------- */
  el.routeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    lookupRoute(el.routeInput.value).then(function (ok) { if (ok) afterRoute(); });
  });
  el.dirBack.addEventListener('click', function () { show('route'); el.routeInput.focus(); });
  el.endRideBtn.addEventListener('click', endRide);
  el.pickRetry.addEventListener('click', startLocating);

  paintSound();

  // Deep links for demos: ?route=42 pre-fills; add &dir=0&interest=food to jump into the ride;
  // add &sim=9500 to ride a pretend bus from 9,500 m along the route (no GPS needed).
  var qs = new URLSearchParams(location.search);
  var qRoute = qs.get('route'), qDir = qs.get('dir'), qInterest = qs.get('interest'), qSim = qs.get('sim');
  if (qRoute) {
    el.routeInput.value = qRoute;
    lookupRoute(qRoute).then(function (ok) {
      if (!ok) return;
      var d = qDir !== null ? state.doc.dirs.filter(function (x) { return String(x.id) === qDir; })[0] : null;
      if (d && PB.interestByKey(qInterest)) {
        chooseDir(d);
        var sim = qSim !== null && isFinite(Number(qSim)) ? Number(qSim) : undefined;
        chooseInterest(qInterest, sim);
      } else if (d) chooseDir(d);
      else afterRoute();
    });
  } else {
    try { var last = localStorage.getItem('pb.route'); if (last) el.routeInput.value = last; } catch (e) {}
  }
})();
