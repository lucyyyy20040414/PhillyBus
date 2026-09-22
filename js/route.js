/* Route data: the ordered stops and shape for any SEPTA bus route (built from SEPTA's
   GTFS feed into data/routes/*.json), plus "where along this route is that GPS point?".

   Everything is measured as `s` = meters travelled along the route in one direction,
   so "what is ahead of the bus" is just "what has a bigger s". */
(function () {
  window.PB = window.PB || {};
  var R = 6371000;
  var rad = function (d) { return (d * Math.PI) / 180; };

  var indexPromise = null;
  var routePromises = {};

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function normalize(raw) {
    return String(raw || '').trim().toUpperCase().replace(/^ROUTE\s*/, '').replace(/\s+/g, '');
  }

  // { built, routes: { "42": { name, file } } }
  function index() {
    if (!indexPromise) {
      indexPromise = getJson('data/index.json').catch(function (e) { indexPromise = null; throw e; });
    }
    return indexPromise;
  }

  // Resolves null for a route that isn't in SEPTA's bus/trolley list.
  function lookup(input) {
    var key = normalize(input);
    return index().then(function (idx) {
      var hit = key && Object.prototype.hasOwnProperty.call(idx.routes, key) ? idx.routes[key] : null;
      return hit ? { route: key, name: hit.name, file: hit.file } : null;
    });
  }

  function prepare(dir) {
    if (dir.cum) return dir;
    var cum = [0];
    for (var i = 1; i < dir.shape.length; i++) {
      var a = dir.shape[i - 1], b = dir.shape[i];
      var x = rad(b[1] - a[1]) * Math.cos(rad(a[0])) * R;
      var y = rad(b[0] - a[0]) * R;
      cum.push(cum[i - 1] + Math.hypot(x, y));
    }
    dir.cum = cum;
    return dir;
  }

  // Loads a route's document; each direction is ready to snap against.
  function load(info) {
    if (!routePromises[info.file]) {
      routePromises[info.file] = getJson('data/routes/' + info.file).then(function (doc) {
        doc.dirs.forEach(prepare);
        return doc;
      }).catch(function (e) { delete routePromises[info.file]; throw e; });
    }
    return routePromises[info.file];
  }

  // Closest point on shape segments [i0, i1) to (lat, lng).
  function search(dir, lat, lng, i0, i1) {
    var shape = dir.shape, cum = dir.cum;
    var cosLat = Math.cos(rad(lat));
    var best = null;
    for (var i = Math.max(0, i0); i < Math.min(shape.length - 1, i1); i++) {
      var ax = rad(shape[i][1] - lng) * cosLat * R, ay = rad(shape[i][0] - lat) * R;
      var bx = rad(shape[i + 1][1] - lng) * cosLat * R, by = rad(shape[i + 1][0] - lat) * R;
      var vx = bx - ax, vy = by - ay;
      var len2 = vx * vx + vy * vy;
      var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2));
      var d = Math.hypot(ax + t * vx, ay + t * vy);
      if (!best || d < best.dist) {
        best = { dist: d, s: cum[i] + t * Math.sqrt(len2), seg: i, bearing: (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360 };
      }
    }
    return best;
  }

  // Where along `dir` is this GPS point? Uses the last known position (`hintS`) first,
  // so a route that passes the same street twice can't snap the rider to the wrong pass.
  // -> { s, dist (meters off the route), bearing (direction of the route right there) }
  function snap(dir, lat, lng, hintS) {
    var n = dir.shape.length;
    var best = null;
    if (hintS !== null && hintS !== undefined) {
      var lo = 0, hi = n - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (dir.cum[mid] < hintS - 400) lo = mid + 1; else hi = mid; }
      var i0 = lo;
      lo = i0; hi = n - 1;
      while (lo < hi) { var m2 = (lo + hi) >> 1; if (dir.cum[m2] < hintS + 1500) lo = m2 + 1; else hi = m2; }
      best = search(dir, lat, lng, Math.max(0, i0 - 1), lo + 1);
    }
    if (!best || best.dist > 80) {
      var g = search(dir, lat, lng, 0, n - 1);
      if (!best || (g && g.dist < best.dist - 20)) best = g;
    }
    return best;
  }

  // The first stop still ahead of the rider (s meters along the route).
  function nextStop(dir, s) {
    var stops = dir.stops;
    for (var i = 0; i < stops.length; i++) if (stops[i].s >= s - 15) return stops[i];
    return null;
  }

  window.PB.route = { normalize: normalize, lookup: lookup, load: load, prepare: prepare, snap: snap, nextStop: nextStop };
})();
