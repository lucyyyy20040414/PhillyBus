/* ============================================================
   Real SEPTA data layer (TransitView + BusDetours), generalized
   to track whichever single route a trip plan needs — same JSONP
   approach as the rest of the Philly Bus family, since SEPTA has
   no CORS support and no stop-lookup endpoint. Stops are still
   discovered live from what vehicles report as their next stop;
   `findStopByHints` searches that accumulated knowledge for a
   name matching a destination's hint keywords, so the app only
   ever shows a stop name SEPTA itself is currently reporting.
   ============================================================ */
(function(){
  window.PB = window.PB || {};

  var TRANSITVIEW_URL = 'https://www3.septa.org/api/TransitView/index.php';
  var BUSDETOURS_URL = 'https://www3.septa.org/api/BusDetours/index.php';
  var POLL_MS = 12000;
  var FAST_POLL_MS = 4000; // used while still searching for a hint-matched stop
  var JSONP_TIMEOUT_MS = 9000;
  var AVG_SECS_PER_STOP = 110;

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
      nextStopName: raw.next_stop_name || '',
      nextStopSeq: seq,
      late: isNaN(late) ? null : late,
      seatAvailability: raw.estimated_seat_availability || null
    };
  }

  function fetchTransitView(route){
    return jsonp(TRANSITVIEW_URL + '?route=' + encodeURIComponent(route)).then(function(data){
      var raw = (data && data.bus) ? data.bus : [];
      return raw.map(normalizeVehicle).filter(function(v){ return v.id; });
    });
  }

  function fetchDetours(route){
    return jsonp(BUSDETOURS_URL + '?route=' + encodeURIComponent(route)).then(function(data){
      var list = Array.isArray(data) ? data : (data && data.route_id ? [data] : []);
      if(!list.length) return '';
      var reasons = list.map(function(d){ return d.reason || d.route_direction || ''; }).filter(Boolean);
      return reasons.length ? reasons[0] : '';
    }).catch(function(){ return ''; });
  }

  // discoveredStops[direction][sequence] = name — reset per tracked route
  var discoveredStops = {};

  function mergeDiscovered(vehicles){
    vehicles.forEach(function(v){
      if(!v.nextStopName || isNaN(v.nextStopSeq)) return;
      if(!discoveredStops[v.direction]) discoveredStops[v.direction] = {};
      discoveredStops[v.direction][v.nextStopSeq] = v.nextStopName;
    });
  }

  function findStopByHints(hints){
    // Single-word hints (e.g. "34th") match as a whole token, so "1st"
    // can't false-positive inside "61st". Multi-word hints (e.g. "art
    // museum") match as a substring since token-splitting would break them.
    var lowerHints = hints.map(function(h){ return h.toLowerCase(); });
    var directions = Object.keys(discoveredStops);
    for(var i = 0; i < directions.length; i++){
      var seqs = discoveredStops[directions[i]];
      var seqKeys = Object.keys(seqs).map(Number).sort(function(a, b){ return a - b; });
      for(var j = 0; j < seqKeys.length; j++){
        var name = seqs[seqKeys[j]];
        var lowerName = name.toLowerCase();
        var tokens = lowerName.split(/[^a-z0-9]+/).filter(Boolean);
        for(var k = 0; k < lowerHints.length; k++){
          var hint = lowerHints[k];
          var isMatch = hint.indexOf(' ') > -1 ? lowerName.indexOf(hint) > -1 : tokens.indexOf(hint) > -1;
          if(isMatch){
            return { direction: directions[i], seq: seqKeys[j], name: name };
          }
        }
      }
    }
    return null;
  }

  function nearestApproachingVehicle(vehicles, direction, targetSeq){
    var best = null, bestGap = Infinity;
    vehicles.forEach(function(v){
      if(v.direction !== direction) return;
      var gap = targetSeq - v.nextStopSeq;
      if(gap >= 0 && gap < bestGap){ bestGap = gap; best = v; }
    });
    return best;
  }

  function findVehicleById(vehicles, id){
    for(var i = 0; i < vehicles.length; i++){
      if(vehicles[i].id === id) return vehicles[i];
    }
    return null;
  }

  var pollTimer = null;
  var trackedRoute = null;

  function startTracking(route, onUpdate){
    stopTracking();
    if(route !== trackedRoute){
      discoveredStops = {};
      trackedRoute = route;
    }
    var settled = false;
    function poll(){
      fetchTransitView(route).then(function(vehicles){
        mergeDiscovered(vehicles);
        // onUpdate returns true once it has everything it needs (stop +
        // vehicle resolved) — that's the signal to relax from fast polling
        // (while hunting for a hint match) back to the normal cadence.
        var resolved = onUpdate({ status: vehicles.length ? 'ok' : 'empty', vehicles: vehicles });
        if(resolved && !settled){
          settled = true;
          clearInterval(pollTimer);
          pollTimer = setInterval(poll, POLL_MS);
        }
      }).catch(function(){
        onUpdate({ status: 'error', vehicles: [] });
      });
    }
    poll();
    pollTimer = setInterval(poll, FAST_POLL_MS);
  }

  function stopTracking(){
    if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  }

  window.PB.transit = {
    AVG_SECS_PER_STOP: AVG_SECS_PER_STOP,
    startTracking: startTracking,
    stopTracking: stopTracking,
    findStopByHints: findStopByHints,
    nearestApproachingVehicle: nearestApproachingVehicle,
    findVehicleById: findVehicleById,
    fetchDetours: fetchDetours
  };
})();
