// Queue persistence and the decision at the end of a comment drain.
//
// Classic script on purpose: the service worker loads it with importScripts,
// and the feed tab loads it ahead of collector.js. Node tests evaluate it
// in a vm. Nothing here touches chrome.* or the DOM.

(function (root) {
  // One writer per key. Every caller waits until the latest snapshot that
  // was requested has been written.
  //
  // Two overlapping persistQueue calls used to each take a persistGen, await
  // storage, then call persistQueue again because the other call had moved
  // the counter. Each re-entry bumped the counter once more, so the pair
  // rescheduled itself forever. stopRun, runLane, queueComments and
  // loadParkedJobs all await this, so the drain never reached store or upload.
  // queueEpoch was the only check that returned without calling persistQueue,
  // which is why Clear (and a hand-bumped epoch) were the only way out.
  //
  // A call that arrives while a write is in flight sets `again` and shares
  // that write's promise. The follow-up reads the queue when it runs, so a
  // burst collapses to a snapshot of the latest state and then stops. The
  // write itself must not call persistQueue: that would be the old loop.
  function createQueuePersister(writeSnapshot) {
    const slots = new Map();

    function persistQueue(groupKey) {
      if (!groupKey) return Promise.resolve();
      const existing = slots.get(groupKey);
      if (existing) {
        existing.again = true;
        return existing.promise;
      }

      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      const slot = { promise, again: false };
      slots.set(groupKey, slot);

      (async () => {
        try {
          do {
            slot.again = false;
            try {
              await writeSnapshot(groupKey);
            } catch {
              // A quota or a teardown. The queue in memory is still the live one.
            }
          } while (slot.again);
        } finally {
          // Synchronous with the loop check above, so a caller cannot land
          // in the gap and miss the follow-up it just asked for.
          if (slots.get(groupKey) === slot) slots.delete(groupKey);
          resolve();
        }
      })();

      return promise;
    }

    return persistQueue;
  }

  // The snapshot is taken before the storage call. A Clear that lands during
  // the write bumps the epoch; the bytes just stored are the old queue and
  // are removed. A newer persist is not started from here.
  function createGroupQueueWriter({ getEpoch, getJobs, storage }) {
    return async function writeQueueSnapshot(groupKey) {
      const epoch = getEpoch(groupKey);
      const parked = getJobs(groupKey).map((job) => ({ ...job }));
      try {
        if (getEpoch(groupKey) !== epoch) return;
        if (!parked.length) await storage.remove(groupKey);
        else await storage.set(groupKey, parked);
        if (getEpoch(groupKey) !== epoch) await storage.remove(groupKey);
      } catch {
        // A quota or a teardown. The queue in memory is still the live one.
      }
    };
  }

  // What to do once the comment walk has stopped waiting on the worker.
  //
  // `upload` is always on: a drain that is idle, parked, or out of time
  // still has to store the posts that are already whole. `releaseUnread`
  // marks every remaining hold comments:worker_lost. That is right only
  // when nothing is queued for those posts. A timeout used to release and
  // then clear the queue anyway, which dropped threads the worker had not
  // read. Jobs left on disk with no post still holding them are leftovers,
  // and clearing those is what an empty hold list already did.
  function drainSettlePlan({
    pending = 0,
    inFlight = 0,
    onDisk = 0,
    held = 0,
    queueKnown = true,
  } = {}) {
    const jobsLeft = (Number(pending) || 0) + (Number(inFlight) || 0) + (Number(onDisk) || 0);
    const heldN = Number(held) || 0;
    if (!queueKnown || (jobsLeft > 0 && heldN > 0)) {
      return {
        upload: true,
        releaseUnread: false,
        clearQueue: false,
        queueStopped: false,
      };
    }
    return {
      upload: true,
      releaseUnread: true,
      clearQueue: true,
      queueStopped: true,
    };
  }

  root.createQueuePersister = createQueuePersister;
  root.createGroupQueueWriter = createGroupQueueWriter;
  root.drainSettlePlan = drainSettlePlan;
})(typeof globalThis !== "undefined" ? globalThis : this);
