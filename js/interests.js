/* The six things a rider can say they notice. `key` must match the keys the
   server's /api/discover understands. Icons are simple stroke glyphs. */
(function () {
  window.PB = window.PB || {};

  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  window.PB.INTERESTS = [
    { key: 'food', label: 'Food', color: '#f2542d',
      icon: svg('<path d="M7 2v7M4 2v5a3 3 0 0 0 6 0V2M7 9v13"/><path d="M17 2c-2.2 1.4-3 3.8-3 6.5 0 2 1 3 3 3.5V22"/>') },
    { key: 'art', label: 'Art + Design', color: '#9b3dff',
      icon: svg('<path d="M12 3a9 9 0 1 0 0 18c1.6 0 2.1-1 2.1-2.1s-.9-1.7-.9-2.7.8-1.4 1.9-1.4H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="7.5" r="1"/>') },
    { key: 'history', label: 'History', color: '#9a5b1e',
      icon: svg('<path d="M2 10l10-7 10 7z"/><path d="M4 21h16M5.5 10v11M10 10v11M14 10v11M18.5 10v11"/>') },
    { key: 'parks', label: 'Parks', color: '#12995a',
      icon: svg('<path d="M12 22v-6"/><path d="M12 16c-4.2 0-6.5-2.6-6.5-5.3 0-2 1.3-3.4 2.8-3.8C8.8 5.3 10.2 2.5 12 2.5s3.2 2.800 3.700 4.400c1.500.4 2.800 1.800 2.800 3.800 0 2.700-2.300 5.300-6.500 5.300z"/>') },
    { key: 'architecture', label: 'Architecture', color: '#2f6bff',
      icon: svg('<path d="M3 21V10l5-3v14M8 21V4l6-2v19M14 21v-9l7 2v7M2 21h20"/>') },
    { key: 'shopping', label: 'Shopping', color: '#f0309a',
      icon: svg('<path d="M5 8h14l-1.2 13H6.200L5 8z"/><path d="M9 8V6.500a3 3 0 0 1 6 0V8"/>') }
  ];

  window.PB.interestByKey = function (key) {
    for (var i = 0; i < window.PB.INTERESTS.length; i++) {
      if (window.PB.INTERESTS[i].key === key) return window.PB.INTERESTS[i];
    }
    return null;
  };
})();
