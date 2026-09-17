(function(){
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ============================================================
  // SEPTA live data layer
  //
  // SEPTA's public API (https://www3.septa.org/developer/) has no
  // endpoint for "look up a stop by name" or "predicted arrival at a
  // bus stop" — only live vehicle positions (TransitView), each with
  // the vehicle's *next* stop name + a numeric stop sequence. There's
  // no documented CORS support either (SEPTA's own dev forum points
  // people at JSONP instead), so every call here goes through a
  // JSONP <script> tag, not fetch().
  //
  // Because there's no full stop catalog to search, this app builds
  // one itself, live: every vehicle currently running a route reports
  // {sequence, name} for whatever stop it's about to hit. Poll enough
  // vehicles over enough time and you get a real, honest map of that
  // route's stops — with no invented stop IDs.
  // ============================================================

  var TRANSITVIEW_URL = 'https://www3.septa.org/api/TransitView/index.php';
  var BUSDETOURS_URL = 'https://www3.septa.org/api/BusDetours/index.php';
  var POLL_MS = 12000;
  var JSONP_TIMEOUT_MS = 9000;
  var AVG_SECS_PER_STOP = 110; // rough, labeled as an estimate everywhere it's shown

  function jsonp(url){
    return new Promise(function(resolve, reject){
      var cbName = 'septa_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var script = document.createElement('script');
      var done = false;
      var timer = setTimeout(function(){
        if(done) return;
        done = true;
        cleanup();
        reject(new Error('timeout'));
      }, JSONP_TIMEOUT_MS);

      function cleanup(){
        clearTimeout(timer);
        try{ delete window[cbName]; } catch(e){ window[cbName] = undefined; }
        if(script.parentNode) script.parentNode.removeChild(script);
      }
      window[cbName] = function(data){
        if(done) return;
        done = true;
        cleanup();
        resolve(data);
      };
      script.onerror = function(){
        if(done) return;
        done = true;
        cleanup();
        reject(new Error('network'));
      };
      var sep = url.indexOf('?') > -1 ? '&' : '?';
      script.src = url + sep + 'callback=' + cbName;
      document.head.appendChild(script);
    });
  }

  function normalizeVehicle(raw){
    var seq = parseInt(raw.next_stop_sequence, 10);
    var late = raw.late !== undefined && raw.late !== null && raw.late !== '' ? parseInt(raw.late, 10) : null;
    return {
      id: String(raw.VehicleID || raw.label || ''),
      label: raw.label || raw.VehicleID || '?',
      direction: raw.Direction || raw.direction || 'Unknown',
      destination: raw.destination || '',
      nextStopName: raw.next_stop_name || '',
      nextStopId: raw.next_stop_id || '',
      nextStopSeq: seq,
      late: isNaN(late) ? null : late,
      lat: parseFloat(raw.lat),
      lng: parseFloat(raw.lng)
    };
  }

  // discoveredStops[direction][sequence] = { name, id, lastSeen }
  var discoveredStops = {};
  function mergeDiscovered(vehicles){
    vehicles.forEach(function(v){
      if(!v.nextStopName || isNaN(v.nextStopSeq)) return;
      if(!discoveredStops[v.direction]) discoveredStops[v.direction] = {};
      discoveredStops[v.direction][v.nextStopSeq] = {
        name: v.nextStopName, id: v.nextStopId, lastSeen: Date.now()
      };
    });
  }
  function stopNameFor(direction, seq){
    var byDir = discoveredStops[direction];
    return (byDir && byDir[seq]) ? byDir[seq].name : null;
  }

  var live = {
    route: '21',
    vehicles: [],
    status: 'idle', // idle | loading | ok | empty | error
    lastUpdated: null,
    pollTimer: null,
    detourText: ''
  };

  function fetchTransitView(route){
    return jsonp(TRANSITVIEW_URL + '?route=' + encodeURIComponent(route)).then(function(data){
      var raw = (data && data.bus) ? data.bus : [];
      return raw.map(normalizeVehicle).filter(function(v){ return v.id; });
    });
  }
  function fetchDetours(route){
    return jsonp(BUSDETOURS_URL + '?route=' + encodeURIComponent(route))
      .then(function(data){
        // Response shape isn't fully documented; be defensive.
        var list = Array.isArray(data) ? data : (data && data.route_id ? [data] : []);
        if(!list.length) return '';
        var reasons = list.map(function(d){ return d.reason || d.route_direction || ''; }).filter(Boolean);
        return reasons.length ? ('Active detour on Route ' + route + ': ' + reasons[0]) : '';
      })
      .catch(function(){ return ''; }); // detours are a nice-to-have, never block on them
  }

  function refreshLive(){
    live.status = live.vehicles.length ? live.status : 'loading';
    renderStatus();
    fetchTransitView(live.route).then(function(vehicles){
      live.vehicles = vehicles;
      mergeDiscovered(vehicles);
      live.status = vehicles.length ? 'ok' : 'empty';
      live.lastUpdated = Date.now();
      renderStatus();
      renderSuggestions();
      if(state.tracking) updateTracking();
    }).catch(function(){
      live.status = 'error';
      renderStatus();
    });
    fetchDetours(live.route).then(function(text){
      live.detourText = text;
      renderDetour();
    });
  }

  function startPolling(){
    stopPolling();
    refreshLive();
    live.pollTimer = setInterval(refreshLive, POLL_MS);
  }
  function stopPolling(){
    if(live.pollTimer){ clearInterval(live.pollTimer); live.pollTimer = null; }
  }

  // ---------- Alarm sound (Web Audio) ----------
  var audioCtx = null;
  var activeAlarmNodes = [];
  function ensureAudioCtx(){
    var AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    if(!audioCtx){
      try{ audioCtx = new AC(); } catch(e){ return null; }
    }
    if(audioCtx.state === 'suspended'){
      audioCtx.resume().catch(function(){});
    }
    return audioCtx;
  }
  function playBeep(ctx, startTime, duration, freq){
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.16, startTime + 0.02);
    gain.gain.setValueAtTime(0.16, Math.max(startTime + 0.02, startTime + duration - 0.03));
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
    activeAlarmNodes.push(osc);
    osc.addEventListener('ended', function(){
      var idx = activeAlarmNodes.indexOf(osc);
      if(idx > -1) activeAlarmNodes.splice(idx, 1);
    });
  }
  function playAlarm(){
    var ctx = ensureAudioCtx();
    if(!ctx) return;
    var now = ctx.currentTime + 0.03;
    var pulseGap = 0.7;
    for(var i=0;i<3;i++){
      var t = now + i * pulseGap;
      playBeep(ctx, t, 0.16, 880);
      playBeep(ctx, t + 0.2, 0.16, 660);
    }
  }
  function stopAlarm(){
    activeAlarmNodes.forEach(function(osc){ try{ osc.stop(); } catch(e){} });
    activeAlarmNodes = [];
  }

  var el = {
    topbar: document.getElementById('topbar'),
    trackFill: document.getElementById('trackFill'),
    trackStops: document.getElementById('trackStops'),
    trackBus: document.getElementById('trackBus'),
    liveRouteName: document.getElementById('liveRouteName'),
    liveEta: document.getElementById('liveEta'),
    endTripBtn: document.getElementById('endTripBtn'),

    routeInput: document.getElementById('routeInput'),
    liveStatus: document.getElementById('liveStatus'),
    detourBanner: document.getElementById('detourBanner'),

    searchInput: document.getElementById('searchInput'),
    micBtn: document.getElementById('micBtn'),
    voiceNote: document.getElementById('voiceNote'),
    suggLabel: document.getElementById('suggLabel'),
    suggList: document.getElementById('suggList'),
    confirmBtn: document.getElementById('confirmBtn'),

    panelSearch: document.getElementById('panelSearch'),
    panelConfirm: document.getElementById('panelConfirm'),
    panelProgress: document.getElementById('panelProgress'),

    tripStop: document.getElementById('tripStop'),
    tripVehicle: document.getElementById('tripVehicle'),
    tripLive: document.getElementById('tripLive'),
    startTripBtn: document.getElementById('startTripBtn'),
    changeDestBtn: document.getElementById('changeDestBtn'),

    progressHeading: document.getElementById('progressHeading'),
    stoplist: document.getElementById('stoplist'),
    cancelTripBtn: document.getElementById('cancelTripBtn'),

    alertOverlay: document.getElementById('alertOverlay'),
    alertStop: document.getElementById('alertStop'),
    keepTrackingBtn: document.getElementById('keepTrackingBtn'),
    endFromAlertBtn: document.getElementById('endFromAlertBtn'),

    resetDemoBtn: document.getElementById('resetDemoBtn')
  };

  var state = {
    selected: null,   // { name, direction, seq }
    tracking: null,   // { name, direction, seq, startSeq, vehicleId, lost }
    animId: null,
    animToken: 0
  };

  // ---------- Live status / detour UI ----------
  function renderStatus(){
    var txt;
    if(live.status === 'loading') txt = 'Connecting to SEPTA…';
    else if(live.status === 'error') txt = 'Couldn’t reach SEPTA’s live data — retrying…';
    else if(live.status === 'empty') txt = 'No buses currently reporting on Route ' + live.route;
    else if(live.status === 'ok') txt = 'Live · Route ' + live.route + ' · ' + live.vehicles.length + ' bus' + (live.vehicles.length === 1 ? '' : 'es') + ' reporting';
    else txt = '';
    el.liveStatus.textContent = txt;
    el.liveStatus.classList.toggle('err', live.status === 'error');
  }
  function renderDetour(){
    if(live.detourText){
      el.detourBanner.textContent = live.detourText;
      el.detourBanner.hidden = false;
    } else {
      el.detourBanner.hidden = true;
    }
  }

  // ---------- Search / suggestions (built from live SEPTA data) ----------
  function collectStops(){
    var out = [];
    Object.keys(discoveredStops).forEach(function(direction){
      var seqs = discoveredStops[direction];
      Object.keys(seqs).forEach(function(seqStr){
        var seq = parseInt(seqStr, 10);
        var entry = seqs[seqStr];
        var approachingVehicle = nearestApproachingVehicle(direction, seq);
        out.push({
          name: entry.name,
          direction: direction,
          seq: seq,
          approaching: !!approachingVehicle,
          etaMin: approachingVehicle ? Math.max(1, Math.round(((seq - approachingVehicle.nextStopSeq) * AVG_SECS_PER_STOP) / 60)) : null
        });
      });
    });
    out.sort(function(a, b){
      if(a.approaching !== b.approaching) return a.approaching ? -1 : 1;
      if(a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
      return a.seq - b.seq;
    });
    return out;
  }
  function nearestApproachingVehicle(direction, targetSeq){
    var best = null, bestGap = Infinity;
    live.vehicles.forEach(function(v){
      if(v.direction !== direction) return;
      var gap = targetSeq - v.nextStopSeq;
      if(gap >= 0 && gap < bestGap){ bestGap = gap; best = v; }
    });
    return best;
  }

  function renderSuggestions(){
    var q = el.searchInput.value.trim().toLowerCase();
    var all = collectStops();
    var filtered = q ? all.filter(function(s){ return s.name.toLowerCase().indexOf(q) > -1; }) : all;
    el.suggLabel.textContent = 'Live stops on Route ' + live.route + (filtered.length ? '' : ' — none yet');

    el.suggList.innerHTML = '';
    if(filtered.length === 0){
      var li = document.createElement('li');
      var msg = live.status === 'loading' || live.status === 'idle'
        ? 'Loading live stops from SEPTA…'
        : (q ? 'No live stop matches “' + q + '” yet — try a shorter cross-street, or wait for more buses to report.'
              : 'No stops discovered yet for Route ' + live.route + ' — give it a few seconds.');
      li.innerHTML = '<div class="no-match">' + msg + '</div>';
      el.suggList.appendChild(li);
      return;
    }
    filtered.slice(0, 25).forEach(function(s){
      var li = document.createElement('li');
      var pressed = state.selected && state.selected.name === s.name && state.selected.direction === s.direction;
      var sub = s.direction + (s.approaching ? ' · next bus ~' + s.etaMin + ' min (est.)' : ' · no bus approaching right now');
      li.innerHTML =
        '<button class="sugg-btn" aria-pressed="' + (pressed ? 'true' : 'false') + '">' +
          '<span class="sugg-ico"><span class="live-dot ' + (s.approaching ? 'on' : '') + '"></span></span>' +
          '<span class="sugg-text"><strong>' + escapeHtml(s.name) + '</strong><span>' + escapeHtml(sub) + '</span></span>' +
        '</button>';
      li.querySelector('button').addEventListener('click', function(){
        state.selected = { name: s.name, direction: s.direction, seq: s.seq };
        el.confirmBtn.disabled = false;
        renderSuggestions();
      });
      el.suggList.appendChild(li);
    });
  }
  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  el.searchInput.addEventListener('input', renderSuggestions);
  el.routeInput.addEventListener('change', function(){
    var v = el.routeInput.value.trim();
    if(!v) v = '21';
    live.route = v;
    discoveredStops = {};
    state.selected = null;
    el.confirmBtn.disabled = true;
    el.searchInput.value = '';
    startPolling();
  });

  // ---------- Voice search (Web Speech API) ----------
  function matchStopFromSpeech(transcript){
    var q = transcript.toLowerCase().trim();
    var all = collectStops();
    var i, s;
    for(i=0;i<all.length;i++){
      s = all[i];
      var name = s.name.toLowerCase();
      if(q.indexOf(name) > -1 || name.indexOf(q) > -1) return s;
    }
    var words = q.split(/\s+/).filter(function(w){ return w.length > 1; });
    var best = null, bestScore = 0;
    for(i=0;i<all.length;i++){
      s = all[i];
      var hay = s.name.toLowerCase();
      var score = 0;
      for(var j=0;j<words.length;j++){ if(hay.indexOf(words[j]) > -1) score++; }
      if(score > bestScore){ bestScore = score; best = s; }
    }
    return bestScore > 0 ? best : null;
  }

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var listening = false;

  function setVoiceNote(text, isErr){
    el.voiceNote.textContent = text || '';
    el.voiceNote.classList.toggle('err', !!isErr);
  }

  if(SpeechRecognitionCtor){
    recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;

    recognition.addEventListener('start', function(){
      listening = true;
      el.micBtn.classList.add('listening');
      el.micBtn.setAttribute('aria-label', 'Listening — say your stop');
      setVoiceNote('Listening… say a cross-street or stop name');
    });
    recognition.addEventListener('end', function(){
      listening = false;
      el.micBtn.classList.remove('listening');
      el.micBtn.setAttribute('aria-label', 'Voice search');
    });
    recognition.addEventListener('error', function(e){
      listening = false;
      el.micBtn.classList.remove('listening');
      if(e.error === 'not-allowed' || e.error === 'service-not-allowed'){
        setVoiceNote('Microphone access was blocked — allow it to use voice search.', true);
      } else if(e.error === 'no-speech'){
        setVoiceNote('Didn\'t catch that — try again.', true);
      } else {
        setVoiceNote('Voice search error: ' + e.error, true);
      }
    });
    recognition.addEventListener('result', function(e){
      var transcript = e.results[0][0].transcript;
      el.searchInput.value = transcript;
      renderSuggestions();
      var match = matchStopFromSpeech(transcript);
      if(match){
        state.selected = { name: match.name, direction: match.direction, seq: match.seq };
        el.confirmBtn.disabled = false;
        renderSuggestions();
        setVoiceNote('Heard "' + transcript + '" — matched ' + match.name + '.');
      } else {
        setVoiceNote('Heard "' + transcript + '" — no live match yet, try again or pick from the list.', true);
      }
    });
  } else {
    el.micBtn.classList.add('unsupported');
    el.micBtn.title = 'Voice search not supported in this browser';
  }

  el.micBtn.addEventListener('click', function(){
    if(!recognition){
      setVoiceNote('Voice search isn\'t supported in this browser — try Chrome.', true);
      return;
    }
    if(listening){ recognition.stop(); return; }
    ensureAudioCtx();
    setVoiceNote('');
    try{ recognition.start(); }
    catch(e){ /* already-started guard */ }
  });

  // ---------- Confirm ----------
  el.confirmBtn.addEventListener('click', function(){
    if(!state.selected) return;
    populateConfirm();
    showPanel('confirm');
  });
  el.changeDestBtn.addEventListener('click', function(){ showPanel('search'); });

  function populateConfirm(){
    var sel = state.selected;
    el.tripStop.textContent = sel.name;
    var v = nearestApproachingVehicle(sel.direction, sel.seq);
    if(v){
      el.tripVehicle.textContent = 'Bus #' + v.label;
      el.tripLive.textContent = describeVehicle(v) + ' · about ' + Math.max(1, Math.round(((sel.seq - v.nextStopSeq) * AVG_SECS_PER_STOP) / 60)) + ' min out (est.)';
    } else {
      el.tripVehicle.textContent = 'Watching for a bus…';
      el.tripLive.textContent = 'No live bus is heading that way yet — we’ll lock onto one the moment SEPTA reports it.';
    }
  }
  function describeVehicle(v){
    var onTime = v.late === null ? 'schedule adherence unknown' :
      (v.late > 0 ? v.late + ' min behind schedule' : (v.late < 0 ? Math.abs(v.late) + ' min ahead of schedule' : 'on schedule'));
    return 'Next stop: ' + (v.nextStopName || '—') + ' · ' + onTime;
  }

  // ---------- Trip tracking (real, poll-driven — no fake animation) ----------
  function buildTrackTicks(n){
    el.trackStops.innerHTML = '';
    n = Math.max(1, Math.min(40, n));
    for(var i=0;i<n;i++) el.trackStops.appendChild(document.createElement('i'));
  }

  function renderStopList(){
    var t = state.tracking;
    el.stoplist.innerHTML = '';
    if(!t) return;
    var from = t.startSeq !== null ? t.startSeq : t.seq;
    var span = Math.max(1, t.seq - from);
    var rows = Math.min(span + 1, 30);
    var step = span / (rows - 1 || 1);
    var currentSeq = t.vehicleId ? currentTrackedSeq() : from;

    for(var i=0;i<rows;i++){
      var isDest = i === rows - 1;
      var seq = isDest ? t.seq : Math.round(from + i * step);
      var name = stopNameFor(t.direction, seq) || (isDest ? t.name : 'Stop #' + seq);
      var li = document.createElement('li');
      var cls = '';
      if(currentSeq !== null){
        if(seq < currentSeq) cls = 'passed';
        else if(seq === currentSeq) cls = 'current';
      }
      if(isDest) cls += ' dest';
      li.className = cls.trim();
      li.innerHTML =
        '<span class="dot"></span>' +
        '<span class="name">' + escapeHtml(name) + (isDest ? ' — get off here' : '') + '</span>' +
        '<span class="eta-tag"></span>';
      el.stoplist.appendChild(li);
    }
  }

  function currentTrackedSeq(){
    var t = state.tracking;
    if(!t || !t.vehicleId) return null;
    var v = findVehicleById(t.vehicleId);
    return v ? v.nextStopSeq : null;
  }
  function findVehicleById(id){
    for(var i=0;i<live.vehicles.length;i++){
      if(live.vehicles[i].id === id) return live.vehicles[i];
    }
    return null;
  }

  function updateProgressUI(){
    var t = state.tracking;
    if(!t) return;
    var from = t.startSeq !== null ? t.startSeq : t.seq;
    var span = Math.max(1, t.seq - from);
    var v = t.vehicleId ? findVehicleById(t.vehicleId) : null;

    if(!v && t.vehicleId){
      // tracked vehicle dropped out of the feed
      el.liveEta.textContent = 'lost bus';
      return;
    }
    if(!v){
      el.liveEta.textContent = 'watching…';
      el.trackFill.style.width = '0%';
      el.trackBus.style.left = '0%';
      return;
    }
    var done = Math.min(span, Math.max(0, v.nextStopSeq - from));
    var p = done / span;
    el.trackFill.style.width = (p * 100) + '%';
    el.trackBus.style.left = (p * 100) + '%';
    var ticks = el.trackStops.children;
    var passedTicks = Math.round(p * ticks.length);
    for(var i=0;i<ticks.length;i++) ticks[i].classList.toggle('passed', i < passedTicks);

    var stopsLeft = Math.max(0, t.seq - v.nextStopSeq);
    var minLeft = Math.max(0, Math.round((stopsLeft * AVG_SECS_PER_STOP) / 60));
    el.liveEta.textContent = (v.late !== null ? (v.late > 0 ? v.late + 'm late' : (v.late < 0 ? Math.abs(v.late) + 'm early' : 'on time')) + ' · ' : '') + '~' + minLeft + ' min';

    renderStopList();

    if(v.nextStopSeq >= t.seq){
      triggerAlert();
    }
  }

  function updateTracking(){
    var t = state.tracking;
    if(!t) return;

    if(!t.vehicleId){
      var candidate = nearestApproachingVehicle(t.direction, t.seq);
      if(candidate){
        t.vehicleId = candidate.id;
        t.startSeq = candidate.nextStopSeq;
        buildTrackTicks(Math.max(1, t.seq - t.startSeq) + 1);
      }
    } else {
      var v = findVehicleById(t.vehicleId);
      if(!v){
        t.missedPolls = (t.missedPolls || 0) + 1;
        if(t.missedPolls >= 2){
          // Bus dropped off the feed for good — look for a fresh one.
          t.vehicleId = null;
          t.startSeq = null;
          t.missedPolls = 0;
        }
      } else {
        t.missedPolls = 0;
      }
    }
    updateProgressUI();
  }

  el.startTripBtn.addEventListener('click', function(){
    var sel = state.selected;
    if(!sel) return;
    ensureAudioCtx(); // unlock audio now, on a real user gesture, so the alarm can play later

    var v = nearestApproachingVehicle(sel.direction, sel.seq);
    state.tracking = {
      name: sel.name,
      direction: sel.direction,
      seq: sel.seq,
      startSeq: v ? v.nextStopSeq : null,
      vehicleId: v ? v.id : null,
      missedPolls: 0
    };
    buildTrackTicks(state.tracking.startSeq !== null ? Math.max(1, sel.seq - state.tracking.startSeq) + 1 : 8);

    el.liveRouteName.innerHTML = 'Route ' + live.route + ' · <strong>' + escapeHtml(sel.name) + '</strong>';
    el.topbar.classList.add('is-live');
    el.progressHeading.textContent = 'On Route ' + live.route + ', headed to ' + sel.name;
    showPanel('progress');
    updateProgressUI();
  });

  function endTrip(){
    state.tracking = null;
    stopAlarm();
    el.topbar.classList.remove('is-live');
    el.alertOverlay.classList.remove('show','buzz');
    state.selected = null;
    el.confirmBtn.disabled = true;
    el.searchInput.value = '';
    renderSuggestions();
    showPanel('search');
  }
  el.endTripBtn.addEventListener('click', endTrip);
  el.cancelTripBtn.addEventListener('click', endTrip);
  el.resetDemoBtn.addEventListener('click', endTrip);
  el.endFromAlertBtn.addEventListener('click', endTrip);

  // ---------- Get-ready alert ----------
  var alerted = false;
  function triggerAlert(){
    if(alerted) return; // fire once per trip
    alerted = true;
    var t = state.tracking;
    el.alertStop.textContent = t.name;
    el.alertOverlay.classList.add('show');
    el.alertOverlay.classList.remove('buzz');
    void el.alertOverlay.offsetWidth;
    el.alertOverlay.classList.add('buzz');
    el.alertOverlay.setAttribute('aria-hidden','false');
    playAlarm();
    if(document.title.indexOf('Get ready') !== 0){
      document.title = 'Get ready · ' + document.title;
    }
  }
  el.keepTrackingBtn.addEventListener('click', function(){
    el.alertOverlay.classList.remove('show','buzz');
    stopAlarm();
  });

  function resetAlertFlag(){ alerted = false; }

  // ---------- Panel switching ----------
  function showPanel(name){
    if(name === 'search') resetAlertFlag();
    [el.panelSearch, el.panelConfirm, el.panelProgress].forEach(function(p){
      p.classList.toggle('active', p.dataset.panel === name);
    });
  }

  renderSuggestions();
  renderStatus();
  showPanel('search');
  startPolling();
})();
