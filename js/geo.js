/* Plain geometry — the part that must never be an AI's guess. Everything
   "which side of the bus" and "how far ahead" comes from here. */
(function () {
  window.PB = window.PB || {};

  var R = 6371000;
  function rad(d) { return (d * Math.PI) / 180; }
  function deg(r) { return (r * 180) / Math.PI; }

  function distance(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLng = rad(b.lng - a.lng);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    var dLng = rad(b.lng - a.lng);
    var y = Math.sin(dLng) * Math.cos(rad(b.lat));
    var x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  function advance(p, heading, meters) {
    var d = meters / R, b = rad(heading), la1 = rad(p.lat), lo1 = rad(p.lng);
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    var lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return { lat: deg(la2), lng: deg(lo2) };
  }

  // Where is `pt` relative to a bus at `bus` travelling on `heading`?
  //   along   = meters ahead (negative = already passed)
  //   lateral = meters to the side (positive = RIGHT of the direction of travel)
  function project(bus, heading, pt) {
    var dx = rad(pt.lng - bus.lng) * Math.cos(rad(bus.lat)) * R;
    var dy = rad(pt.lat - bus.lat) * R;
    var hx = Math.sin(rad(heading)), hy = Math.cos(rad(heading));
    return { along: dx * hx + dy * hy, lateral: dx * hy - dy * hx };
  }

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function feetLabel(m) {
    var ft = m * 3.28084;
    if (ft < 60) return 'right here';
    if (ft < 1000) return Math.round(ft / 50) * 50 + ' ft';
    return (m / 1609.34).toFixed(1) + ' mi';
  }

  window.PB.geo = { distance: distance, bearing: bearing, advance: advance, project: project, angleDiff: angleDiff, feetLabel: feetLabel };
})();
