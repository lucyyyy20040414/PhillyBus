/* ============================================================
   Pure trip-math. No DOM, no network — just the deterministic
   application logic that turns "stops away" + a destination's
   walk estimate + an optional deadline into what the rider sees.
   This is the layer the assignment insists must NOT be an LLM:
   arrival math and delay comparison are arithmetic, not judgment.
   ============================================================ */
(function(){
  window.PB = window.PB || {};

  function computeRideMinutes(stopsAway){
    if(stopsAway <= 0) return 1;
    return Math.max(1, Math.round((stopsAway * window.PB.transit.AVG_SECS_PER_STOP) / 60));
  }

  function projectArrival(rideMinutes, walkMinutes){
    var d = new Date();
    d.setMinutes(d.getMinutes() + rideMinutes + walkMinutes);
    return d;
  }

  // 'ahead' | 'tight' | 'late' | null (null when there is no deadline to compare)
  function compareToDeadline(projectedArrival, deadline){
    if(!deadline) return null;
    var diffMin = (deadline.getTime() - projectedArrival.getTime()) / 60000;
    if(diffMin >= 5) return 'ahead';
    if(diffMin >= 0) return 'tight';
    return 'late';
  }

  // 'approaching' (bus still several stops out) | 'onboard' (close — assume you're on it)
  // | 'arriving' (this is the stop)
  function phaseForStopsAway(stopsAway){
    if(stopsAway <= 0) return 'arriving';
    if(stopsAway <= 3) return 'onboard';
    return 'approaching';
  }

  window.PB.trip = {
    computeRideMinutes: computeRideMinutes,
    projectArrival: projectArrival,
    compareToDeadline: compareToDeadline,
    phaseForStopsAway: phaseForStopsAway
  };
})();
