/* ============================================================
   Curated Philadelphia destination gazetteer.
   This is a prototype-scale lookup table, NOT a citywide trip
   planner — it covers a fixed set of well-known destinations,
   each mapped to a real SEPTA route that plausibly serves it.
   The exact stop shown to the rider is never hardcoded here:
   `stopHints` are substrings used to find that destination's
   real, live-reported stop name in SEPTA's own TransitView feed
   (see js/transit.js `findStopByHints`) — so the app only ever
   displays a stop name SEPTA itself is currently reporting.
   `walkMinutes` is a fixed, hand-estimated walk from that stop
   to the destination (no live walking-directions API is used).
   ============================================================ */
(function(){
  window.PB = window.PB || {};

  window.PB.GAZETTEER = [
    {
      id: 'penn-bookstore',
      name: 'Penn Bookstore',
      type: 'Shop',
      keywords: ['penn bookstore', 'bookstore', 'textbook', 'penn book', 'book store', 'university book'],
      lat: 39.9522, lng: -75.1932,
      route: '21',
      stopHints: ['34th', '35th', '36th', '37th', '38th', '39th'],
      walkMinutes: 4
    },
    {
      id: 'upenn',
      name: 'University of Pennsylvania',
      type: 'Campus',
      keywords: ['penn', 'university of pennsylvania', 'upenn', 'locust walk', 'college hall'],
      lat: 39.9522, lng: -75.1932,
      route: '21',
      stopHints: ['33rd', '34th', '35th', '36th', '37th', '38th', '39th', '40th'],
      walkMinutes: 4
    },
    {
      id: 'drexel',
      name: 'Drexel University',
      type: 'Campus',
      keywords: ['drexel', 'drexel university'],
      lat: 39.9566, lng: -75.1899,
      route: '21',
      stopHints: ['29th', '30th', '31st', '32nd', '33rd', '34th'],
      walkMinutes: 5
    },
    {
      id: 'reading-terminal',
      name: 'Reading Terminal Market',
      type: 'Market',
      keywords: ['reading terminal', 'reading terminal market', 'terminal market'],
      lat: 39.9532, lng: -75.1590,
      route: '21',
      stopHints: ['8th', '9th', '10th', '11th', '12th', '13th', '14th'],
      walkMinutes: 4
    },
    {
      id: 'art-museum',
      name: 'Philadelphia Museum of Art',
      type: 'Museum',
      keywords: ['art museum', 'museum of art', 'philadelphia museum', 'rocky steps'],
      lat: 39.9656, lng: -75.1810,
      route: '38',
      stopHints: ['fairmount', 'art museum', 'pkwy', 'parkway', 'kelly', 'eakins'],
      walkMinutes: 5
    },
    {
      id: 'rittenhouse',
      name: 'Rittenhouse Square',
      type: 'Park',
      keywords: ['rittenhouse', 'rittenhouse square'],
      lat: 39.9496, lng: -75.1719,
      route: '21',
      stopHints: ['16th', '17th', '18th', '19th', '20th', '21st'],
      walkMinutes: 4
    },
    {
      id: 'city-hall',
      name: 'City Hall',
      type: 'Landmark',
      keywords: ['city hall'],
      lat: 39.9526, lng: -75.1652,
      route: '21',
      stopHints: ['broad', '13th', '14th', '15th', '16th'],
      walkMinutes: 4
    },
    {
      id: '30th-street-station',
      name: '30th Street Station',
      type: 'Station',
      keywords: ['30th street station', '30th st station', 'amtrak', 'train station'],
      lat: 39.9566, lng: -75.1819,
      route: '21',
      stopHints: ['schuylkill', '30th'],
      walkMinutes: 4
    },
    {
      id: 'independence-hall',
      name: 'Independence Hall',
      type: 'Landmark',
      keywords: ['independence hall', 'independence mall', 'liberty bell'],
      lat: 39.9489, lng: -75.1500,
      route: '21',
      stopHints: ['5th', '4th', '6th'],
      walkMinutes: 3
    },
    {
      id: 'clark-park',
      name: 'Clark Park',
      type: 'Park',
      keywords: ['clark park'],
      lat: 39.9498, lng: -75.2071,
      route: '21',
      stopHints: ['43rd', '44th'],
      walkMinutes: 7
    },
    {
      id: 'south-street',
      name: 'South Street',
      type: 'District',
      keywords: ['south street', 'south st'],
      lat: 39.9421, lng: -75.1550,
      route: '21',
      stopHints: ['4th', '5th', 'dock', 'front'],
      walkMinutes: 6
    },
    {
      id: 'eastern-state',
      name: 'Eastern State Penitentiary',
      type: 'Landmark',
      keywords: ['eastern state', 'eastern state penitentiary', 'penitentiary'],
      lat: 39.9679, lng: -75.1727,
      route: '38',
      stopHints: ['fairmount', 'girard', '22nd', 'ridge'],
      walkMinutes: 6
    }
  ];
})();
