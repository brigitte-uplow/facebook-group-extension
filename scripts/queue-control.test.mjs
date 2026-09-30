import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function loadQueueControl() {
  const source = readFileSync(new URL("../src/queue-control.js", import.meta.url), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    createQueuePersister: sandbox.createQueuePersister,
    createGroupQueueWriter: sandbox.createGroupQueueWriter,
    drainSettlePlan: sandbox.drainSettlePlan,
  };
}

const { createQueuePersister, createGroupQueueWriter, drainSettlePlan } = loadQueueControl();

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushUntil(predicate) {
  for (let i = 0; i < 30 && !predicate(); i += 1) await Promise.resolve();
  assert.equal(predicate(), true);
}

// The generation check that shipped in 0.18.26. Two writes that are both
// inside storage see each other's bump and call themselves again.
async function legacyPersist(ctx) {
  const epoch = ctx.epoch;
  const gen = ctx.gen + 1;
  ctx.gen = gen;
  const parked = ctx.jobs.slice();
  if (ctx.epoch !== epoch) return;
  if (ctx.gen !== gen) return;
  ctx.writes += 1;
  if (ctx.writes > 40) {
    ctx.runaway = true;
    return;
  }
  await ctx.gate.promise;
  ctx.disk = parked;
  if (ctx.epoch !== epoch) {
    ctx.disk = null;
    return;
  }
  if (ctx.gen !== gen) return legacyPersist(ctx);
}

test("overlapping legacy persists re-enter until the cap", async () => {
  const first = deferred();
  const ctx = { epoch: 0, gen: 0, jobs: ["a", "b"], writes: 0, disk: null, runaway: false, gate: first };
  const left = legacyPersist(ctx);
  const right = legacyPersist(ctx);
  // Both calls have passed the pre-write generation check and are inside storage.
  assert.equal(ctx.writes, 2);
  assert.equal(ctx.gen, 2);
  first.resolve();
  await Promise.all([left, right]);
  assert.equal(ctx.runaway, true);
  assert.ok(ctx.writes > 40);
});

test("overlapping persists settle on the latest snapshot and stop", async () => {
  const jobs = ["a", "b"];
  let disk = null;
  let writes = 0;
  const waiting = [];
  const persist = createQueuePersister(async () => {
    writes += 1;
    const snapshot = jobs.slice();
    await new Promise((resolve) => waiting.push(resolve));
    disk = snapshot;
  });

  const first = persist("group");
  await flushUntil(() => waiting.length === 1);
  jobs.splice(0, jobs.length, "a");
  const second = persist("group");
  assert.equal(writes, 1);
  waiting.shift()();
  await flushUntil(() => writes === 2 && waiting.length === 1);
  waiting.shift()();
  await Promise.all([first, second]);
  assert.equal(writes, 2);
  assert.deepEqual(disk, ["a"]);
});

test("a burst of persists cannot self-perpetuate", async () => {
  const jobs = [];
  let disk = null;
  let writes = 0;
  const persist = createQueuePersister(async () => {
    writes += 1;
    const snapshot = jobs.slice();
    await Promise.resolve();
    disk = snapshot;
  });

  const calls = [];
  for (let i = 0; i < 500; i += 1) {
    jobs.push(i);
    calls.push(persist("group"));
  }
  await Promise.all(calls);
  assert.equal(writes, 2);
  assert.deepEqual(disk, jobs);
});

test("a clear during the write drops the stale jobs and does not rewrite them", async () => {
  let epoch = 0;
  let jobs = [{ postId: "1" }, { postId: "2" }];
  const disk = new Map();
  const waiting = [];
  const write = createGroupQueueWriter({
    getEpoch: () => epoch,
    getJobs: () => jobs,
    storage: {
      async set(_groupKey, parked) {
        await new Promise((resolve) => waiting.push(resolve));
        disk.set("group", parked);
      },
      async remove() {
        disk.delete("group");
      },
    },
  });
  const persist = createQueuePersister(write);
  const pending = persist("group");
  await flushUntil(() => waiting.length === 1);
  epoch += 1;
  jobs = [];
  waiting.shift()();
  await pending;
  assert.equal(disk.has("group"), false);

  // The follow-up a caller would schedule after the clear sees the empty queue.
  await persist("group");
  assert.equal(disk.has("group"), false);
});

test("a later snapshot replaces a stale write once the first storage call finishes", async () => {
  let epoch = 0;
  let jobs = [{ postId: "1" }, { postId: "2" }];
  let disk = null;
  const waiting = [];
  const write = createGroupQueueWriter({
    getEpoch: () => epoch,
    getJobs: () => jobs,
    storage: {
      async set(_groupKey, parked) {
        await new Promise((resolve) => waiting.push(resolve));
        disk = parked;
      },
      async remove() {
        disk = null;
      },
    },
  });
  const persist = createQueuePersister(write);
  const first = persist("group");
  await flushUntil(() => waiting.length === 1);
  jobs = [{ postId: "1" }];
  const second = persist("group");
  waiting.shift()();
  await flushUntil(() => waiting.length === 1);
  waiting.shift()();
  await Promise.all([first, second]);
  assert.deepEqual(
    disk.map((job) => job.postId),
    ["1"]
  );
});

test("one group's persist does not block another's", async () => {
  const gates = new Map();
  const writes = { a: 0, b: 0 };
  const persist = createQueuePersister(async (groupKey) => {
    writes[groupKey] += 1;
    await new Promise((resolve) => {
      gates.set(groupKey, resolve);
    });
  });
  const slow = persist("a");
  const fast = persist("b");
  await flushUntil(() => gates.has("a") && gates.has("b"));
  gates.get("b")();
  await fast;
  assert.equal(writes.b, 1);
  assert.equal(writes.a, 1);
  gates.get("a")();
  await slow;
});

function planOf(status) {
  // The helper runs in a vm, so its objects do not share this realm's prototype.
  return JSON.parse(JSON.stringify(drainSettlePlan(status)));
}

test("an empty or finished queue uploads and releases holds", () => {
  assert.deepEqual(planOf({ pending: 0, inFlight: 0, onDisk: 0, held: 0 }), {
    upload: true,
    releaseUnread: true,
    clearQueue: true,
    queueStopped: true,
  });
  // Posts still held, but the worker has nothing queued for them.
  assert.equal(drainSettlePlan({ pending: 0, inFlight: 0, onDisk: 0, held: 4 }).releaseUnread, true);
});

test("a timeout or parked queue with holds uploads without dropping jobs", () => {
  const parked = drainSettlePlan({ pending: 0, inFlight: 0, onDisk: 93, held: 54 });
  assert.equal(parked.upload, true);
  assert.equal(parked.releaseUnread, false);
  assert.equal(parked.clearQueue, false);
  assert.equal(parked.queueStopped, false);

  const active = drainSettlePlan({ pending: 53, inFlight: 1, onDisk: 54, held: 54 });
  assert.equal(active.releaseUnread, false);
  assert.equal(active.clearQueue, false);
  assert.equal(active.upload, true);

  // Leftover jobs and nothing waiting on them are not a comment read.
  const leftovers = drainSettlePlan({ pending: 0, inFlight: 0, onDisk: 93, held: 0 });
  assert.equal(leftovers.clearQueue, true);
  assert.equal(leftovers.upload, true);
});

test("an unknown queue is not treated as empty", () => {
  const plan = drainSettlePlan({ queueKnown: false, pending: 0, inFlight: 0, onDisk: 0, held: 10 });
  assert.equal(plan.releaseUnread, false);
  assert.equal(plan.clearQueue, false);
  assert.equal(plan.upload, true);
});
