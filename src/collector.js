(() => {
  const S = globalThis.__fbGroupScraper;
  if (!S) return;

  const VERSION = "0.18.25";
  const HARVEST_DEBOUNCE_MS = 400;
  const SCROLL_THROTTLE_MS = 600;
  const RENDER_DEBOUNCE_MS = 250;
  const COLLECT_IDLE_MS = 1500;
  const MIN_POST_VISIBLE_RATIO = 0.6;
  const MIN_VIEWPORT_FILL_RATIO = 0.5;
  const MAX_TOP_RATIO = 0.75;
  const MAX_THREAD_ATTEMPTS = 2;
  const PERSIST_DEBOUNCE_MS = 800;
  const FLICK_MIN_PX = 380;
  const FLICK_MAX_PX = 780;
  const BURST_FLICKS = [2, 3];
  const BURST_GAP_MS = [8, 18];
  const BURST_TRAVEL_RATIO = 0.92;
  const OVERSHOOT_CHANCE = 0.01;
  const OVERSHOOT_PAUSE_MS = [30, 70];
  const OVERSHOOT_PX = [30, 100];
  const GLANCE_MS = [20, 60];
  const READING_MS = [80, 160];
  const READING_CHANCE = 0;
  const LANDED_READING_CHANCE = 0;
  const DISTRACTION_MS = [400, 700];
  const DISTRACTION_CHANCE = 0;
  const SETTLE_MS = [30, 70];
  const PAINT_SETTLE_MS = [50, 120];
  const PAINT_STABLE_SAMPLES = 2;
  const MAX_PAINT_WAIT_MS = 1600;
  const MIN_FEED_FILL = 0.7;
  const LANDING_MIN_RATIO = 0.05;
  const LANDING_MAX_RATIO = 0.4;
  // Longer posts hold the eye longer, up to a point.
  const READING_CHARS = 800;
  const MAX_READING_SCALE = 1.2;
  const MIN_POSTS_PER_MINUTE = 180;
  const MAX_POSTS_PER_MINUTE = 240;
  const MAX_STRETCH_MS = 0;
  const FLICK_TICK_MS = [6, 12];
  const BUDGET_POSTS_PER_MINUTE = 8;
  const STALL_MS = 60000;
  const BOTTOM_SLACK_PX = 4;
  const STOPPED_MESSAGE =
    "This tab is running a collector from a reloaded extension. Refresh the page to continue collecting.";
  // Nothing on this tab may navigate, so a tab that is off the feed is one a
  // reader has to bring back; the run says so rather than idling on a page it
  // cannot collect.
  const OFF_FEED_MESSAGE =
    "the tab left the group's feed — go back to the group and press Resume";
  const INITIAL_CUTOFF_PUBLISHED_AT = "2026-09-01T00:00:00+08:00";
  const INITIAL_CUTOFF_MS = Date.parse(INITIAL_CUTOFF_PUBLISHED_AT);
  const INCREMENTAL_WINDOW_MS = 48 * 60 * 60 * 1000;
  const PRE_CUTOFF_POSTS_TO_END_RUN = 8;
  const MAX_PAGE_UNAVAILABLE_MS = 600000;
  const UPLOAD_RETRY_DELAYS_MS = [5000, 30000];
  const STATE_VERSION = 7;
  const previous = globalThis.__fbGroupCollectorState;
  const state = (globalThis.__fbGroupCollectorState =
    previous?.stateVersion === STATE_VERSION
      ? previous
      : {
          stateVersion: STATE_VERSION,
          entries: new Map(),
          reachedCutoff: false,
          walkFinished: false,
          preCutoffStreak: 0,
          cutoff: INITIAL_CUTOFF_PUBLISHED_AT,
          cutoffMs: INITIAL_CUTOFF_MS,
          scrapeMode: "initial",
          lastDiscoveredAt: null,
          cutoffResolved: false,
          cutoffReason: null,
          uploaded: new Set(),
          queued: new Set(),
          queue: { pending: 0, inFlight: 0, failed: 0, parked: 0 },
          queuedPostIds: null,
          queueSeenAt: null,
          queueStopped: false,
          drainingComments: false,
          finishPromise: null,
          stopRequested: false,
          port: null,
          pingTimer: null,
          collected: 0,
          rendered: new Map(),
          groupKey: null,
          observer: null,
          listenersBound: false,
          hydrated: false,
          autoScrolling: false,
          // Whether this page load has already kicked off its run; see autoStart.
          autoStarted: false,
          // A load must not watch the feed or harvest. Facebook's own boot
          // scrolls, and walking every article then (or clicking See more /
          // permalinks) remounts the other group tabs. Armed by Start or a
          // real wheel/touch/key scroll, never by the page moving itself.
          harvestArmed: false,
          uploading: false,
          lastUpload: null,
          progress: null,
          lastHarvestAt: null,
          harvestChain: null,
          harvestPending: null,
          harvestTimer: null,
          persistTimer: null,
          navTimer: null,
          collectTimer: null,
          lastScrollHarvest: 0,
          offFeedSince: null,
          // Set once the extension this script came from is gone; see stop().
          stopped: false,
          threadAttempts: new Map(),
          elementAttempts: new WeakMap(),
          completedThreads: new Set(),
          completedElements: new WeakSet(),
          frontier: null,
          lastCollectedScrollY: null,
          collectAgain: false,
          feedOrder: null,
          feedOrderTries: 0,
          feedOrderMenuTries: 0,
          feedOrderSettled: false,
          feedOrderReason: null,
          options: {
            includeComments: true,
            // 0 keeps the whole thread.
            maxCommentsPerPost: 100,
            expandWhileCollecting: true,
            loadFullComments: true,
            commentOrder: "newest",
            feedOrder: "new",
          },
        });
  if (previous && previous !== state) {
    previous.stopped = true;
    previous.observer?.disconnect();
    clearTimeout(previous.harvestTimer);
    clearTimeout(previous.persistTimer);
    clearInterval(previous.navTimer);
    clearInterval(previous.collectTimer);
  }
  if (!state.completedThreads) state.completedThreads = new Set(state.finishedThreads || []);
  if (!state.completedElements) state.completedElements = new WeakSet();
  if (!state.threadAttempts) state.threadAttempts = new Map();
  if (!state.elementAttempts) state.elementAttempts = new WeakMap();
  if (!("frontier" in state)) state.frontier = null;
  if (!("lastCollectedScrollY" in state)) state.lastCollectedScrollY = null;
  if (!("collectAgain" in state)) state.collectAgain = false;
  if (!("offFeedSince" in state)) state.offFeedSince = null;
  if (!("autoStarted" in state)) state.autoStarted = false;
  if (!("harvestArmed" in state)) state.harvestArmed = false;
  if (!("collectTimer" in state)) state.collectTimer = null;
  if (!("feedOrder" in state)) state.feedOrder = null;
  if (!("feedOrderTries" in state)) state.feedOrderTries = 0;
  if (!("feedOrderMenuTries" in state)) state.feedOrderMenuTries = 0;
  if (!("feedOrderSettled" in state)) state.feedOrderSettled = false;
  if (!("feedOrderReason" in state)) state.feedOrderReason = null;
  if (!("reachedCutoff" in state)) state.reachedCutoff = false;
  if (!("walkFinished" in state)) state.walkFinished = false;
  if (!("preCutoffStreak" in state)) state.preCutoffStreak = 0;
  if (!("cutoff" in state)) state.cutoff = INITIAL_CUTOFF_PUBLISHED_AT;
  if (!("cutoffMs" in state)) state.cutoffMs = INITIAL_CUTOFF_MS;
  if (!("scrapeMode" in state)) state.scrapeMode = "initial";
  if (!("lastDiscoveredAt" in state)) state.lastDiscoveredAt = null;
  if (!("cutoffResolved" in state)) state.cutoffResolved = false;
  if (!("cutoffReason" in state)) state.cutoffReason = null;
  if (state.lookupVersion !== VERSION) {
    state.lookupVersion = VERSION;
    if (!state.autoScrolling) state.cutoffResolved = false;
  }
  if (!state.uploaded) state.uploaded = new Set();
  if (!state.queued) state.queued = new Set();
  if (!state.queue) state.queue = { pending: 0, inFlight: 0, failed: 0, parked: 0 };
  if (!("queueEpoch" in state)) state.queueEpoch = 0;
  if (!("queuedPostIds" in state)) state.queuedPostIds = null;
  if (!("queueSeenAt" in state)) state.queueSeenAt = null;
  if (!("queueStopped" in state)) state.queueStopped = false;
  if (!("drainingComments" in state)) state.drainingComments = false;
  if (!("finishPromise" in state)) state.finishPromise = null;
  if (!("stopRequested" in state)) state.stopRequested = false;
  if (!("port" in state)) state.port = null;
  if (!("pingTimer" in state)) state.pingTimer = null;
  if (!("collected" in state)) state.collected = state.entries.size;
  if (!("uploading" in state)) state.uploading = false;
  if (!("lastUpload" in state)) state.lastUpload = null;
  if (!("feedOrder" in state.options)) state.options.feedOrder = "new";
  delete state.finishedThreads;
  delete state.finishedElements;
  delete state.history;
  delete state.historyPending;
  delete state.reachedHistory;
  delete state.stored;
  delete state.storedPending;
  delete state.storedReason;
  delete state.unchanged;
  state.stopped = false;
  state.uploading = false;

  const groupKeyFromUrl = () => location.pathname.match(/\/groups\/([^/]+)/)?.[1] || null;
  const storageKey = (groupKey) => `collection:v${STATE_VERSION}:${groupKey}`;
  const drainKey = (groupKey) => `commentDrain:${groupKey}`;
  const staleStorageKeys = (groupKey) => [
    `collection:v6:${groupKey}`,
    `collection:v5:${groupKey}`,
    `collection:v4:${groupKey}`,
    `collection:v3:${groupKey}`,
    `collection:v2:${groupKey}`,
    `collection:${groupKey}`,
  ];
  const contextAlive = () => {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const hasStorage = () => !state.stopped && contextAlive() && Boolean(chrome.storage?.local);
  const tracing = () => globalThis.__fbGroupTrace !== false;
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    state.observer?.disconnect();
    state.observer = null;
    clearTimeout(state.harvestTimer);
    clearTimeout(state.persistTimer);
    clearInterval(state.navTimer);
    clearInterval(state.collectTimer);
    clearInterval(state.pingTimer);
    try {
      state.port?.disconnect();
    } catch {
      // Already gone with the extension this script came from.
    }
    state.port = null;
  }

  // chrome.storage rejects and throws for the same reason, so both funnel here.
  function withStorage(read) {
    if (!hasStorage()) return null;
    try {
      return read();
    } catch {
      stop();
      return null;
    }
  }

  /* --------------------------------------------------------------- merging */

  const longer = (a, b) => ((b || "").length > (a || "").length ? b : a);
  const maxCount = (a, b) => (b === null || b === undefined ? a ?? null : Math.max(a ?? 0, b));
  const firstOf = (a, b) => a ?? b ?? null;
  const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
  const ID_GUESS_WARNINGS = ["externalVideoId:from_attachment", "externalVideoId:borrowed_href"];
  const PAGE_STATE_WARNING = "externalVideoId:from_page_state";
  const ID_PROVENANCE_WARNINGS = [
    ...ID_GUESS_WARNINGS,
    PAGE_STATE_WARNING,
    "externalVideoId:page_state_mismatch",
  ];
  const guessedId = (capture) =>
    (capture?.warnings || []).some((code) => ID_GUESS_WARNINGS.includes(code));
  const fromPageState = (capture) => (capture?.warnings || []).includes(PAGE_STATE_WARNING);
  const idRank = (capture) => (fromPageState(capture) ? 0 : guessedId(capture) ? 2 : 1);
  const SOURCE_URL_WARNINGS = ["sourceUrl:derived_from_post_id", "sourceUrl:fallback_group_url"];
  const sourceRank = (capture) => {
    const warnings = capture?.warnings || [];
    if (warnings.includes("sourceUrl:fallback_group_url")) return 2;
    if (warnings.includes("sourceUrl:derived_from_post_id")) return 1;
    return 0;
  };

  function mergeSourceUrl(existing, incoming) {
    const readings = [existing, incoming].filter((capture) => capture?.sourceUrl);
    const best = readings.slice().sort((a, b) => sourceRank(a) - sourceRank(b))[0] || null;
    return {
      url: best?.sourceUrl ?? incoming.sourceUrl,
      warnings: (best?.warnings || []).filter((code) => SOURCE_URL_WARNINGS.includes(code)),
    };
  }
  const DATE_PROVENANCE_WARNINGS = [
    "post.publishedAt:from_body_text",
    "post.publishedAt:approximated_from_relative",
  ];
  const fromBodyText = (capture) =>
    (capture?.warnings || []).includes("post.publishedAt:from_body_text");

  function mergePublishedAt(existing, incoming) {
    const readings = [existing, incoming].filter((capture) => capture?.post?.publishedAt);
    const best =
      readings.slice().sort((a, b) => (fromBodyText(a) ? 1 : 0) - (fromBodyText(b) ? 1 : 0))[0] ||
      null;
    return {
      at: best?.post?.publishedAt ?? null,
      warnings: (best?.warnings || []).filter((code) => DATE_PROVENANCE_WARNINGS.includes(code)),
    };
  }
  const randomCaptureId = (capture) => (capture?.warnings || []).includes("captureId:random");

  function mergeCaptureId(existing, incoming) {
    if (randomCaptureId(existing) && !randomCaptureId(incoming)) return incoming.captureId;
    return existing.captureId;
  }

  function mergeExternalId(existing, incoming) {
    const readings = [existing, incoming].filter((capture) => capture?.externalVideoId);
    // Stable, so a tie keeps the reading already stored rather than churning it.
    const best = readings.slice().sort((a, b) => idRank(a) - idRank(b))[0] || null;
    return {
      id: best?.externalVideoId ?? null,
      // The winner's own provenance, and only the winner's.
      warnings: (best?.warnings || []).filter((code) => ID_PROVENANCE_WARNINGS.includes(code)),
    };
  }
  const WARNING_SUBJECTS = {
    "author.displayName": (capture) => capture.author?.displayName,
    "post.caption": (capture) => capture.post?.caption,
    "post.publishedAt": (capture) => capture.post?.publishedAt,
    "externalVideoId": (capture) => capture.externalVideoId,
    "metrics.likes": (capture) => capture.metrics?.likes,
  };

  function pruneWarnings(capture, warnings) {
    return warnings.filter((code) => {
      const [field, reason] = code.split(":");
      if (reason !== "missing" && reason !== "unresolved") return true;
      const read = WARNING_SUBJECTS[field];
      return read ? read(capture) === null || read(capture) === undefined : true;
    });
  }
  function mergeComments(existing = [], incoming = []) {
    const identify = (comment) => `${comment.authorHandle || ""}::${comment.text || ""}`;
    const saved = new Map(existing.map((comment) => [identify(comment), comment]));
    const [lead, rest] =
      incoming.length >= existing.length ? [incoming, existing] : [existing, incoming];

    const merged = new Map();
    for (const comment of [...lead, ...rest]) {
      const key = identify(comment);
      if (merged.has(key)) continue;
      const prior = saved.get(key);
      merged.set(
        key,
        prior === comment
          ? comment
          : {
              ...comment,
              likes: maxCount(comment.likes, prior?.likes),
              // The earliest reading of a relative age is the closest to true.
              publishedAt: firstOf(prior?.publishedAt, comment.publishedAt),
            }
      );
    }
    return Array.from(merged.values());
  }
  function mergeCapture(existing, incoming) {
    if (!existing) return incoming;

    const externalId = mergeExternalId(existing, incoming);
    // A real permalink beats a derived or fallback one whichever pass found it.
    const source = mergeSourceUrl(existing, incoming);
    const published = mergePublishedAt(existing, incoming);

    const merged = {
      ...existing,
      ...incoming,
      captureId: mergeCaptureId(existing, incoming),
      sourceUrl: source.url,
      externalVideoId: externalId.id,
      group: incoming.group || existing.group,
      author: {
        handle: firstOf(existing.author?.handle, incoming.author?.handle),
        displayName: firstOf(existing.author?.displayName, incoming.author?.displayName),
        profileUrl: firstOf(existing.author?.profileUrl, incoming.author?.profileUrl),
        verified: firstOf(existing.author?.verified, incoming.author?.verified),
      },
      post: {
        caption: longer(existing.post?.caption, incoming.post?.caption),
        hashtags: union(existing.post?.hashtags, incoming.post?.hashtags),
        publishedAt: published.at,
        hasVideo: Boolean(existing.post?.hasVideo || incoming.post?.hasVideo),
        thumbnailUrl: firstOf(existing.post?.thumbnailUrl, incoming.post?.thumbnailUrl),
        durationSeconds: firstOf(existing.post?.durationSeconds, incoming.post?.durationSeconds),
        soundName: firstOf(existing.post?.soundName, incoming.post?.soundName),
      },
      metrics: {
        likes: maxCount(existing.metrics?.likes, incoming.metrics?.likes),
        comments: maxCount(existing.metrics?.comments, incoming.metrics?.comments),
        shares: maxCount(existing.metrics?.shares, incoming.metrics?.shares),
        views: maxCount(existing.metrics?.views, incoming.metrics?.views),
        saves: maxCount(existing.metrics?.saves, incoming.metrics?.saves),
      },
      comments: mergeComments(existing.comments, incoming.comments),
      commentsComplete: Boolean(existing.commentsComplete || incoming.commentsComplete),
    };
    merged.warnings = union(
      pruneWarnings(merged, union(existing.warnings, incoming.warnings)).filter(
        (code) =>
          !ID_PROVENANCE_WARNINGS.includes(code) &&
          !SOURCE_URL_WARNINGS.includes(code) &&
          !DATE_PROVENANCE_WARNINGS.includes(code) &&
          code !== "captureId:random"
      ),
      [
        ...externalId.warnings,
        ...source.warnings,
        ...published.warnings,
        ...(randomCaptureId(existing) && randomCaptureId(incoming) ? ["captureId:random"] : []),
      ]
    );
    return merged;
  }

  /* -------------------------------------------------- comments seen as posts */
  const orphanComments = new Map();

  const parentKeys = (parsed) => [parsed.parentPostId, parsed.parentPostUrl].filter(Boolean);

  function findEntry(keys) {
    for (const entry of state.entries.values()) {
      if (keys.includes(entry.capture.externalVideoId) || keys.includes(entry.key)) return entry;
    }
    return null;
  }

  function hold(keys, comments) {
    for (const key of keys) orphanComments.set(key, mergeComments(orphanComments.get(key), comments));
  }

  function takeHeld(keys) {
    const held = [];
    for (const key of keys) {
      const waiting = orphanComments.get(key);
      if (!waiting) continue;
      held.push(...waiting);
      orphanComments.delete(key);
    }
    return held;
  }

  // True when the post's thread grew, so the caller knows to persist.
  function attachComment(parsed) {
    const keys = parentKeys(parsed);
    if (!keys.length) return false;

    const entry = findEntry(keys);
    if (!entry) {
      hold(keys, [parsed.comment]);
      return false;
    }

    const comments = mergeComments(entry.capture.comments, [...takeHeld(keys), parsed.comment]);
    if (comments.length === (entry.capture.comments || []).length) return false;
    entry.capture = { ...entry.capture, comments };
    return true;
  }

  /* ------------------------------------------------------------- persistence */
  // The backstop behind the real test below, for a queue that says it owes a post
  // an answer and never produces one. Every job either delivers or fails and
  // delivers, so this is close to unreachable — which is the point. It used to be
  // three minutes, and three minutes against a queue of fifty-odd permalink loads
  // expired on nearly every post before its turn came.
  const PENDING_COMMENTS_MAX_MS = 2400000;
  // A job is queued by a message still in flight, so a post is not abandoned
  // merely because the queue has not registered it yet.
  const PENDING_GRACE_MS = 60000;
  // Reading the queue is what makes "abandoned" answerable; a stale reading is
  // not evidence about the queue as it is now.
  const QUEUE_READING_MAX_AGE_MS = 60000;
  // Draining a long queue is a permalink load per post, so the wait at the end
  // of a run is nothing like the wait for one thread.
  const DRAIN_MAX_MS = 1800000;
  const holdingComments = (entry) => Boolean(entry.pendingComments);
  const hasHeldPosts = () => {
    for (const entry of state.entries.values()) if (holdingComments(entry)) return true;
    return false;
  };

  // The hold is three minutes of waiting for an answer, and it only means
  // anything once something is answering. Nothing is read while the walk is
  // going — the worker would remount the tab doing the walking — so a clock
  // started when the post was queued expired on every post an hour-long walk
  // met in its first minutes, and they were filed as `comments:worker_timeout`
  // before the worker had been asked for them. `finishRun` restarts the clock
  // when it starts draining.
  function restartPendingClocks() {
    const now = Date.now();
    for (const entry of state.entries.values()) {
      if (entry.pendingComments) entry.pendingComments.at = now;
    }
  }

  // A hold is only worth anything while something is answering it, and the
  // question worth asking is not how long the post has waited but whether the
  // queue still owes it an answer. A job queued, being read, or parked on disk
  // means yes, and the post waits — however long that takes, across runs if need
  // be, because a post stored without its thread is a reading of two comments
  // filed as the post's engagement and nothing downstream can see that it is one.
  // A post whose job exists nowhere is waiting on nothing, and that is the only
  // reason to give up on it.
  function releaseAbandonedPending() {
    if (state.autoScrolling) return;
    if (state.queueStopped && !state.drainingComments) return;
    const seenAt = state.queueSeenAt;
    const fresh = seenAt !== null && Date.now() - seenAt < QUEUE_READING_MAX_AGE_MS;
    const now = Date.now();

    for (const entry of state.entries.values()) {
      const pending = entry.pendingComments;
      if (!pending) continue;
      const waited = now - (Number(pending.at) || now);
      if (waited < PENDING_GRACE_MS) continue;
      const owed = !fresh || Boolean(state.queuedPostIds?.has(pending.postId));
      if (owed && waited < PENDING_COMMENTS_MAX_MS) continue;
      entry.pendingComments = null;
      entry.capture = {
        ...entry.capture,
        phase: "full",
        warnings: union(entry.capture.warnings, [
          owed ? "comments:worker_timeout" : "comments:worker_lost",
        ]),
      };
    }
  }

  // Which of the contract's two phases this reading is. A post still owed
  // comments is `fast` and stays in the buffer; one the worker has had its say
  // about, or that never needed one, is `full` and is the only kind that is ever
  // uploaded. Stamped where the answer changes rather than as the capture is
  // handed to the upload, so the object the backend answered for stays the object
  // in the buffer — a capture the walk replaced while the request was in flight
  // has to be offered again, and identity is how that is told.
  const phaseFor = (entry) => (holdingComments(entry) ? "fast" : "full");

  function stampPhase(entry) {
    const phase = phaseFor(entry);
    if (entry.capture?.phase !== phase) entry.capture = { ...entry.capture, phase };
    return entry;
  }

  // The posts done being read, and nothing else. A post whose thread is still
  // coming is not offered: storing it would file the two comments its feed card
  // happened to preview as the run's reading of the thread, and `ingest_engagement`
  // marks a claimed video completed on the strength of it.
  const toCaptures = () => {
    releaseAbandonedPending();
    return Array.from(state.entries.values())
      .filter((entry) => !holdingComments(entry))
      .map((entry) => entry.capture);
  };

  // The ingest_engagement payload, verbatim.
  function toExport() {
    return { captures: toCaptures() };
  }

  function persistNow() {
    if (!state.groupKey) return;
    withStorage(() =>
      chrome.storage.local.set({
        [storageKey(state.groupKey)]: {
          collectorVersion: VERSION,
          group: S.getGroup(),
          entries: Array.from(state.entries.values()),
          collected: state.collected,
          reachedCutoff: state.reachedCutoff,
          walkFinished: state.walkFinished,
          cutoff: state.cutoff,
          cutoffMs: state.cutoffMs,
          scrapeMode: state.scrapeMode,
          lastDiscoveredAt: state.lastDiscoveredAt,
          drainingComments: state.drainingComments,
          queueStopped: state.queueStopped,
        },
      })
    )?.catch?.(stop);
  }

  function persistSoon() {
    if (state.stopped) return;
    clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
  }
  function entryKey(entry) {
    const capture = entry.capture;
    return fromPageState(capture) && capture.externalVideoId ? capture.externalVideoId : entry.key;
  }
  function adoptEntry(a, b) {
    const [older, newer] = (a.firstSeenAt || "") <= (b.firstSeenAt || "") ? [a, b] : [b, a];
    return {
      key: older.key,
      truncated: Boolean(older.truncated || newer.truncated),
      firstSeenAt: older.firstSeenAt || newer.firstSeenAt,
      capture: mergeCapture(older.capture, newer.capture),
      // Kept rather than dropped: a held post adopted into another entry would
      // otherwise lose its hold and be uploaded without the thread it is waiting
      // for.
      pendingComments: older.pendingComments || newer.pendingComments || null,
    };
  }

  async function hydrate() {
    const groupKey = groupKeyFromUrl();
    if (!groupKey) return;
    if (state.groupKey !== groupKey) {
      state.groupKey = groupKey;
      state.entries.clear();
      state.collected = 0;
      state.reachedCutoff = false;
      state.walkFinished = false;
      state.preCutoffStreak = 0;
      applyInitialCutoff();
      state.cutoffResolved = false;
      state.uploaded.clear();
      state.queued.clear();
      state.hydrated = false;
      state.drainingComments = false;
      state.finishPromise = null;
    }
    if (state.hydrated || !hasStorage()) {
      if (!state.autoScrolling && !state.cutoffResolved) await resolveCutoff();
      if (state.hydrated || !hasStorage()) return;
    }

    const key = storageKey(groupKey);
    const saved = await withStorage(() => chrome.storage.local.get([key]))?.catch(stop);
    if (!saved) {
      state.hydrated = true;
      await resolveCutoff();
      return;
    }
    const stored = saved[key];
    (stored?.entries || []).forEach((entry) => {
      if (!entry?.key || !entry.capture) return;
      const entryK = entryKey(entry);
      const held = state.entries.get(entryK);
      state.entries.set(
        entryK,
        held ? adoptEntry(held, { ...entry, key: entryK }) : { ...entry, key: entryK }
      );
    });
    state.collected = state.entries.size ? stored?.collected ?? state.entries.size : 0;
    if (typeof stored?.reachedCutoff === "boolean") state.reachedCutoff = stored.reachedCutoff;
    if (typeof stored?.walkFinished === "boolean") state.walkFinished = stored.walkFinished;
    state.drainingComments = Boolean(stored?.drainingComments);
    if (typeof stored?.queueStopped === "boolean") state.queueStopped = stored.queueStopped;
    for (const entry of state.entries.values()) {
      // A buffer written by a build that did not know about the two phases has
      // captures claiming to be full while still waiting on the worker.
      stampPhase(entry);
      if (!entry.pendingComments) continue;
      entry.pendingComments = { ...entry.pendingComments, at: Date.now() };
      state.queued.add(entry.pendingComments.postId);
    }

    await withStorage(() => chrome.storage.local.remove(staleStorageKeys(groupKey)))?.catch(stop);
    if (!state.drainingComments) {
      const flag = await withStorage(() => chrome.storage.local.get([drainKey(groupKey)]))?.catch(stop);
      state.drainingComments = Boolean(flag?.[drainKey(groupKey)]?.draining);
    }
    state.hydrated = true;
    if (state.autoScrolling && typeof stored?.cutoffMs === "number" && Number.isFinite(stored.cutoffMs)) {
      state.cutoffMs = stored.cutoffMs;
      state.cutoff = stored.cutoff || new Date(stored.cutoffMs).toISOString();
      state.scrapeMode = stored.scrapeMode === "incremental" ? "incremental" : "initial";
      state.lastDiscoveredAt = stored.lastDiscoveredAt || null;
      state.cutoffResolved = true;
    } else {
      await resolveCutoff();
    }
  }

  async function setDrainFlag(on) {
    if (!state.groupKey) return;
    const key = drainKey(state.groupKey);
    await withStorage(() =>
      on
        ? chrome.storage.local.set({ [key]: { draining: true, at: Date.now() } })
        : chrome.storage.local.remove(key)
    )?.catch(stop);
  }

  /* -------------------------------------------------------------- boundaries */
  function askBackground(message) {
    if (!hasStorage() || !chrome.runtime?.sendMessage) return Promise.resolve(null);
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }
  const statedDate = (capture) =>
    !(capture?.warnings || []).includes("post.publishedAt:from_body_text");
  function applyInitialCutoff() {
    state.cutoff = INITIAL_CUTOFF_PUBLISHED_AT;
    state.cutoffMs = INITIAL_CUTOFF_MS;
    state.scrapeMode = "initial";
    state.lastDiscoveredAt = null;
  }
  function applyIncrementalCutoff(lastDiscoveredAt) {
    const cutoffMs = Date.now() - INCREMENTAL_WINDOW_MS;
    state.cutoffMs = cutoffMs;
    state.cutoff = new Date(cutoffMs).toISOString();
    state.scrapeMode = "incremental";
    state.lastDiscoveredAt = lastDiscoveredAt;
  }
  async function resolveCutoff() {
    const answer = await askBackground({
      type: "lookupGroupOutlet",
      groupKey: state.groupKey || groupKeyFromUrl(),
      groupName: S.getGroup()?.name || null,
    });
    if (!answer || answer.error) return state.scrapeMode;
    const lastDiscoveredAt = answer.lastDiscoveredAt || null;
    if (lastDiscoveredAt) applyIncrementalCutoff(lastDiscoveredAt);
    else applyInitialCutoff();
    state.cutoffResolved = true;
    state.cutoffReason = answer.reason || (lastDiscoveredAt ? "last_discovered_at" : "null");
    persistSoon();
    return state.scrapeMode;
  }
  function beforeCutoff(capture) {
    const publishedAt = capture?.post?.publishedAt;
    if (!publishedAt || !statedDate(capture)) return false;
    const at = Date.parse(publishedAt);
    return Number.isFinite(at) && at < state.cutoffMs;
  }
  const afterCutoff = (capture) => {
    const publishedAt = capture?.post?.publishedAt;
    if (!publishedAt || !statedDate(capture)) return false;
    const at = Date.parse(publishedAt);
    return Number.isFinite(at) && at >= state.cutoffMs;
  };
  const isChronologicalFeedOrder = (order) =>
    /^new (posts|listings)$/i.test(order || "");
  const alreadyUploaded = (postId) => Boolean(postId) && state.uploaded.has(postId);

  // The cutoff, reached. The only way a run is finished rather than interrupted.
  const runComplete = () => state.reachedCutoff;

  /* ------------------------------------------------------------- comment queue */
  const PING_MS = 20000;

  function openRunPort() {
    if (state.port || !hasStorage() || !chrome.runtime?.connect) return;
    try {
      state.port = chrome.runtime.connect({ name: "fb-scraper-run" });
      state.port.onDisconnect?.addListener?.(() => {
        state.port = null;
      });
      state.port.postMessage?.({
        type: "resumeQueue",
        groupKey: state.groupKey,
        start: Boolean(state.drainingComments),
      });
      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => {
        if (state.stopped) return;
        try {
          state.port?.postMessage?.({ type: "ping" });
        } catch {
          state.port = null;
        }
      }, PING_MS);
    } catch {
      // No extension behind this script any more; stop() will notice.
      state.port = null;
    }
  }
  function queueComments(postId, url, capture) {
    if (!postId || !url) return false;
    if (state.queued.has(postId)) return false;
    state.queued.add(postId);
    state.queueStopped = false;
    askBackground({
      type: "queueComments",
      postId,
      url,
      groupKey: state.groupKey,
      // Queued now, read later — always. The worker's permalink loads remount
      // every Facebook tab in the profile, the feed tab among them, and a
      // remount mid-walk is a full reload that sends the run back to the top of
      // the feed. `finishRun` is the only thing that drains this queue, so
      // there is exactly one moment in a session when the worker runs and it is
      // the moment nothing is left to lose.
      defer: true,
      expected: capture?.metrics?.comments ?? null,
      options: {
        target: state.options.maxCommentsPerPost,
        order: state.options.commentOrder || null,
        includeReplies: true,
        expected: capture?.metrics?.comments ?? null,
        waitMs: 45000,
      },
    }).then((answer) => {
      if (!answer || answer.error) state.queued.delete(postId);
    });
    return true;
  }
  async function refreshQueueStatus() {
    const epoch = state.queueEpoch;
    const answer = await askBackground({ type: "queueStatus", groupKey: state.groupKey });
    if (epoch !== state.queueEpoch) return state.queue;
    if (!answer || answer.error) return state.queue;
    state.queue = {
      pending: Number(answer.pending) || 0,
      inFlight: Number(answer.inFlight) || 0,
      failed: Number(answer.failed) || 0,
      parked: Number(answer.parked) || 0,
      lanes: Number(answer.lanes) || 1,
    };
    // Which posts the queue still owes an answer for, and when that was last
    // true. Kept off the status object: it is evidence for the hold, not a
    // number for a reader.
    if (Array.isArray(answer.postIds)) {
      state.queuedPostIds = new Set(answer.postIds);
      state.queueSeenAt = Date.now();
    }
    return state.queue;
  }
  function entryForQueuedPost(postId, url) {
    for (const entry of state.entries.values()) {
      if (entry.pendingComments?.postId === postId) return entry;
    }
    for (const entry of state.entries.values()) {
      if (entry.capture?.externalVideoId && entry.capture.externalVideoId === postId) return entry;
      if (url && entry.capture?.sourceUrl === url) return entry;
    }
    return null;
  }
  function applyCommentsReady(message) {
    const postId = message?.postId ?? null;
    const result = message?.result || {};
    state.queued.delete(postId);

    const entry = entryForQueuedPost(postId, message?.url || null);
    if (!entry) return { applied: false, reason: "no_entry" };

    const comments = mergeComments(entry.capture.comments, result.comments || []);
    const expected = result.expected ?? null;
    // The worker has had its say, so this reading is the full one however much
    // of the thread it managed to get.
    const capture = { ...entry.capture, comments, phase: "full" };
    capture.commentsComplete = Boolean(
      result.exhausted || (expected !== null && expected > 0 && comments.length >= expected)
    );
    if (result.verified === false) {
      capture.warnings = union(capture.warnings, ["comments:unsorted"]);
    }
    if (result.error) {
      capture.warnings = union(capture.warnings, ["comments:worker_failed"]);
    } else if (comments.length) {
      capture.warnings = (capture.warnings || []).filter((code) => code !== "comments:worker_failed");
    }
    entry.capture = capture;
    entry.pendingComments = null;
    // Persisted, not uploaded. The post is whole now and will go with the batch
    // the run hands over when it ends; what the hold exists for is that its
    // comments are here to go with it, not that they arrive in a request of
    // their own.
    persistNow();
    return { applied: true, comments: comments.length };
  }
  function noteQueueCleared(lanes) {
    state.queueEpoch += 1;
    state.queued.clear();
    state.queuedPostIds = new Set();
    state.queueSeenAt = Date.now();
    state.queue = { pending: 0, inFlight: 0, failed: 0, parked: 0, lanes: lanes || 1 };
  }

  // Jobs left on the worker after every post has already been released. They
  // are not a comment read anyone is waiting on — a finished job written back
  // to disk, then loaded again — and waiting on them is what keeps the popup
  // on "8 queued" and holds the upload back.
  async function dropQueueIfNothingHeld() {
    if (state.autoScrolling || state.stopped || state.stopRequested) return false;
    if (hasHeldPosts()) return false;
    // Flush first so a result that is already back still lands on its post.
    // Then drop the queue even when this tab's copy looks empty: the leftover
    // jobs are often only on disk, and resume would load them and keep the
    // count stuck.
    await askBackground({ type: "flushComments", groupKey: state.groupKey });
    if (hasHeldPosts()) return false;
    const queue = await refreshQueueStatus();
    await askBackground({ type: "clearQueue", groupKey: state.groupKey });
    noteQueueCleared(queue.lanes);
    return true;
  }

  async function waitForQueue(maxMs = PENDING_COMMENTS_MAX_MS) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && !state.stopped && !state.stopRequested) {
      const queue = await refreshQueueStatus();
      if (!queue.pending && !queue.inFlight) return true;
      if (await dropQueueIfNothingHeld()) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }
  async function waitForHeld(maxMs = 20000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && !state.stopped && !state.stopRequested) {
      await askBackground({ type: "flushComments", groupKey: state.groupKey });
      let held = 0;
      for (const entry of state.entries.values()) if (holdingComments(entry)) held += 1;
      if (!held) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /* ----------------------------------------------------------- rendered map */
  function visibility(element) {
    const rect = element.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const visible = Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    return {
      top: rect.top,
      height,
      ofPost: rect.height ? visible / rect.height : 0,
      ofViewport: height ? visible / height : 0,
    };
  }
  const hasLayout = () => document.documentElement.getBoundingClientRect().height > 0;

  const isOnScreenEnough = (view) =>
    view.top < view.height * MAX_TOP_RATIO &&
    (view.ofPost >= MIN_POST_VISIBLE_RATIO || view.ofViewport >= MIN_VIEWPORT_FILL_RATIO);
  const isEligible = (view) => !view || isOnScreenEnough(view);
  // A post that has already moved above the viewport is still ours if the node
  // is in the document. Skipping it to take a later in-view post is how a
  // burst overshoots and a thread never gets a harvest.
  const shouldCollect = (view) => !view || view.top < 0 || isOnScreenEnough(view);
  function syncRendered() {
    const rendered = new Map();
    const measure = hasLayout();
    for (const element of S.detectPosts().posts) {
      rendered.set(element, measure ? visibility(element) : null);
    }
    state.rendered = rendered;
    return rendered;
  }

  /* ---------------------------------------------------------------- harvest */

  const threadDone = (element, permalink) =>
    (permalink && state.completedThreads.has(permalink)) || state.completedElements.has(element);

  const attemptsFor = (element, permalink) =>
    Math.max(
      permalink ? state.threadAttempts.get(permalink) || 0 : 0,
      state.elementAttempts.get(element) || 0
    );
  function countAttempt(element, permalink) {
    if (permalink) state.threadAttempts.set(permalink, (state.threadAttempts.get(permalink) || 0) + 1);
    else state.elementAttempts.set(element, (state.elementAttempts.get(element) || 0) + 1);
  }
  async function readThread(element, permalink) {
    const { maxCommentsPerPost, commentOrder } = state.options;

    countAttempt(element, permalink);

    try {
      const thread = await S.captureThread(element, {
        target: maxCommentsPerPost,
        order: commentOrder || null,
        scrapedAt: new Date().toISOString(),
      });
      if (permalink) state.completedThreads.add(permalink);
      state.completedElements.add(element);
      return { ...thread, ok: true };
    } catch {
      return {
        comments: [],
        exhausted: false,
        expected: null,
        needsWorker: true,
        verified: null,
        ok: false,
      };
    }
  }

  /* --------------------------------------------------------------- selection */

  const frontierElement = () => {
    const element = state.frontier?.deref?.() || null;
    if (element?.isConnected) return element;
    state.frontier = null;
    return null;
  };

  const atOrAfterFrontier = (element, frontier) =>
    !frontier ||
    element === frontier ||
    Boolean(frontier.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);

  function advanceFrontier(element) {
    const current = frontierElement();
    if (current && current !== element && !atOrAfterFrontier(element, current)) return;
    state.frontier = new WeakRef(element);
  }
  function selectNext(visited, rendered) {
    const map = rendered || syncRendered();
    const frontier = frontierElement();

    for (const [element, view] of map) {
      if (visited.has(element) || !element.isConnected) continue;
      if (!atOrAfterFrontier(element, frontier)) continue;
      const permalink = S.getPermalink(element);
      if (threadDone(element, permalink)) continue;
      // A post that failed once is not skipped: it is first in line next pass.
      if (attemptsFor(element, permalink) >= MAX_THREAD_ATTEMPTS) continue;
      // Not on screen yet. Stop here so a later post does not become the
      // frontier and strand this one.
      if (!shouldCollect(view)) return null;
      return element;
    }
    return null;
  }
  async function collectPost(element) {
    const outcome = { complete: false, added: 0, updated: 0, ended: false };
    const { includeComments, maxCommentsPerPost, expandWhileCollecting, loadFullComments } =
      state.options;
    const now = new Date().toISOString();
    let permalink = null;
    try {
      if (!element.isConnected) return countedFailure(element, permalink, outcome);
      // Always wait for the caption to settle, even on a fast burst: See more
      // often paints a beat after the card, and the expanded text arrives later.
      if (expandWhileCollecting) {
        await S.expandText(element);
      }
      if (!element.isConnected) return countedFailure(element, permalink, outcome);
      if (!S.pageStatePostId?.(element)?.id) {
        await S.revealPermalink(element).catch(() => null);
        if (!element.isConnected) return countedFailure(element, permalink, outcome);
      }
      const parsed = S.parsePost(element, {
        includeComments,
        maxCommentsPerPost,
        scrapedAt: now,
      });
      permalink = parsed.permalink;
      if (!parsed.key.trim() || parsed.key === "::") {
        return countedFailure(element, permalink, outcome);
      }
      // Skip recycled placeholders: no permalink and no caption is not a post.
      if (!parsed.permalink && !parsed.capture.post?.caption) {
        return countedFailure(element, permalink, outcome);
      }
      if (parsed.comment) {
        if (parsed.comment.text && attachComment(parsed)) outcome.updated += 1;
        outcome.complete = true;
        return outcome;
      }
      if (beforeCutoff(parsed.capture)) {
        if (state.feedOrderSettled && isChronologicalFeedOrder(state.feedOrder)) {
          state.preCutoffStreak += 1;
          if (state.preCutoffStreak >= PRE_CUTOFF_POSTS_TO_END_RUN) {
            state.reachedCutoff = true;
            outcome.ended = true;
            return outcome;
          }
        }
        outcome.complete = true;
        return outcome;
      }
      if (afterCutoff(parsed.capture)) state.preCutoffStreak = 0;
      if (alreadyUploaded(parsed.capture.externalVideoId)) {
        outcome.complete = true;
        return outcome;
      }

      let capture = parsed.capture;
      let pendingComments = null;
      const hasThread =
        Boolean(S.getCommentCount(element)) || S.renderedCommentCount(element) > 0;
      const tally = S.getCommentCount(element);
      const wholeThreadOnScreen =
        tally !== null && tally > 0 && (capture.comments || []).length >= tally;
      if (wholeThreadOnScreen) capture = { ...capture, commentsComplete: true };
      if (
        includeComments &&
        loadFullComments &&
        hasThread &&
        !wholeThreadOnScreen &&
        !threadDone(element, permalink)
      ) {
        const thread = await readThread(element, permalink);
        if (thread.comments?.length) {
          capture = {
            ...capture,
            comments: mergeComments(capture.comments, thread.comments),
          };
        }
        capture.commentsComplete =
          !thread.needsWorker &&
          (thread.exhausted ||
            (thread.expected !== null && capture.comments.length >= thread.expected));
        if (thread.verified === false) {
          capture.warnings = union(capture.warnings, ["comments:unsorted"]);
        }
        if (thread.needsWorker) {
          const jobId = capture.externalVideoId || permalink;
          const jobUrl = capture.sourceUrl || permalink;
          if (jobId && jobUrl && queueComments(jobId, jobUrl, capture)) {
            pendingComments = { postId: jobId, url: jobUrl, at: Date.now() };
            capture.commentsComplete = false;
          } else if (!state.queued.has(jobId)) {
            capture.warnings = union(capture.warnings, ["comments:worker_unavailable"]);
          }
        }
      }

      const existing = takeEntry(parsed);
      if (existing) outcome.updated += 1;
      else outcome.added += 1;
      const merged = mergeCapture(existing?.capture, capture);
      const key = entryKey({ key: parsed.key, capture: merged });
      // Replies to this post that the feed rendered before the post itself.
      const held = takeHeld([merged.externalVideoId, key, parsed.key].filter(Boolean));
      if (held.length) merged.comments = mergeComments(merged.comments, held);
      state.entries.set(
        key,
        stampPhase({
          key,
          truncated: parsed.truncated,
          firstSeenAt: existing?.firstSeenAt || now,
          capture: merged,
          pendingComments: pendingComments || existing?.pendingComments || null,
        })
      );
      outcome.complete = true;
      return outcome;
    } catch {
      return countedFailure(element, permalink, outcome);
    }
  }
  function takeEntry(parsed) {
    for (const key of [parsed.key, ...(parsed.altKeys || [])]) {
      const entry = state.entries.get(key);
      if (!entry) continue;
      if (key !== parsed.key) state.entries.delete(key);
      return entry;
    }
    if (!parsed.permalink) return null;
    for (const entry of state.entries.values()) {
      if (entry.capture?.sourceUrl !== parsed.permalink) continue;
      state.entries.delete(entry.key);
      return entry;
    }
    return null;
  }
  function countedFailure(element, permalink, outcome) {
    countAttempt(element, permalink);
    return outcome;
  }
  const NEAR_TOP_PX = 80;
  const JUMP_RESTORE_MIN_PX = 400;

  async function recoverIfJumpedToTop() {
    const saved = state.lastCollectedScrollY;
    const y = window.scrollY || 0;
    if (saved == null || saved < JUMP_RESTORE_MIN_PX) return false;
    if (y > NEAR_TOP_PX) return false;
    if (!S.onGroupFeed()) return false;
    await S.glideTo(saved, { durationMs: S.randInt(400, 700) }).catch(() => {});
    for (let i = 0; i < 4 && (window.scrollY || 0) < saved * 0.45; i += 1) {
      const step = Math.min(900, saved - (window.scrollY || 0));
      if (step <= 0) break;
      await S.glideBy(step).catch(() => {});
      await sleep(S.randInt(250, 450));
    }
    return (window.scrollY || 0) > NEAR_TOP_PX;
  }
  const MAX_FEED_ORDER_TRIES = 20;
  const MAX_FEED_MENU_TRIES = 3;
  const RETRYABLE_FEED_ORDER_REASONS = ["control_not_found", "page_busy"];
  const FEED_ORDER_SCROLL_GUARD_PX = 250;

  async function ensureFeedOrder() {
    const wanted = state.options.feedOrder;
    if (!wanted || state.feedOrderSettled) return state.feedOrder;
    if (state.feedOrderTries >= MAX_FEED_ORDER_TRIES) return state.feedOrder;
    if ((window.scrollY || 0) > FEED_ORDER_SCROLL_GUARD_PX) {
      state.feedOrderSettled = true;
      state.feedOrderReason = state.feedOrderReason || "skipped_mid_scroll";
      return state.feedOrder;
    }
    state.feedOrderTries += 1;

    const { order, reason } = await S.setFeedOrder(wanted).catch(() => ({
      order: null,
      reason: "failed",
    }));
    state.feedOrderReason = reason;
    if (order) state.feedOrder = order;

    if (!reason || reason === "already_set") state.feedOrderSettled = true;
    else if (reason === "menu_item_not_found") {
      state.feedOrderMenuTries += 1;
      if (state.feedOrderMenuTries >= MAX_FEED_MENU_TRIES) state.feedOrderSettled = true;
    } else if (!RETRYABLE_FEED_ORDER_REASONS.includes(reason)) {
      state.feedOrderSettled = true;
    }
    // The feed the pass was about to read is gone; the caller re-measures.
    return state.feedOrder;
  }
  async function harvestNow() {
    if (state.stopped) return { added: 0, updated: 0, total: state.entries.size };
    await hydrate();
    if (!state.groupKey) return { added: 0, updated: 0, total: state.entries.size };
    if (!S.onGroupFeed()) {
      state.offFeedSince = state.offFeedSince ?? Date.now();
      state.collectAgain = true;
      return { added: 0, updated: 0, total: state.entries.size };
    }
    state.offFeedSince = null;
    // Feed sort is not set here. Switching it writes the preference against
    // the Facebook account, and Comet remounts every other group tab when
    // that happens. A reload of one group used to harvest immediately, click
    // the chip, and reload the rest — usually three times, once per sibling
    // that then tried the same switch. Only autoScroll changes the order.
    refreshQueueStatus();
    if (state.stopped) return { added: 0, updated: 0, total: state.entries.size };

    let added = 0;
    let updated = 0;
    const visited = new WeakSet();
    let rendered = syncRendered();

    while (!state.stopped) {
      if (runComplete()) {
        state.collectAgain = false;
        break;
      }
      if (S.findPostDialog()) {
        state.collectAgain = true;
        break;
      }

      const element = selectNext(visited, rendered);
      rendered = null;
      if (!element) {
        state.collectAgain = false;
        break;
      }
      visited.add(element);
      if (hasLayout() && !shouldCollect(visibility(element))) {
        state.collectAgain = true;
        break;
      }

      const outcome = await collectPost(element);
      added += outcome.added;
      updated += outcome.updated;
      state.collected += outcome.added;
      if (outcome.ended) {
        state.collectAgain = false;
        break;
      }
      state.collectAgain = true;
      if (!outcome.complete) break;
      advanceFrontier(element);
    }

    state.lastCollectedScrollY = Math.round(window.scrollY || 0);
    state.lastHarvestAt = new Date().toISOString();
    if (tracing()) {
      console.debug("[fbgs] pass", {
        href: location.href,
        scrollY: state.lastCollectedScrollY,
        queued: state.queued.size,
        blockedNavigations: S.blockedNavigations().length,
      });
    }
    if (added || updated) persistSoon();
    return { added, updated, total: state.entries.size };
  }
  function harvest() {
    if (state.harvestPending) return state.harvestPending;
    const pending = Promise.resolve(state.harvestChain)
      .catch(() => {})
      .then(() => {
        state.harvestPending = null;
        return harvestNow();
      });
    state.harvestPending = pending;
    state.harvestChain = pending.catch(() => {});
    return pending;
  }

  function scheduleHarvest() {
    if (state.stopped) return;
    if (!contextAlive()) return stop();
    if (!state.harvestArmed && !state.autoScrolling) return;
    clearTimeout(state.harvestTimer);
    state.harvestTimer = setTimeout(() => {
      harvest().catch(() => {});
    }, HARVEST_DEBOUNCE_MS);
  }

  /* --------------------------------------------------------------- observing */
  let renderTimer = null;
  function noteRendered() {
    if (state.stopped) return;
    if (!contextAlive()) return stop();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (!state.stopped) syncRendered();
    }, RENDER_DEBOUNCE_MS);
  }

  function attachFeedObserver() {
    if (state.stopped) return;
    const feed = document.querySelector('div[role="feed"]') || document.querySelector('div[role="main"]');
    if (!feed) {
      setTimeout(() => {
        if (state.harvestArmed || state.autoScrolling) attachFeedObserver();
      }, 1500);
      return;
    }
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(noteRendered);
    state.observer.observe(feed, { childList: true, subtree: true });
  }

  function ensureCollectTimer() {
    if (state.collectTimer) return;
    state.collectTimer = setInterval(() => {
      if (state.stopped || state.autoScrolling) return;
      if (!contextAlive()) return stop();
      if (!state.harvestArmed) return;
      const moved = Math.round(window.scrollY || 0) !== state.lastCollectedScrollY;
      if (state.collectAgain || moved) scheduleHarvest();
    }, COLLECT_IDLE_MS);
  }

  function armHarvest() {
    if (state.stopped) return;
    const already = state.harvestArmed;
    state.harvestArmed = true;
    if (already) return;
    attachFeedObserver();
    ensureCollectTimer();
  }

  const USER_SCROLL_KEYS = new Set(["PageDown", "PageUp", "ArrowDown", "ArrowUp", " ", "Home", "End"]);

  async function startObserving() {
    if (state.stopped) return;
    const path = location.pathname || "";
    if (/\/(?:posts|permalink)\//.test(path) || /multi_permalinks=/.test(location.search || "")) {
      return;
    }
    if (state.stopped) return;

    if (!state.listenersBound) {
      state.listenersBound = true;
      try {
        chrome.runtime?.onMessage?.addListener?.((message, _sender, respond) => {
          if (message?.type !== "commentsReady") return false;
          try {
            respond?.(applyCommentsReady(message));
          } catch {
            respond?.({ applied: false, reason: "threw" });
          }
          return false;
        });
      } catch {
        // No extension behind this script; stop() will notice.
      }
      openRunPort();
      window.addEventListener("beforeunload", () => {
        if (tracing()) console.debug("[fbgs] feed tab unloading", location.href);
      });
      window.addEventListener("popstate", () => {
        if (tracing()) console.debug("[fbgs] feed tab popstate", location.href);
      });

      window.addEventListener(
        "wheel",
        (event) => {
          if (event.isTrusted) armHarvest();
        },
        { passive: true }
      );
      window.addEventListener(
        "touchmove",
        (event) => {
          if (event.isTrusted) armHarvest();
        },
        { passive: true }
      );
      window.addEventListener("keydown", (event) => {
        if (event.isTrusted && USER_SCROLL_KEYS.has(event.key)) armHarvest();
      });
      window.addEventListener(
        "scroll",
        () => {
          if (state.autoScrolling) return;
          if (!state.harvestArmed) return;
          const now = Date.now();
          if (now - state.lastScrollHarvest < SCROLL_THROTTLE_MS) return;
          state.lastScrollHarvest = now;
          scheduleHarvest();
        },
        { passive: true }
      );
      window.addEventListener("pagehide", persistNow);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") persistNow();
      });
      // Facebook navigates client-side; re-point the observer when the group changes.
      state.navTimer = setInterval(() => {
        if (state.stopped) return;
        if (!contextAlive()) return stop();
        if (groupKeyFromUrl() !== state.groupKey) {
          hydrate().then(startObserving).catch(() => {});
        }
      }, 2000);
    }
    // A page load must not harvest, and it must not watch the feed either.
    // harvestNow used to switch the feed's sort on every group tab that
    // opened, and Facebook writes that against the account — Comet then
    // remounted every other group tab. The leftover after that was Facebook's
    // own boot scroll firing this tab's harvest, which remounted the siblings
    // and left them harvesting on every later reload. Scroll and Start are
    // what collect; both go through armHarvest.
    if (state.lastCollectedScrollY == null) {
      state.lastCollectedScrollY = Math.round(window.scrollY || 0);
    }
    if (state.harvestArmed || state.autoScrolling) {
      attachFeedObserver();
      ensureCollectTimer();
    }
    // A remount during phase two re-injects this script. Keep draining rather
    // than sitting on Resume collecting with a parked queue. A walk that already
    // reached the cutoff does the same: comments start on their own, no click.
    if (
      !state.autoScrolling &&
      !state.stopRequested &&
      (state.drainingComments ||
        (!state.queueStopped &&
          hasHeldPosts() &&
          (state.walkFinished || state.reachedCutoff)))
    ) {
      finishRun().catch(() => {});
      return;
    }
    // The walk is already over and Stop left the buffer here. Send it. This
    // does not scroll the feed and does not open the comment queue again.
    if (
      !state.autoScrolling &&
      !state.uploading &&
      !state.uploadKickoff &&
      !state.stopRequested &&
      state.entries.size &&
      (state.walkFinished || state.reachedCutoff)
    ) {
      state.uploadKickoff = true;
      releaseUnreadHolds();
      uploadAndMaybeRetry().catch(() => {});
    }
  }

  /* -------------------------------------------------------------- autoscroll */
  const THREAD_SECONDS_PER_POST = 12;
  const budgetSeconds = (targetPosts) =>
    Math.ceil(targetPosts * (60 / BUDGET_POSTS_PER_MINUTE + THREAD_SECONDS_PER_POST));

  const feedHeight = () => document.body.scrollHeight || 0;

  const atBottom = () =>
    (window.innerHeight || 0) + (window.scrollY || 0) >= feedHeight() - BOTTOM_SLACK_PX;
  function landedPost() {
    if (!hasLayout()) return null;
    for (const [element, view] of syncRendered()) {
      if (!view) continue;
      if (view.top >= view.height * LANDING_MIN_RATIO && view.top <= view.height * LANDING_MAX_RATIO)
        return element;
    }
    return null;
  }

  const readingScale = (element) =>
    element
      ? Math.min(MAX_READING_SCALE, 1 + (element.innerText || "").trim().length / READING_CHARS)
      : 1;
  function dwellMs() {
    const landed = landedPost();
    const roll = S.nextRandom();
    if (roll < DISTRACTION_CHANCE) return S.randInt(...DISTRACTION_MS);
    const reading = landed ? LANDED_READING_CHANCE : READING_CHANCE;
    if (roll < DISTRACTION_CHANCE + reading) {
      return Math.round(S.randInt(...READING_MS) * readingScale(landed));
    }
    return S.randInt(...GLANCE_MS);
  }
  function paceStretchMs(collected, elapsedMs, pace) {
    const owed = (collected / pace) * 60000;
    return Math.min(MAX_STRETCH_MS, Math.max(0, owed - elapsedMs));
  }
  async function waitWhile(condition, deadline, maxWaitMs) {
    const { sleep, now } = S.motion;
    const until = maxWaitMs === undefined ? deadline : Math.min(deadline, now() + maxWaitMs);
    while (!state.stopped && condition() && now() < until) {
      await sleep(S.randInt(...SETTLE_MS));
    }
  }
  function paintSignature() {
    let posts = 0;
    for (const [, view] of syncRendered()) {
      if (!isEligible(view)) continue;
      posts += 1;
    }
    return `${posts}`;
  }
  function viewportPostFill() {
    let fill = 0;
    for (const [, view] of syncRendered()) {
      if (!view) continue;
      fill += view.ofViewport;
    }
    return fill;
  }
  async function waitForPaint(deadline) {
    if (!hasLayout()) return;
    const { sleep, now } = S.motion;
    const until = Math.min(deadline, now() + MAX_PAINT_WAIT_MS);
    let signature = paintSignature();
    let stable = 0;
    // After a swipe, empty slots are not posts. Stay until the screen is
    // actually filled (or the feed has nowhere left to grow), then harvest.
    while (!state.stopped && now() < until) {
      await sleep(S.randInt(...PAINT_SETTLE_MS));
      const next = paintSignature();
      const filled = viewportPostFill() >= MIN_FEED_FILL || atBottom();
      stable = next === signature && filled ? stable + 1 : 0;
      signature = next;
      if (stable >= PAINT_STABLE_SAMPLES) return;
    }
  }
  async function scrollBurst(deadline) {
    const { sleep, now } = S.motion;
    // One viewport per burst, for the whole run. Caption expansion happens
    // after the flick, in harvest. It must not shorten this distance: a busy
    // main thread used to raise lag and each later swipe covered less ground.
    const ceiling = Math.round((window.innerHeight || 0) * BURST_TRAVEL_RATIO);
    const flicks = S.randInt(...BURST_FLICKS);
    let travelled = 0;

    for (let flick = 0; flick < flicks; flick += 1) {
      const room = ceiling > 0 ? ceiling - travelled : Infinity;
      if (room <= 0) break;
      const distance = Math.min(S.randInt(FLICK_MIN_PX, FLICK_MAX_PX), room);
      await S.glideBy(distance, { minTickMs: FLICK_TICK_MS[0], maxTickMs: FLICK_TICK_MS[1] });
      travelled += distance;
      if (state.stopped || now() >= deadline) break;
      if (S.findPostDialog()) break;
      if (flick < flicks - 1) await sleep(S.randInt(...BURST_GAP_MS));
    }
  }
  async function autoScroll(options = {}) {
    if (state.autoScrolling) return { error: "Auto-scroll is already running." };
    if (state.stopped) return { error: STOPPED_MESSAGE };
    state.autoScrolling = true;
    state.stopRequested = false;
    state.queueStopped = false;
    state.walkFinished = false;
    state.drainingComments = false;
    state.finishPromise = null;
    // Parked jobs are not drained here. Starting a walk used to ask for them,
    // which opened the worker seconds into the run and remounted the tab it was
    // walking — the reload this whole design exists to avoid. They wait with
    // everything else this walk queues, and `finishRun` reads the lot.
    // Held for the whole run rather than per click: Comet resolves a route over
    // the network, so the navigation arrives seconds after the click that asked
    // for it.
    S.holdNavigationGuard(true);
    armHarvest();
    try {
      document.dispatchEvent(new CustomEvent("fbgs:start-tagger"));
    } catch {
      // The main-world tagger is optional; harvest still reads hrefs.
    }
    const {
      targetPosts = null,
      maxSeconds = targetPosts === null ? null : budgetSeconds(targetPosts),
      fromTop = true,
    } = options;
    await resolveCutoff();
    if (fromTop) {
      state.reachedCutoff = false;
      state.walkFinished = false;
      state.preCutoffStreak = 0;
      // A from-the-top run is a new sweep, not a Resume. Parked jobs belong
      // to the buffer Clear already threw away; loading them here is how 55
      // leftover threads showed up on a four-post walk.
      state.queued.clear();
      state.queuedPostIds = null;
      state.queueSeenAt = null;
      state.queueEpoch += 1;
      state.queue = { pending: 0, inFlight: 0, failed: 0, parked: 0 };
      state.drainingComments = false;
      state.finishPromise = null;
      await setDrainFlag(false);
      await askBackground({ type: "clearQueue", groupKey: state.groupKey });
      if (state.groupKey) {
        await withStorage(() =>
          chrome.storage.local.remove(`commentQueue:${state.groupKey}`)
        )?.catch(stop);
      }
    }

    S.resetLag?.();
    const { sleep, now } = S.motion;
    const started = now();
    const deadline = maxSeconds === null ? Infinity : started + maxSeconds * 1000;
    const startedWith = state.collected;
    const collectedHere = () => state.collected - startedWith;
    // Drawn once, so no two sessions are paced alike.
    const pace = S.randFloat(MIN_POSTS_PER_MINUTE, MAX_POSTS_PER_MINUTE);
    let reachedEnd = false;
    let unavailable = false;
    // The tab is somewhere other than the group's feed — a stray click that
    // followed a link, or the reader navigating. Nothing here takes it back.
    let leftFeed = false;
    let restores = 0;
    let result = null;

    try {
      if (fromTop && (window.scrollY || 0) > 0) {
        window.scrollTo({ top: 0, behavior: "auto" });
        await sleep(400);
      }
      if (fromTop) {
        await harvest();
        for (let attempt = 0; attempt < 5 && !state.feedOrderSettled; attempt += 1) {
          await sleep(S.randInt(400, 900));
          await ensureFeedOrder();
        }
      }

      let stalledSince = null;
      let lastHeight = feedHeight();

      while (
        !state.stopped &&
        !state.stopRequested &&
        (targetPosts === null || collectedHere() < targetPosts) &&
        !runComplete() &&
        now() < deadline
      ) {
        await waitWhile(() => document.visibilityState === "hidden", deadline, MAX_PAGE_UNAVAILABLE_MS);
        // A dialog that came with a route change is not one to wait behind:
        // the page it was covering is gone, so waiting it out spends the whole
        // unavailable budget on a feed that is never coming back.
        await waitWhile(
          () => Boolean(S.findPostDialog()) && S.onGroupFeed(),
          deadline,
          MAX_PAGE_UNAVAILABLE_MS
        );
        if (state.stopped || now() >= deadline) break;
        if (!S.onGroupFeed()) {
          state.offFeedSince = state.offFeedSince ?? now();
          leftFeed = true;
          break;
        }
        if (document.visibilityState === "hidden" || S.findPostDialog()) {
          unavailable = true;
          break;
        }
        const before = state.collected;

        await scrollBurst(deadline);
        if (S.nextRandom() < OVERSHOOT_CHANCE) {
          const y = window.scrollY || 0;
          const floor = 120;
          const maxBack = Math.max(0, y - floor);
          const back = Math.min(S.randInt(...OVERSHOOT_PX), maxBack);
          if (back > 0) {
            await sleep(S.randInt(...OVERSHOOT_PAUSE_MS));
            await S.glideBy(-back);
          }
        }
        await waitForPaint(deadline);
        await sleep(dwellMs() + paceStretchMs(before - startedWith, now() - started, pace));

        const threadsRead = state.completedThreads.size;
        await harvest();
        await recoverIfJumpedToTop();
        if (state.completedThreads.size !== threadsRead) await sleep(S.randInt(...SETTLE_MS));

        const height = feedHeight();
        const stalled = state.collected === before && height === lastHeight && atBottom();
        lastHeight = height;
        stalledSince = stalled ? stalledSince ?? now() : null;
        if (stalledSince !== null && now() - stalledSince >= STALL_MS) {
          reachedEnd = true;
          break;
        }

        state.progress = {
          collected: collectedHere(),
          targetPosts,
          elapsedSeconds: Math.round((now() - started) / 1000),
          stalledSeconds: stalledSince === null ? 0 : Math.round((now() - stalledSince) / 1000),
        };
      }

      persistNow();
      result = {
        collected: collectedHere(),
        total: state.entries.size,
        targetPosts,
        elapsedSeconds: Math.round((now() - started) / 1000),
        stoppedBecause:
          state.stopped
            ? STOPPED_MESSAGE
            : state.stopRequested
            ? "stopped by request"
            : state.reachedCutoff
            ? `reached posts published before ${state.cutoff}`
            : targetPosts !== null && collectedHere() >= targetPosts
            ? "target reached"
            : reachedEnd
            ? "no new posts loaded (likely end of feed or rate limited)"
            : leftFeed
            ? OFF_FEED_MESSAGE
            : unavailable
            ? "the page stayed covered or in the background"
            : // Only reachable where a caller named a target and a budget to
              // reach it in; a run walking to the cutoff has neither.
              "time limit reached",
      };
    } finally {
      state.autoScrolling = false;
      state.progress = null;
      // The reader has the tab back; nothing of ours is clicking it now.
      S.holdNavigationGuard(false);
    }
    // Phase two starts here, on its own. Rebuilding held jobs first is what
    // used to need the Collect comments click after a long walk killed the
    // worker's in-memory queue.
    if (result && !state.stopRequested && !state.stopped) {
      state.walkFinished = true;
      persistNow();
      finishRun();
    }
    return result;
  }

  /* ------------------------------------------------------------------ public */
  // An upload in flight is an upload of the buffer as it was when it started, so
  // a hand-over waits for it rather than being turned away by it. Only a Stop
  // arriving while a finished run is uploading can reach this, and the posts
  // whose threads landed under that request are exactly the ones the Stop is for.
  async function waitForUpload(maxMs = 120000) {
    const deadline = Date.now() + maxMs;
    while (state.uploading && !state.stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  function jobForEntry(entry) {
    const pending = entry.pendingComments;
    if (!pending?.postId) return null;
    const url = pending.url || entry.capture?.sourceUrl || null;
    if (!url) return null;
    return { postId: pending.postId, url };
  }

  // The worker already retried a failed read once (two attempts). A post still
  // held after that drain is not queued again: the capture on hand is what gets
  // stored, warning and all.
  function releaseUnreadHolds() {
    for (const entry of state.entries.values()) {
      if (!entry.pendingComments) continue;
      entry.pendingComments = null;
      entry.capture = {
        ...entry.capture,
        phase: "full",
        warnings: union(entry.capture.warnings, ["comments:worker_lost"]),
      };
    }
  }

  async function enqueueHeldJobs() {
    for (const entry of state.entries.values()) {
      const job = jobForEntry(entry);
      if (!job) continue;
      state.queued.add(job.postId);
      await askBackground({
        type: "queueComments",
        postId: job.postId,
        url: job.url,
        groupKey: state.groupKey,
        defer: true,
        expected: entry.capture?.metrics?.comments ?? null,
        options: {
          target: state.options.maxCommentsPerPost,
          order: state.options.commentOrder || null,
          includeReplies: true,
          expected: entry.capture?.metrics?.comments ?? null,
          waitMs: 45000,
        },
      });
    }
  }

  // The walk already finished. Resume must not scroll the feed again — it only
  // drains held threads, then uploads.
  async function continueComments() {
    if (state.stopped) return { error: STOPPED_MESSAGE };
    if (state.autoScrolling) return { error: "Auto-scroll is already running." };
    state.stopRequested = false;
    state.queueStopped = false;
    return finishRun();
  }

  async function finishRun() {
    // Phase two. The walk is over. Worker permalinks remount the feed tab;
    // that is expected and must not park the queue or abandon the upload.
    if (state.finishPromise) return state.finishPromise;
    state.walkFinished = true;
    state.drainingComments = true;
    persistNow();
    state.finishPromise = (async () => {
      try {
        await setDrainFlag(true);
        // Held posts remember their permalinks; the service worker may not,
        // after a long scroll. Rebuild the queue before asking it to drain.
        await enqueueHeldJobs();
        restartPendingClocks();
        // Nothing held means the threads are already on the captures. Opening
        // the worker again only reloads leftover jobs and leaves the queue
        // count stuck while the upload waits.
        if (!(await dropQueueIfNothingHeld())) {
          await askBackground({
            type: "resumeQueue",
            groupKey: state.groupKey,
            start: true,
          });
          await waitForQueue(DRAIN_MAX_MS);
          await waitForHeld();
        }
        if (state.stopRequested) return null;
        await askBackground({ type: "stopRun", groupKey: state.groupKey });
        state.queueStopped = true;
        releaseUnreadHolds();
        return await uploadAndMaybeRetry();
      } finally {
        state.finishPromise = null;
      }
    })();
    return state.finishPromise;
  }

  // A failed upload is retried on its own. It does not open the comment queue
  // again; posts already read stay in the buffer and go with the next send.
  async function uploadAndMaybeRetry() {
    await waitForUpload();
    const uploaded = await uploadCollection();
    const retry = Boolean(uploaded?.error) && !state.stopRequested && !state.stopped;
    state.drainingComments = false;
    await setDrainFlag(false);
    persistNow();
    // A 403 here is Vercel cooling down a burst. Trying again in 5 seconds
    // extends the block; two minutes lets it expire.
    const wait = /HTTP 403/.test(uploaded?.error || "") ? 120000 : 5000;
    if (retry) setTimeout(() => uploadAndMaybeRetry().catch(() => {}), wait);
    return uploaded;
  }

  async function stopCollecting() {
    state.stopRequested = true;
    state.queueStopped = true;
    state.drainingComments = false;
    state.finishPromise = null;
    await setDrainFlag(false);
    const parked = await askBackground({ type: "stopRun", groupKey: state.groupKey });
    persistNow();
    // Stop is not a hand-over. Captures go to Uplow only when the walk and
    // the comment queue have both finished — that is finishRun, not this.
    return { stopped: true, parked: parked?.parked ?? 0 };
  }

  function setOptions(options = {}) {
    state.options = { ...state.options, ...options };
    return state.options;
  }

  function getStatus() {
    const group = S.getGroup();
    const onGroupFeed = S.onGroupFeed();
    const rendered = syncRendered();
    let eligibleNow = 0;
    for (const view of rendered.values()) if (isEligible(view)) eligibleNow += 1;
    let held = 0;
    for (const entry of state.entries.values()) if (holdingComments(entry)) held += 1;
    return {
      version: VERSION,
      scraperVersion: S.version,
      schemaVersion: S.schemaVersion,
      groupKey: state.groupKey,
      groupName: group?.name || null,
      collected: toCaptures().length,
      buffered: state.entries.size,
      walked: state.collected,
      cutoff: state.cutoff,
      scrapeMode: state.scrapeMode,
      cutoffResolved: state.cutoffResolved,
      lastDiscoveredAt: state.lastDiscoveredAt,
      reachedCutoff: state.reachedCutoff,
      walkFinished: state.walkFinished,
      uploadedThisRun: state.uploaded.size,
      // `held` is posts read but not yet storable: their thread is still coming,
      // and nothing goes to the database until it has.
      queue: { ...state.queue, held },
      // Parked rather than running: a Stop left these for the next run.
      queueStopped: state.queueStopped,
      renderedNow: rendered.size,
      eligibleNow,
      feedOrder: state.feedOrder,
      feedOrderReason: state.feedOrderReason,
      threadsRead: state.completedThreads.size,
      // The reader's, always: nothing on this tab opens one.
      dialogOpen: Boolean(S.findPostDialog()),
      // What the navigation guard caught trying to leave the page, newest last.
      // An empty list is the expected reading; anything in it names a control
      // that would have taken the walk off the feed.
      blockedNavigations: S.blockedNavigations(),
      onGroupFeed,
      // Since when, so a reader can tell a page still painting from a run
      // stranded off the feed.
      offFeedSince: onGroupFeed ? null : state.offFeedSince,
      offFeedReason: onGroupFeed ? null : OFF_FEED_MESSAGE,
      autoScrolling: state.autoScrolling,
      drainingComments: state.drainingComments,
      uploading: state.uploading,
      lastUpload: state.lastUpload,
      progress: state.progress,
      lastHarvestAt: state.lastHarvestAt,
      observing: Boolean(state.observer),
      stopped: state.stopped,
      stoppedReason: state.stopped ? STOPPED_MESSAGE : null,
    };
  }
  async function clearCollection() {
    state.entries.clear();
    state.collected = 0;
    state.reachedCutoff = false;
    state.walkFinished = false;
    state.preCutoffStreak = 0;
    applyInitialCutoff();
    state.queued.clear();
    state.queuedPostIds = null;
    state.queueSeenAt = null;
    state.queueEpoch += 1;
    state.queue = { pending: 0, inFlight: 0, failed: 0, parked: 0 };
    // Discard, do not park: Stop keeps the jobs for the next run, but Clear
    // has just deleted the entries they were going to land on.
    await askBackground({ type: "clearQueue", groupKey: state.groupKey });
    if (state.groupKey) {
      await withStorage(() =>
        chrome.storage.local.remove(`commentQueue:${state.groupKey}`)
      )?.catch(stop);
    }
    state.queueStopped = false;
    state.stopRequested = false;
    state.drainingComments = false;
    state.finishPromise = null;
    await setDrainFlag(false);
    state.feedOrderSettled = false;
    state.feedOrderTries = 0;
    state.feedOrderMenuTries = 0;
    state.feedOrderReason = null;
    state.uploaded.clear();
    state.completedThreads.clear();
    state.completedElements = new WeakSet();
    state.threadAttempts.clear();
    state.elementAttempts = new WeakMap();
    // Nothing has been collected, so there is nowhere to resume from.
    state.frontier = null;
    // The buffer that report was about is gone with everything else.
    state.lastUpload = null;
    if (state.groupKey) {
      await withStorage(() => chrome.storage.local.remove(storageKey(state.groupKey)))?.catch(stop);
    }
    await resolveCutoff();
    return { collected: 0 };
  }
  function commitUpload(accepted = null) {
    const sent = accepted && new Set(accepted);
    for (const [key, entry] of state.entries) {
      if (sent && !sent.has(entry.capture)) continue;
      const postId = entry.capture?.externalVideoId;
      if (postId) state.uploaded.add(postId);
      state.entries.delete(key);
    }
    persistNow();
    return { collected: 0, walked: state.collected };
  }

  async function sendCaptures(captures) {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await askBackground({ type: "ingest", captures });
      const error = !answer ? "unreachable" : answer.error || null;
      if (!error) {
        return {
          stored: Number(answer.stored) || 0,
          failed: Number(answer.failed) || 0,
          accepted: Number(answer.accepted) || captures.length,
          error: null,
        };
      }
      if (/HTTP 403/.test(error) || attempt >= UPLOAD_RETRY_DELAYS_MS.length || state.stopped) {
        return {
          stored: Number(answer?.stored) || 0,
          failed: Number(answer?.failed) || captures.length,
          accepted: Number(answer?.accepted) || 0,
          error,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAYS_MS[attempt]));
      if (state.stopped) return { stored: 0, failed: captures.length, error };
    }
  }
  async function uploadCollection() {
    if (state.uploading) return state.lastUpload;
    // Which posts are still owed an answer decides which are storable, so it is
    // read now rather than taken from whenever the last pass happened to ask.
    await refreshQueueStatus();
    const captures = toCaptures();
    if (!captures.length) return { stored: 0, failed: 0, error: null };

    state.uploading = true;
    const finished = (outcome) => {
      state.uploading = false;
      state.lastUpload = { at: new Date().toISOString(), ...outcome };
      return state.lastUpload;
    };

    try {
      const sent = await sendCaptures(captures);
      // Batches already accepted are dropped from the buffer, so a later 403
      // retries only what is left. A capture the backend refused stays.
      const accepted = Math.min(Number(sent.accepted) || 0, captures.length);
      if (accepted && !sent.failed) commitUpload(captures.slice(0, accepted));
      return finished(sent);
    } catch (error) {
      return finished({
        stored: 0,
        failed: captures.length,
        error: String(error?.message || error),
      });
    }
  }

  async function autoStart() {
    if (state.stopped || state.autoStarted) return;
    if (globalThis.__fbGroupAutoScroll === false) return;
    state.autoStarted = true;
    if (
      state.drainingComments ||
      (hasHeldPosts() && (state.walkFinished || state.reachedCutoff))
    ) {
      await continueComments().catch(() => {});
      return;
    }
    await S.motion.sleep(S.randInt(1500, 3500));
    await autoScroll().catch(() => {});
  }

  // A trusted scroll in this tab, after boot.js asked the background to inject
  // the collector here. Does not start a walk and does not touch any other tab.
  function wakeFromScroll() {
    armHarvest();
    return { armed: state.harvestArmed };
  }

  globalThis.__fbGroupCollector = {
    version: VERSION,
    harvest,
    flush: persistNow,
    autoScroll,
    autoStart,
    wakeFromScroll,
    stopCollecting,
    getStatus,
    getCollection: toExport,
    uploadCollection,
    commitUpload,
    clearCollection,
    setOptions,
    startObserving,
    applyCommentsReady,
    continueComments,
  };

  // Observing only. Nothing here scrolls the feed; see autoStart.
  hydrate()
    .then(startObserving)
    .catch(() => {});
})();
