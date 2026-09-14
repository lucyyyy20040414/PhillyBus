(function(){
  var el = {
    screens: document.querySelectorAll('.screen'),

    promptForm: document.getElementById('promptForm'),
    promptInput: document.getElementById('promptInput'),
    chipRow: document.getElementById('chipRow'),

    interpretingContext: document.getElementById('interpretingContext'),

    fallbackForm: document.getElementById('fallbackForm'),
    fallbackInput: document.getElementById('fallbackInput'),

    tripBanner: document.getElementById('tripBanner'),
    tripNumber: document.getElementById('tripNumber'),
    tripNumberLabel: document.getElementById('tripNumberLabel'),
    tripRouteNum: document.getElementById('tripRouteNum'),
    tripRouteDir: document.getElementById('tripRouteDir'),
    tripStopName: document.getElementById('tripStopName'),
    tripArrival: document.getElementById('tripArrival'),
    tripWalk: document.getElementById('tripWalk'),
    startOverBtn: document.getElementById('startOverBtn'),

    alertOverlay: document.getElementById('alertOverlay'),
    alertStop: document.getElementById('alertStop'),
    keepTrackingBtn: document.getElementById('keepTrackingBtn'),
    endFromAlertBtn: document.getElementById('endFromAlertBtn')
  };

  var state = { intent: null, dest: null, alerted: false, initialProjectedArrival: null };

  function showScreen(name){
    el.screens.forEach(function(s){ s.classList.toggle('active', s.dataset.screen === name); });
    window.scrollTo(0, 0);
  }

  // ---------- Rotating placeholder ----------
  var PLACEHOLDERS = [
    "I need to get to Penn before 8",
    "Take me to Reading Terminal Market",
    "I'm late for class at Drexel",
    "I don't want to walk more than 5 minutes",
    "I need to get to the Art Museum",
    "I'm meeting someone near Rittenhouse"
  ];
  var phIndex = 0;
  el.promptInput.placeholder = PLACEHOLDERS[0];
  setInterval(function(){
    phIndex = (phIndex + 1) % PLACEHOLDERS.length;
    el.promptInput.placeholder = PLACEHOLDERS[phIndex];
  }, 2800);

  // ---------- Alarm sound (Web Audio) ----------
  var audioCtx = null;
  var activeAlarmNodes = [];
  function ensureAudioCtx(){
    var AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    if(!audioCtx){ try{ audioCtx = new AC(); } catch(e){ return null; } }
    if(audioCtx.state === 'suspended') audioCtx.resume().catch(function(){});
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
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(startTime); osc.stop(startTime + duration + 0.02);
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
    for(var i = 0; i < 3; i++){
      var t = now + i * 0.7;
      playBeep(ctx, t, 0.16, 880);
      playBeep(ctx, t + 0.2, 0.16, 660);
    }
  }
  function stopAlarm(){
    activeAlarmNodes.forEach(function(osc){ try{ osc.stop(); } catch(e){} });
    activeAlarmNodes = [];
  }

  function requestNotificationPermission(){
    if(!('Notification' in window)) return;
    if(Notification.permission === 'default') Notification.requestPermission();
  }
  function notifyArrival(stopName){
    if('vibrate' in navigator) navigator.vibrate([200, 100, 200, 100, 400]);
    if('Notification' in window && Notification.permission === 'granted' && document.hidden){
      try{ new Notification('Get off here', { body: stopName }); } catch(e){}
    }
  }

  // ---------- Intent -> trip ----------
  function runIntent(text){
    var intent = window.PB.interpretTravelIntent(text);
    if(!intent.destinationName || intent.confidence < 0.4){
      showScreen('fallback');
      el.fallbackInput.focus();
      return;
    }
    el.interpretingContext.textContent = intent.inferredContext || ('Heading to ' + intent.destinationName + '.');
    showScreen('interpreting');
    setTimeout(function(){ startTrip(intent); }, 900);
  }

  function findDestination(id){
    var list = window.PB.GAZETTEER;
    for(var i = 0; i < list.length; i++){ if(list[i].id === id) return list[i]; }
    return null;
  }

  function startTrip(intent){
    var dest = findDestination(intent._destinationId);
    if(!dest){ showScreen('fallback'); return; }

    state.intent = intent;
    state.dest = dest;
    state.alerted = false;
    state.initialProjectedArrival = null;
    state.tripStartedAt = Date.now();

    requestNotificationPermission();

    el.tripBanner.textContent = 'Finding your stop on Route ' + dest.route + '…';
    el.tripBanner.className = 'trip-banner';
    el.tripNumber.textContent = '—';
    el.tripNumberLabel.textContent = 'LOCATING';
    el.tripRouteNum.textContent = dest.route;
    el.tripRouteDir.textContent = '—';
    el.tripStopName.textContent = '—';
    el.tripArrival.textContent = '—';
    el.tripWalk.textContent = dest.walkMinutes + ' min to ' + dest.name;

    showScreen('trip');
    window.PB.transit.startTracking(dest.route, onTransitUpdate);
  }

  function onTransitUpdate(update){
    if(!state.dest) return false;

    if(update.status === 'error'){
      el.tripBanner.textContent = "Having trouble reaching SEPTA — retrying…";
      el.tripBanner.className = 'trip-banner tone-warn';
      return false;
    }

    var target = window.PB.transit.findStopByHints(state.dest.stopHints);
    if(!target){
      var waitedSec = Math.round((Date.now() - state.tripStartedAt) / 1000);
      el.tripBanner.textContent = waitedSec < 20
        ? 'Finding your stop on Route ' + state.dest.route + '…'
        : 'Still watching Route ' + state.dest.route + ' — this stop shows up as buses pass it.';
      el.tripBanner.className = 'trip-banner';
      return false;
    }

    var vehicle = window.PB.transit.nearestApproachingVehicle(update.vehicles, target.direction, target.seq);
    if(!vehicle){
      el.tripBanner.textContent = 'No live Route ' + state.dest.route + ' buses right now — checking again shortly.';
      el.tripBanner.className = 'trip-banner tone-warn';
      return false;
    }

    var stopsAway = Math.max(0, target.seq - vehicle.nextStopSeq);
    var rideMinutes = window.PB.trip.computeRideMinutes(stopsAway);
    var walkMinutes = state.dest.walkMinutes;
    var projected = window.PB.trip.projectArrival(rideMinutes, walkMinutes);
    var deadlineStatus = window.PB.trip.compareToDeadline(projected, state.intent.arrivalDeadline);
    var phase = window.PB.trip.phaseForStopsAway(stopsAway);

    if(state.initialProjectedArrival === null) state.initialProjectedArrival = projected;

    renderTrip(target, vehicle, stopsAway, rideMinutes, walkMinutes, projected, deadlineStatus, phase);

    if(phase === 'arriving' && !state.alerted) triggerArrival(target);
    return true;
  }

  function renderTrip(target, vehicle, stopsAway, rideMinutes, walkMinutes, projected, deadlineStatus, phase){
    var bannerText, bannerTone = '';
    if(deadlineStatus === null){
      bannerText = phase === 'onboard' ? "You're on track." : 'On the way.';
    } else {
      var driftMin = (projected.getTime() - state.initialProjectedArrival.getTime()) / 60000;
      if(deadlineStatus === 'late'){
        bannerText = 'Your arrival changed. Now expected around ' + window.PB.formatTime(projected) + '.';
        bannerTone = 'tone-alert';
      } else if(driftMin > 2){
        bannerText = "You're still good — expected by " + window.PB.formatTime(projected) + '.';
      } else if(deadlineStatus === 'ahead'){
        bannerText = "You'll make it.";
      } else {
        bannerText = "It'll be close.";
        bannerTone = 'tone-warn';
      }
    }
    el.tripBanner.textContent = bannerText;
    el.tripBanner.className = 'trip-banner' + (bannerTone ? ' ' + bannerTone : '');

    if(phase === 'approaching'){
      el.tripNumber.textContent = String(rideMinutes);
      el.tripNumberLabel.textContent = 'Min until your stop';
    } else if(phase === 'onboard'){
      el.tripNumber.textContent = String(stopsAway);
      el.tripNumberLabel.textContent = stopsAway === 1 ? 'Stop until you get off' : 'Stops until you get off';
    } else {
      el.tripNumber.textContent = '0';
      el.tripNumberLabel.textContent = 'Get off now';
    }

    el.tripRouteNum.textContent = state.dest.route;
    el.tripRouteDir.textContent = vehicle.direction;
    el.tripStopName.textContent = target.name;
    el.tripArrival.textContent = window.PB.formatTime(projected);
    el.tripWalk.textContent = walkMinutes + ' min to ' + state.dest.name;
  }

  function triggerArrival(target){
    state.alerted = true;
    el.alertStop.textContent = target.name;
    el.alertOverlay.classList.add('show');
    el.alertOverlay.classList.remove('buzz');
    void el.alertOverlay.offsetWidth;
    el.alertOverlay.classList.add('buzz');
    el.alertOverlay.setAttribute('aria-hidden', 'false');
    playAlarm();
    notifyArrival(target.name);
  }

  function endTrip(){
    window.PB.transit.stopTracking();
    stopAlarm();
    el.alertOverlay.classList.remove('show', 'buzz');
    el.alertOverlay.setAttribute('aria-hidden', 'true');
    state.intent = null;
    state.dest = null;
    state.alerted = false;
    el.promptInput.value = '';
    showScreen('prompt');
  }

  // ---------- Wiring ----------
  el.promptForm.addEventListener('submit', function(e){
    e.preventDefault();
    ensureAudioCtx();
    var text = el.promptInput.value.trim();
    if(text) runIntent(text);
  });
  el.fallbackForm.addEventListener('submit', function(e){
    e.preventDefault();
    ensureAudioCtx();
    var text = el.fallbackInput.value.trim();
    if(text) runIntent(text);
  });
  el.chipRow.querySelectorAll('.chip').forEach(function(btn){
    btn.addEventListener('click', function(){
      ensureAudioCtx();
      runIntent(btn.getAttribute('data-chip'));
    });
  });
  el.startOverBtn.addEventListener('click', endTrip);
  el.endFromAlertBtn.addEventListener('click', endTrip);
  el.keepTrackingBtn.addEventListener('click', function(){
    el.alertOverlay.classList.remove('show', 'buzz');
    el.alertOverlay.setAttribute('aria-hidden', 'true');
    stopAlarm();
  });

  showScreen('prompt');
})();
