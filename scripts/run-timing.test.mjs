import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function loadRunTiming() {
  const source = readFileSync(new URL("../src/run-timing.js", import.meta.url), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

const { beginCollect, timingAfterHydrate, emptyRunTiming } = loadRunTiming();

// 2026-09-29 20:25:13 PT, the stamp Reykjavik kept into the next day's run.
const PREVIOUS_START = Date.parse("2026-09-29T20:25:13-07:00");
const NEXT_START = PREVIOUS_START + 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

function finishedClock() {
  return {
    collectStartedAt: PREVIOUS_START,
    collectEndedAt: PREVIOUS_START + 8 * 60 * 1000,
    drainStartedAt: PREVIOUS_START + 8 * 60 * 1000,
    drainEndedAt: PREVIOUS_START + 9 * 60 * 1000,
    storeStartedAt: PREVIOUS_START + 9 * 60 * 1000,
    storeEndedAt: PREVIOUS_START + 10 * 60 * 1000,
  };
}

test("a new Start replaces the previous run's collectStartedAt", () => {
  const begun = beginCollect(finishedClock(), true, NEXT_START);
  assert.equal(begun.reset, true);
  assert.equal(begun.timing.collectStartedAt, NEXT_START);
  assert.equal(begun.timing.collectEndedAt, null);
  assert.equal(begun.timing.drainStartedAt, null);
  assert.equal(begun.timing.storeStartedAt, null);
  assert.equal(begun.timing.storeEndedAt, null);
});

test("a new Start still resets when the previous walk never stamped an end", () => {
  // A clearQueue recovery can leave collectStartedAt set and collectEndedAt
  // empty. Start is a new run either way.
  const stale = emptyRunTiming();
  stale.collectStartedAt = PREVIOUS_START;
  const begun = beginCollect(stale, true, NEXT_START);
  assert.equal(begun.timing.collectStartedAt, NEXT_START);
  assert.equal(begun.reset, true);
});

test("a storage read that started before Start cannot restore the old clock", () => {
  const stored = finishedClock();
  let generation = 0;
  const readGeneration = generation;
  const begun = beginCollect(stored, true, NEXT_START);
  if (begun.reset) generation += 1;
  const timing = timingAfterHydrate(begun.timing, stored, readGeneration, generation);
  assert.equal(timing.collectStartedAt, NEXT_START);
  assert.equal(timing.collectEndedAt, null);
});

test("hydrate keeps stored timing when no Start landed during the read", () => {
  const stored = finishedClock();
  const timing = timingAfterHydrate(emptyRunTiming(), stored, 0, 0);
  assert.equal(timing.collectStartedAt, PREVIOUS_START);
  assert.equal(timing.storeEndedAt, PREVIOUS_START + 10 * 60 * 1000);
});

test("resume keeps the start of a walk that has not ended", () => {
  const open = emptyRunTiming();
  open.collectStartedAt = PREVIOUS_START;
  const begun = beginCollect(open, false, NEXT_START);
  assert.equal(begun.reset, false);
  assert.equal(begun.timing.collectStartedAt, PREVIOUS_START);
});

test("a finished clock starts over even when the caller did not ask to reset", () => {
  const begun = beginCollect(finishedClock(), false, NEXT_START);
  assert.equal(begun.reset, true);
  assert.equal(begun.timing.collectStartedAt, NEXT_START);
});
