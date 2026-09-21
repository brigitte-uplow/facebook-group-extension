// Scrolling that does not look like a script did it.
//
// Every scroll is broken into a handful of decaying ticks with jittered sizes
// and delays, drawn from `motion.random` so a test can seed them. `pace` also
// watches how long a sleep actually took and stretches later ticks when the tab
// is lagging, which keeps the gesture plausible on a busy page.
(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const motion = { sleep, now: () => Date.now(), random: Math.random };

  function setMotion(overrides = {}) {
    for (const key of ["sleep", "now", "random"]) {
      if (typeof overrides[key] === "function") motion[key] = overrides[key];
    }
    return motion;
  }

  // mulberry32. Nothing here needs a good distribution, only a repeatable one.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  const nextRandom = () => motion.random();
  const randFloat = (min, max) => min + nextRandom() * (max - min);
  const randInt = (min, max) => Math.floor(randFloat(min, max + 1));
  const LAG_SMOOTHING = 0.3;
  const LAG_RECOVERY = 0.45;
  const MAX_LAG_FACTOR = 4;
  let lagFactor = 1;

  const lag = () => lagFactor;
  function resetLag() {
    lagFactor = 1;
  }
  async function pace(ms) {
    const requested = Math.max(1, Math.round(ms));
    const before = motion.now();
    await motion.sleep(requested);
    const actual = motion.now() - before;
    // Short ticks (6–12ms) routinely overshoot by a few milliseconds. Treating
    // that jitter as lag made later bursts crawl and never recover.
    const slack = Math.max(8, Math.round(requested * 0.5));
    if (actual <= requested + slack) {
      if (lagFactor > 1) lagFactor += (1 - lagFactor) * LAG_RECOVERY;
      return;
    }
    const observed = Math.min(MAX_LAG_FACTOR, actual / requested);
    lagFactor += (observed - lagFactor) * LAG_SMOOTHING;
  }
  const MIN_TICKS = 2;
  const MAX_TICKS = 6;
  const MIN_TICK_MS = 12;
  const MAX_TICK_MS = 28;
  const MIN_DECAY = 0.82;
  const MAX_DECAY = 0.95;
  const MAX_TICK_PX = 220;
  const MAX_LAG_TICKS = 24;
  function tickCount(total) {
    const drawn = randInt(MIN_TICKS, MAX_TICKS);
    const needed = Math.max(
      Math.round(drawn * Math.min(lagFactor, 1.5)),
      Math.ceil(Math.abs(Math.round(total)) / MAX_TICK_PX)
    );
    return Math.min(MAX_LAG_TICKS, Math.max(drawn, needed));
  }

  function momentumWeights(ticks, decay) {
    const weights = [];
    let weight = 1;
    for (let index = 0; index < ticks; index += 1) {
      weights.push(weight);
      weight *= decay;
    }
    return weights;
  }
  const tickMs = (options, ticks) =>
    options.durationMs
      ? Math.max(1, Math.round(((options.durationMs * lagFactor) / ticks) * randFloat(0.8, 1.2)))
      : randInt(options.minTickMs ?? MIN_TICK_MS, options.maxTickMs ?? MAX_TICK_MS);
  async function glideBy(distance, options = {}) {
    const total = Math.round(distance);
    if (!total) return;
    const ticks = tickCount(total);
    const weights = momentumWeights(ticks, randFloat(MIN_DECAY, MAX_DECAY));
    const sum = weights.reduce((a, b) => a + b, 0);
    for (const weight of weights) {
      window.scrollBy?.(0, Math.round(((total * weight) / sum) * randFloat(0.85, 1.15)));
      await pace(tickMs(options, ticks));
    }
  }
  async function glideTo(y, options = {}) {
    const target = Math.max(0, Math.round(y));
    const ticks = tickCount(target - (window.scrollY || 0));
    const weights = momentumWeights(ticks, randFloat(MIN_DECAY, MAX_DECAY));
    let tail = weights.reduce((a, b) => a + b, 0);
    for (let index = 0; index < ticks; index += 1) {
      const remaining = target - (window.scrollY || 0);
      const share = weights[index] / tail;
      tail -= weights[index];
      const delta =
        index === ticks - 1 ? remaining : remaining * share * randFloat(0.85, 1.15);
      window.scrollBy?.(0, Math.round(delta));
      await pace(tickMs(options, ticks));
    }
  }

  globalThis.__fbGroupMotion = Object.freeze({
    sleep,
    motion,
    setMotion,
    seededRandom,
    nextRandom,
    randFloat,
    randInt,
    lag,
    resetLag,
    glideBy,
    glideTo,
  });
})();
