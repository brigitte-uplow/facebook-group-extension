// The popup's Total time is collect + drain + store. The start stamp is
// per group and lives in that group's stored collection, so a new Start
// has to replace it. A storage read that began before the click must not
// put the previous run's collectStartedAt back afterwards.
//
// Classic script: the feed tab loads it ahead of collector.js. Node tests
// evaluate it in a vm.

(function (root) {
  function emptyRunTiming() {
    return {
      collectStartedAt: null,
      collectEndedAt: null,
      drainStartedAt: null,
      drainEndedAt: null,
      storeStartedAt: null,
      storeEndedAt: null,
    };
  }

  function stampMs(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function restoreRunTiming(raw) {
    const timing = emptyRunTiming();
    if (!raw || typeof raw !== "object") return timing;
    for (const key of Object.keys(timing)) timing[key] = stampMs(raw[key]);
    return timing;
  }

  // `reset` is a new Start from the top. A resume keeps the start only
  // while that walk has not ended. A clock that already has collectEndedAt
  // is a finished run, so the next pass starts over even if the caller
  // did not ask for a reset.
  function beginCollect(timing, reset, now) {
    const resetClock = Boolean(reset) || !timing?.collectStartedAt || Boolean(timing?.collectEndedAt);
    const next = resetClock ? emptyRunTiming() : { ...timing };
    if (!next.collectStartedAt) next.collectStartedAt = now;
    return { timing: next, reset: resetClock };
  }

  // `readGeneration` is the run token captured before the storage read.
  // A Start during that read bumps the live token and owns the clock.
  function timingAfterHydrate(live, stored, readGeneration, liveGeneration) {
    if (readGeneration !== liveGeneration) return live;
    if (!stored) return live;
    return restoreRunTiming(stored);
  }

  root.emptyRunTiming = emptyRunTiming;
  root.restoreRunTiming = restoreRunTiming;
  root.beginCollect = beginCollect;
  root.timingAfterHydrate = timingAfterHydrate;
})(typeof globalThis !== "undefined" ? globalThis : this);
