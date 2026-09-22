/* SEPTA live data: TransitView (position, heading, direction, destination, next stop
   of every bus on a route). It has no CORS support, so it's called via JSONP.
   This is how the app follows a rider's bus — no device location is used. */
(function () {
  window.PB = window.PB || {};

  var TRANSITVIEW = 'https://www3.septa.org/api/TransitView/index.php';
  var JSONP_TIMEOUT_MS = 9000;

  function jsonp(url) {
    return new Promise(function (resolve, reject) {
      var cb = 'septa_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var script = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () { finish(new Error('timeout')); }, JSONP_TIMEOUT_MS);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      function finish(err, data) {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err); else resolve(data);
      }
      window[cb] = function (data) { finish(null, data); };
      script.onerror = function () { finish(new Error('network')); };
      script.src = url + (url.indexOf('?') > -1 ? '&' : '?') + 'callback=' + cb;
      document.head.appendChild(script);
    });
  }

  function normalize(raw) {
    var lat = parseFloat(raw.lat), lng = parseFloat(raw.lng);
    var heading = raw.heading !== undefined && raw.heading !== null && raw.heading !== '' ? parseFloat(raw.heading) : NaN;
    var ts = parseFloat(raw.timestamp);
    var late = raw.late !== undefined && raw.late !== null && raw.late !== '' ? parseInt(raw.late, 10) : null;
    return {
      id: String(raw.VehicleID || raw.label || ''),
      label: raw.label || raw.VehicleID || '?',
      lat: lat,
      lng: lng,
      heading: isFinite(heading) ? heading : null,
      ts: isFinite(ts) ? ts * 1000 : 0,
      direction: raw.Direction || raw.direction || '',
      destination: raw.destination || '',
      nextStop: raw.next_stop_name || '',
      late: late === 999 ? null : late
    };
  }

  // Live vehicles on a route (only ones actually reporting a position).
  function vehicles(route) {
    return jsonp(TRANSITVIEW + '?route=' + encodeURIComponent(route)).then(function (data) {
      var raw = data && data.bus ? data.bus : [];
      return raw.map(normalize).filter(function (v) {
        return v.id && isFinite(v.lat) && isFinite(v.lng) && Math.abs(v.lat) > 1 && Math.abs(v.lng) > 1;
      });
    });
  }

  window.PB.septa = { vehicles: vehicles };
})();
