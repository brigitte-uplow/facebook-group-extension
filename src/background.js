try {
  importScripts("/popup/config.js");
} catch {
  // No config.js in the bundle; destination() reports it below.
}

importScripts("/src/parse-tool-content.js");
const MAX_CAPTURES_PER_INGEST = 25;
// Back-to-back batches of a finished run are what Vercel's DDoS mitigation
// counts. A gap keeps the same batches under that threshold.
const INGEST_GAP_MS = 3000;

// The scraper's halves, in the order they publish the globals each next one
// reads. Matches popup.js CONTENT_SCRIPTS, minus collector.js: the worker tab
// parses one permalink on demand and never runs a feed sweep.
const SCRAPER_FILES = [
  "src/text.js",
  "src/time.js",
  "src/motion.js",
  "src/patterns.js",
  "src/utils/links.js",
  "src/utils/dom.js",
  "src/posts/content.js",
  "src/posts/detect.js",
  "src/posts/timestamp.js",
  "src/posts/identity.js",
  "src/media.js",
  "src/metrics.js",
  "src/comments/extract.js",
  "src/comments/order.js",
  "src/comments/expand.js",
  "src/comments/capture.js",
  "src/comments/permalink.js",
  "src/feed-order.js",
  "src/scraper.js",
];

// The feed tab's half. Injected into one tab when that tab asks — Start, or a
// trusted scroll — never into every group tab that happens to remount.
const COLLECTOR_FILES = [...SCRAPER_FILES, "src/collector.js"];

function isGroupFeedTab(tab) {
  const url = tab?.url || "";
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(facebook|fb)\.com$/.test(parsed.hostname)) return false;
    if (!parsed.pathname.includes("/groups/")) return false;
    if (/\/(posts|permalink)\//.test(parsed.pathname)) return false;
    if (parsed.search.includes("multi_permalinks=")) return false;
    return true;
  } catch {
    return false;
  }
}

async function loadCollector(message, sender) {
  const tabId = sender?.tab?.id ?? null;
  if (tabId == null || !isGroupFeedTab(sender.tab)) return { error: "not_group_feed" };

  const [{ result: already } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof globalThis.__fbGroupCollector?.wakeFromScroll === "function",
  });
  if (!already) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: COLLECTOR_FILES,
    });
  }
  // A remount during comment draining re-injects so answers can land. Do not
  // arm harvest: Facebook's own boot scroll would look like the reader, and
  // the walk is already over.
  if (message?.drain !== true) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__fbGroupCollector?.wakeFromScroll?.(),
    });
  }
  return { loaded: true, already: Boolean(already), drain: message?.drain === true };
}

const destination = () => globalThis.__uplowConfig ?? null;

async function callTool(name, args) {
  const target = destination();
  if (!target?.url || !target?.key) {
    throw new Error("No upload target — run `npm run config`, then reload the extension.");
  }

  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const body = await response.text();
  if (!response.ok && !body.includes("data:")) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 120)}`);
  }

  const frame = body.split("\n").find((line) => line.startsWith("data: "));
  if (!frame) throw new Error(`Unreadable response: ${body.slice(0, 120)}`);

  const { result, error } = JSON.parse(frame.slice("data: ".length));
  if (error) throw new Error(error.message);
  if (result?.isError) throw new Error(result.content?.[0]?.text || "Tool reported an error");

  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Tool result missing text content");
  }
  return parseToolContentText(text);
}

/* -------------------------------------------------------------------- ingest */
async function ingest(captures) {
  let stored = 0;
  let failed = 0;
  let accepted = 0;
  for (let i = 0; i < captures.length; i += MAX_CAPTURES_PER_INGEST) {
    if (i > 0) await sleep(INGEST_GAP_MS);
    const chunk = captures.slice(i, i + MAX_CAPTURES_PER_INGEST);
    try {
      const result = await callTool("uplow_ingest_engagement", { captures: chunk });
      const summary = result.summary || result;
      const chunkFailed = Number(summary.failed ?? summary.failedCount ?? 0);
      stored += Number(summary.stored ?? summary.storedCount ?? chunk.length);
      failed += chunkFailed;
      if (chunkFailed) return { stored, failed, accepted };
      accepted += chunk.length;
    } catch (error) {
      return { stored, failed, accepted, error: String(error?.message || error) };
    }
  }
  return { stored, failed, accepted };
}

function addGroupKey(keys, value) {
  if (value == null || value === "") return;
  keys.add(String(value).toLowerCase().replace(/\/+$/, ""));
}

function groupKeysFromOutlet(item) {
  const keys = new Set();
  addGroupKey(keys, item?.handle);
  addGroupKey(keys, item?.externalId);
  addGroupKey(keys, item?.mediaOutlet);
  addGroupKey(keys, item?.metadata?.group?.slug);
  addGroupKey(keys, item?.metadata?.group?.externalId);
  for (const url of [item?.canonicalUrl, item?.discoveryUrl]) {
    if (!url) continue;
    try {
      const match = new URL(url).pathname.match(/\/groups\/([^/]+)/);
      if (match) addGroupKey(keys, decodeURIComponent(match[1]));
    } catch {
      // Not a URL we can parse; the other identifiers still count.
    }
  }
  return keys;
}

function lastDiscoveredAtOf(item) {
  const at = item?.lastDiscoveredAt ?? item?.last_discovered_at ?? null;
  if (at == null || at === "") return null;
  return String(at);
}

async function listFacebookGroupOutlets() {
  const items = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await callTool("uplow_list_sources", {
      includeInactive: true,
      limit,
      offset,
    });
    const sources = page.sources || page.items || [];
    items.push(...sources);
    const pagination = page.pagination || {};
    if (pagination.hasMore === false) break;
    const returned = Number(pagination.returned ?? sources.length);
    if (!returned) break;
    offset += returned;
    if (offset > 2000) break;
  }
  return items;
}

function findOutlet(items, groupKey) {
  const target = String(groupKey || "").toLowerCase();
  if (!target) return null;
  return items.find((item) => groupKeysFromOutlet(item).has(target)) || null;
}

// lastDiscoveredAt is how a later run knows this group has already been swept:
// null means walk back to the initial cutoff; a timestamp means last 48 hours.
async function lookupGroupOutlet(message) {
  const groupKey = String(message?.groupKey || "").trim();
  if (!groupKey) return { lastDiscoveredAt: null, reason: "missing_group" };

  try {
    const sources = await listFacebookGroupOutlets();
    let match = findOutlet(sources, groupKey);
    if (!match && message?.groupName) {
      const name = String(message.groupName).toLowerCase();
      match =
        sources.find((item) => String(item.displayName || "").toLowerCase() === name) || null;
    }
    if (!match) return { lastDiscoveredAt: null, reason: "outlet_not_found" };
    return {
      lastDiscoveredAt: lastDiscoveredAtOf(match),
      sourceId: match.id || null,
      matched: match.handle || match.externalId || match.mediaOutlet || null,
    };
  } catch (error) {
    return { lastDiscoveredAt: null, reason: error.message || String(error) };
  }
}
/* -------------------------------------------------------- the comment worker */
const JOB_TIMEOUT_MS = 210000;
// Facebook paints comments after the load event says "complete", but how long
// that takes is the thread's business, not a number worth guessing: this is a
// floor before the scraper is injected, and the wait for the thread itself is
// scrapePermalinkComments's, which watches for it rather than sleeping.
const PAINT_SETTLE_MS = 250;
const STOP_GRACE_MS = 15000;
const MAX_JOB_ATTEMPTS = 2;
// One permalink at a time. Two tabs in one parked window means one of them is
// always in the background, and Chrome will not paint that one — which is how
// a post with a real thread comes back unread.
const WORKER_LANES = 1;
// Short, because it is also how long a lane takes to notice the queue is
// finished and let the drain close the window behind it.
const LANE_IDLE_MS = 50;
let worker = { windowId: null, hidden: null, lanes: [] };
// Same window, not a second worker: loads the next permalink while this one
// is being read. Comments are only scraped after that tab is brought to the
// front, so Facebook still paints the thread.
let prefetch = { tabId: null, url: null };
function resetWorker() {
  worker = { windowId: null, hidden: null, lanes: [] };
  prefetch = { tabId: null, url: null };
}
// Opening the window and hiding it are per-window, and the lanes race for both,
// so each is done once and its answer shared by whoever asked while it ran.
let opening = null;
let hiding = null;
const feedTabIds = new Set();
const ports = new Set();
const workerTabIds = () =>
  [...worker.lanes, prefetch.tabId].filter((tabId) => tabId != null);
function assertWorkerTab(tabId) {
  if (tabId == null || !workerTabIds().includes(tabId) || feedTabIds.has(tabId)) {
    throw new Error("refusing_to_touch_non_worker_tab");
  }
  return tabId;
}

// Only ever the window this script created. The feed's window is never resized,
// moved, minimized or focused by anything here.
function assertWorkerWindow(windowId) {
  if (windowId == null || windowId !== worker.windowId) {
    throw new Error("refusing_to_touch_non_worker_window");
  }
  return windowId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label || "timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("tab_load_timeout")), timeoutMs);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(resolve);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish(resolve);
      })
      .catch((error) => finish(reject, error));
  });
}

/* ------------------------------------------------- keeping the worker unseen */

// Comments only load in a window Chrome will actually paint. Minimized is
// frozen on macOS; a window parked at -32000 is often culled on the Xvfb hosts
// the grok bot runs on. The walk does not use this window — comments drain
// after the feed is finished — so the worker stays a real unfocused window on
// the display. That is slower and visible, and it is also the only reading
// Facebook will fill in.
const WORKER_VIEWPORT = { width: 1100, height: 900 };

async function workerWindow(windowId) {
  try {
    return await chrome.windows.get(assertWorkerWindow(windowId));
  } catch {
    return null;
  }
}

async function concealWorker(windowId) {
  if (windowId == null) return "no_window";
  assertWorkerWindow(windowId);

  try {
    await chrome.windows.update(windowId, {
      state: "normal",
      focused: false,
      width: WORKER_VIEWPORT.width,
      height: WORKER_VIEWPORT.height,
    });
  } catch {
    // A host that rejects the resize still has a window; paint is what matters.
  }
  const current = await workerWindow(windowId);
  if (!current) return "no_window";
  if (current.state === "minimized") {
    try {
      await chrome.windows.update(windowId, { state: "normal", focused: false });
    } catch {
      return "minimized";
    }
  }
  return "visible";
}

async function hideWorker() {
  if (worker.windowId == null) return worker.hidden;
  if (hiding) return hiding;
  const windowId = worker.windowId;
  hiding = concealWorker(windowId)
    .catch(() => "visible")
    .then((state) => {
      hiding = null;
      if (worker.windowId === windowId) worker.hidden = state;
      return state;
    });
  return hiding;
}
async function openWorkerWindow() {
  const created = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    type: "normal",
    width: WORKER_VIEWPORT.width,
    height: WORKER_VIEWPORT.height,
  });
  const tabId = created?.tabs?.[0]?.id ?? null;
  if (tabId == null) throw new Error("worker_tab_missing");
  // The window's own tab is the first lane; the rest are opened into it.
  worker = { windowId: created.id ?? null, hidden: null, lanes: [tabId] };
  prefetch = { tabId: null, url: null };
  await hideWorker();
  return worker.windowId;
}

async function ensureWorkerWindowOpen() {
  if (worker.windowId != null) {
    try {
      return assertWorkerWindow((await chrome.windows.get(worker.windowId)).id);
    } catch {
      // Closed by hand, or never opened. Its tabs went with it.
      resetWorker();
    }
  }
  if (opening) return opening;
  opening = openWorkerWindow().finally(() => {
    opening = null;
  });
  return opening;
}

// The tab this lane reads its permalinks in. Never a tab that existed before —
// every one of them is created here, into the worker's own window.
async function ensureLaneTab(lane) {
  await ensureWorkerWindowOpen();
  const existing = worker.lanes[lane] ?? null;
  if (existing != null) {
    try {
      await chrome.tabs.get(existing);
      return existing;
    } catch {
      worker.lanes[lane] = null;
    }
  }
  const created = await chrome.tabs.create({
    windowId: assertWorkerWindow(worker.windowId),
    url: "about:blank",
    active: false,
  });
  const tabId = created?.id ?? null;
  if (tabId == null) throw new Error("worker_tab_missing");
  worker.lanes[lane] = tabId;
  await hideWorker();
  return tabId;
}

async function closeWorker() {
  const { windowId } = worker;
  if (windowId == null) return;
  try {
    await chrome.windows.remove(assertWorkerWindow(windowId));
  } catch {
    // Already gone, or never ours to close.
  }
  resetWorker();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const lane = worker.lanes.indexOf(tabId);
  if (lane !== -1) worker.lanes[lane] = null;
  if (prefetch.tabId === tabId) prefetch = { tabId: null, url: null };
  feedTabIds.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === worker.windowId) resetWorker();
});

/* --------------------------------------------------------------- the queue */
let jobs = [];
// Lane number to the job it is reading. A lane whose job was parked by a Stop
// is listed here too, so its answer can be dropped when it finally arrives.
const inFlight = new Map();
const parkedLanes = new Set();
let draining = false;
let stopping = false;
let failedJobs = 0;
// Groups whose parked queue has already been read back in this service worker.
const hydratedGroups = new Set();
// Answers that arrived while the feed tab was remounting. Held until the
// collector is listening again, then delivered; otherwise a remount drops
// comments for jobs the worker already finished.
let undelivered = [];
let flushTimer = null;
let abandonTimer = null;
const ABANDON_MS = 5000;

const queueKey = (groupKey) => `commentQueue:${groupKey || "unknown"}`;
const resultsKey = (groupKey) => `commentResults:${groupKey || "unknown"}`;
// Bumped by Clear so a persist that started with the old jobs cannot write
// them back after the queue has been thrown away.
const queueEpoch = new Map();
// Bumped on every persist. A slow write must not put finished jobs back on
// disk after a later persist already removed them — that is how a queue of
// posts whose comments already landed shows up again as still queued.
const persistGen = new Map();
// In lane order, so a Stop parks what was running ahead of what was merely
// queued behind it, whichever lane happened to be holding it.
const runningJobs = (groupKey) =>
  [...inFlight.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([lane, job]) => job.groupKey === groupKey && !parkedLanes.has(lane))
    .map(([, job]) => job);

async function persistQueue(groupKey) {
  if (!groupKey) return;
  const epoch = queueEpoch.get(groupKey) || 0;
  const gen = (persistGen.get(groupKey) || 0) + 1;
  persistGen.set(groupKey, gen);
  const running = runningJobs(groupKey);
  const parked = [...running, ...jobs.filter((job) => job.groupKey === groupKey)];
  try {
    if ((queueEpoch.get(groupKey) || 0) !== epoch) return;
    if ((persistGen.get(groupKey) || 0) !== gen) return;
    if (!parked.length) {
      await chrome.storage.local.remove(queueKey(groupKey));
    } else {
      await chrome.storage.local.set({ [queueKey(groupKey)]: { jobs: parked, at: Date.now() } });
    }
    // A Clear that landed during the write left the old jobs on disk; drop them.
    if ((queueEpoch.get(groupKey) || 0) !== epoch) {
      await chrome.storage.local.remove(queueKey(groupKey));
      return;
    }
    // A newer snapshot finished around this write. The bytes just stored may
    // be the older queue, so write whatever the queue is now.
    if ((persistGen.get(groupKey) || 0) !== gen) return persistQueue(groupKey);
  } catch {
    // A quota or a teardown. The queue in memory is still the live one.
  }
}

async function readParkedJobs(groupKey) {
  if (!groupKey) return [];
  try {
    const key = queueKey(groupKey);
    const saved = await chrome.storage.local.get([key]);
    return Array.isArray(saved?.[key]?.jobs) ? saved[key].jobs : [];
  } catch {
    return [];
  }
}

const queuedPostIds = () =>
  new Set([
    ...[...inFlight.values()].map((job) => job.postId),
    ...jobs.map((job) => job.postId),
  ]);
async function loadParkedJobs(groupKey, feedTabId) {
  if (!groupKey || hydratedGroups.has(groupKey)) return 0;
  hydratedGroups.add(groupKey);
  const parked = await readParkedJobs(groupKey);
  const seen = queuedPostIds();
  const restored = [];
  for (const job of parked) {
    if (!job?.postId || !job.url || seen.has(job.postId)) continue;
    seen.add(job.postId);
    restored.push({ ...job, groupKey, feedTabId, attempts: Number(job.attempts) || 0 });
  }
  jobs = [...restored, ...jobs];
  if (restored.length) await persistQueue(groupKey);
  bindFeedTab(groupKey, feedTabId);
  return restored.length;
}

function bindFeedTab(groupKey, feedTabId) {
  if (feedTabId == null) return;
  feedTabIds.add(feedTabId);
  for (const job of jobs) {
    if (groupKey == null || job.groupKey === groupKey) job.feedTabId = feedTabId;
  }
  for (const job of inFlight.values()) {
    if (groupKey == null || job.groupKey === groupKey) job.feedTabId = feedTabId;
  }
  for (const row of undelivered) {
    if (groupKey == null || row.groupKey === groupKey) row.feedTabId = feedTabId;
  }
}

async function tabExists(tabId) {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function scheduleAbandonCheck(tabId) {
  clearTimeout(abandonTimer);
  abandonTimer = setTimeout(() => {
    abandonCheck(tabId).catch(() => {});
  }, ABANDON_MS);
}

async function abandonCheck(tabId) {
  // A remount drops the keepalive port and looks like the tab closed. The tab
  // itself is still there, and stopping would park the queue mid-drain.
  if (ports.size) return;
  if (await tabExists(tabId)) return;
  feedTabIds.delete(tabId);
  for (const id of [...feedTabIds]) {
    if (await tabExists(id)) return;
    feedTabIds.delete(id);
  }
  if (ports.size) return;
  await stopRun({ graceMs: 0 });
}

async function persistUndelivered(groupKey) {
  if (!groupKey) return;
  const rows = undelivered.filter((row) => row.groupKey === groupKey);
  try {
    if (!rows.length) {
      await chrome.storage.local.remove(resultsKey(groupKey));
      return;
    }
    await chrome.storage.local.set({ [resultsKey(groupKey)]: rows });
  } catch {
    // Memory still holds them for this service-worker lifetime.
  }
}

async function loadUndelivered(groupKey) {
  if (!groupKey) return;
  try {
    const saved = await chrome.storage.local.get([resultsKey(groupKey)]);
    const rows = Array.isArray(saved?.[resultsKey(groupKey)]) ? saved[resultsKey(groupKey)] : [];
    const seen = new Set(undelivered.filter((row) => row.groupKey === groupKey).map((row) => row.postId));
    for (const row of rows) {
      if (!row?.postId || seen.has(row.postId)) continue;
      seen.add(row.postId);
      undelivered.push(row);
    }
  } catch {
    // Nothing parked.
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushComments({}).catch(() => {});
  }, 1000);
}
async function recreateLaneTab(lane) {
  const existing = worker.lanes[lane] ?? null;
  worker.lanes[lane] = null;
  if (existing != null) {
    try {
      await chrome.tabs.remove(existing);
    } catch {
      // Already gone; ensureLaneTab opens a replacement.
    }
  }
  return ensureLaneTab(lane);
}

async function takePrefetchedTab(job, lane) {
  if (!job?.url || prefetch.url !== job.url || prefetch.tabId == null) return null;
  try {
    await chrome.tabs.get(prefetch.tabId);
  } catch {
    prefetch = { tabId: null, url: null };
    return null;
  }
  const ready = prefetch.tabId;
  const outgoing = worker.lanes[lane] ?? null;
  worker.lanes[lane] = ready;
  prefetch = { tabId: outgoing, url: null };
  return ready;
}

async function prefetchNext(url) {
  if (!url || stopping) return;
  await ensureWorkerWindowOpen();
  if (prefetch.tabId != null) {
    try {
      await chrome.tabs.get(prefetch.tabId);
    } catch {
      prefetch = { tabId: null, url: null };
    }
  }
  if (prefetch.tabId == null) {
    const created = await chrome.tabs.create({
      windowId: assertWorkerWindow(worker.windowId),
      url: "about:blank",
      active: false,
    });
    const tabId = created?.id ?? null;
    if (tabId == null) return;
    prefetch.tabId = tabId;
  }
  if (prefetch.url === url) return;
  prefetch.url = url;
  await chrome.tabs.update(prefetch.tabId, { url, active: false, autoDiscardable: false });
}

async function runJob(job, lane) {
  const timeoutMs = Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : JOB_TIMEOUT_MS;
  const paintMs =
    Number(job.paintMs) >= 0
      ? Number(job.paintMs)
      : job.attempts > 0
        ? Math.max(PAINT_SETTLE_MS, 1500)
        : PAINT_SETTLE_MS;

  if (job.attempts > 0) {
    prefetch = { tabId: null, url: null };
    await recreateLaneTab(lane);
  }
  let tabId = await takePrefetchedTab(job, lane);
  if (tabId == null) {
    tabId = await ensureLaneTab(lane);
    await chrome.tabs.update(assertWorkerTab(tabId), {
      url: job.url,
      active: true,
      autoDiscardable: false,
    });
  } else {
    await chrome.tabs.update(assertWorkerTab(tabId), {
      active: true,
      autoDiscardable: false,
    });
  }
  await hideWorker();
  prefetchNext(jobs[0]?.url).catch(() => {});
  await withTimeout(waitForTabComplete(tabId, timeoutMs), timeoutMs, "tab_load_timeout");
  await sleep(paintMs);
  await chrome.scripting.executeScript({
    target: { tabId: assertWorkerTab(tabId) },
    files: SCRAPER_FILES,
  });

  const [{ result } = {}] = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId: assertWorkerTab(tabId) },
      func: async (opts) => {
        const scraper = globalThis.__fbGroupScraper;
        if (!scraper?.scrapePermalinkComments) {
          return { error: "scraper_unavailable", comments: [] };
        }
        return scraper.scrapePermalinkComments(opts);
      },
      args: [job.options || {}],
    }),
    timeoutMs,
    "comment_scrape_timeout"
  );

  return result && typeof result === "object" ? result : { error: "no_result", comments: [] };
}
async function deliver(job, result) {
  const message = { type: "commentsReady", postId: job.postId, url: job.url, result };
  if (job.feedTabId != null) {
    try {
      await chrome.tabs.sendMessage(job.feedTabId, message);
      return true;
    } catch {
      // Tab closed or not listening; try the ports below.
    }
  }
  for (const port of ports) {
    try {
      port.postMessage(message);
      return true;
    } catch {
      // Disconnected mid-send; onDisconnect will clear it.
    }
  }
  return false;
}

async function holdResult(job, result) {
  undelivered = undelivered.filter(
    (row) => !(row.postId === job.postId && row.groupKey === job.groupKey)
  );
  undelivered.push({
    postId: job.postId,
    url: job.url,
    result,
    groupKey: job.groupKey,
    feedTabId: job.feedTabId,
  });
  await persistUndelivered(job.groupKey);
  scheduleFlush();
}

async function deliverOrHold(job, result) {
  if (await deliver(job, result)) return true;
  await holdResult(job, result);
  return false;
}

async function flushComments(message) {
  const groupKey = message?.groupKey ?? null;
  await loadUndelivered(groupKey);
  const keep = [];
  const groups = new Set();
  for (const row of undelivered) {
    if (groupKey != null && row.groupKey !== groupKey) {
      keep.push(row);
      continue;
    }
    const ok = await deliver(
      { postId: row.postId, url: row.url, feedTabId: row.feedTabId, groupKey: row.groupKey },
      row.result
    );
    if (ok) {
      if (row.groupKey) groups.add(row.groupKey);
    } else {
      keep.push(row);
    }
  }
  undelivered = keep;
  const touched = groupKey ? [groupKey] : [...groups, ...new Set(keep.map((row) => row.groupKey))];
  for (const key of touched) {
    if (key) await persistUndelivered(key);
  }
  if (undelivered.length) scheduleFlush();
  return { flushed: true, pending: undelivered.length };
}

async function runLane(lane) {
  while (!stopping) {
    // An empty queue is not the same as a finished one: another lane may be
    // about to push a retry, and a walk queues as it goes. Only the last lane
    // still holding a job gets to decide the queue is done — otherwise a lane
    // that happened to look a moment too early sits out the rest of the run.
    if (!jobs.length) {
      if (!inFlight.size) return;
      await sleep(LANE_IDLE_MS);
      continue;
    }
    const job = jobs.shift();
    inFlight.set(lane, job);
    parkedLanes.delete(lane);
    await persistQueue(job.groupKey);

    const outcome = await runJob(job, lane).catch((error) => ({
      error: error?.message || String(error),
      comments: [],
    }));
    // A Stop while this lane was reading put the job back on the queue itself,
    // and a lane already carrying another job is no longer this one's to answer
    // for — a tab that hung past the grace budget comes back long after its job
    // was parked and re-taken. Either way the answer is dropped: delivering it
    // would be a second reading of a post that is queued to be read again.
    if (inFlight.get(lane) !== job) {
      if (parkedLanes.has(lane) && !inFlight.has(lane)) parkedLanes.delete(lane);
      return;
    }
    inFlight.delete(lane);

    const empty = !outcome?.comments?.length;
    if (outcome?.error && empty && job.attempts + 1 < MAX_JOB_ATTEMPTS) {
      jobs.push({ ...job, attempts: job.attempts + 1 });
      await persistQueue(job.groupKey);
      continue;
    }
    if (outcome?.error) failedJobs += 1;

    await persistQueue(job.groupKey);
    await deliverOrHold(job, outcome);
  }
  inFlight.delete(lane);
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    // Re-spawned rather than run once: a lane that empties the queue returns,
    // and a retry another lane pushed behind it would have nobody left to run
    // it.
    while (jobs.length && !stopping) {
      await Promise.all(
        Array.from({ length: WORKER_LANES }, (_, lane) => runLane(lane))
      );
    }
  } finally {
    draining = false;
  }
}

/* ----------------------------------------------------------------- handlers */

async function queueComments(message, sender) {
  const url = typeof message?.url === "string" ? message.url : null;
  const postId = message?.postId ?? null;
  if (!url || !postId) return { error: "missing_job", queued: false };

  const groupKey = message.groupKey || null;
  const feedTabId = sender?.tab?.id ?? null;
  if (feedTabId != null) feedTabIds.add(feedTabId);
  stopping = false;
  await loadParkedJobs(groupKey, feedTabId);

  // A walk asks for its threads to be queued, not read: the worker's permalink
  // loads remount the feed tab it is walking. `finishRun` drains them after.
  const defer = message?.defer === true;

  if (queuedPostIds().has(postId)) {
    // Already queued — but the ask may still be what read the parked jobs back
    // in, and a queue that was loaded and not drained is a run whose comments
    // never arrive.
    if (!defer) drain();
    return { queued: false, duplicate: true, pending: jobs.length };
  }

  jobs.push({
    postId,
    url,
    groupKey,
    feedTabId,
    expected: message.expected ?? null,
    options: message.options && typeof message.options === "object" ? message.options : {},
    timeoutMs: message.timeoutMs ?? null,
    paintMs: message.paintMs ?? null,
    attempts: 0,
  });
  await persistQueue(groupKey);
  if (!defer) drain();
  return { queued: true, pending: jobs.length, deferred: defer };
}

const queueStatus = async (message) => {
  const groupKey = message?.groupKey ?? null;
  const onDisk = await readParkedJobs(groupKey);
  const ofGroup = (job) => groupKey == null || job.groupKey == null || job.groupKey === groupKey;
  return {
    pending: jobs.filter(ofGroup).length,
    inFlight: [...inFlight.values()].filter(ofGroup).length,
    failed: failedJobs,
    // How the worker window is being kept out of the way, or that it isn't.
    workerHidden: worker.hidden,
    // How many lanes read at once, so a queue that looks stalled can be told
    // from one that is simply deeper than it is wide.
    lanes: WORKER_LANES,
    parked: stopping ? jobs.length + inFlight.size : 0,
    stopping,
    draining,
    onDisk: onDisk.length,
    // Every post the queue still owes an answer for: queued, being read, or
    // parked on disk for a later run. This is what lets the feed tab tell a post
    // whose turn has not come from one whose job no longer exists — the only
    // honest reason to stop holding a post back from its upload.
    postIds: [
      ...new Set(
        [
          ...[...inFlight.values()].filter(ofGroup).map((job) => job.postId),
          ...jobs.filter(ofGroup).map((job) => job.postId),
          ...onDisk.map((job) => job.postId),
        ].filter(Boolean)
      ),
    ],
  };
};
async function stopRun(message) {
  const graceMs = Number(message?.graceMs) >= 0 ? Number(message.graceMs) : STOP_GRACE_MS;
  const groupKey =
    message?.groupKey || [...inFlight.values()][0]?.groupKey || jobs[0]?.groupKey || null;
  stopping = true;
  if (inFlight.size) {
    const until = Date.now() + graceMs;
    while (inFlight.size && Date.now() < until) await sleep(100);
  }
  // Whatever the grace budget could not wait for goes back to the front of the
  // queue in lane order, ahead of what was queued behind it, and uncharged: an
  // interrupted job was never a failed one.
  if (inFlight.size) {
    const stranded = [...inFlight.entries()].sort(([a], [b]) => a - b);
    for (const [lane] of stranded) parkedLanes.add(lane);
    jobs.unshift(...stranded.map(([, job]) => job));
    inFlight.clear();
  }

  await persistQueue(groupKey);
  await closeWorker();
  return { stopped: true, parked: jobs.length, groupKey };
}

// Clear, not Stop. Stop parks the jobs so the next run can finish them;
// Clear has already thrown away the entries those answers would land on, so
// keeping the queue would only deliver comments to posts this run no longer
// has — and the popup would keep reporting them as queued.
async function clearQueue(message) {
  const groupKey = message?.groupKey || null;
  if (!groupKey) return { cleared: false, error: "missing_group" };

  stopping = true;
  for (const [lane, job] of [...inFlight.entries()]) {
    if (job.groupKey !== groupKey) continue;
    parkedLanes.add(lane);
    inFlight.delete(lane);
  }
  jobs = jobs.filter((job) => job.groupKey != null && job.groupKey !== groupKey);
  // Still hydrated — as empty. Reloading from disk would undo a Clear if a
  // persist that started before the discard wrote the old jobs back.
  hydratedGroups.add(groupKey);
  queueEpoch.set(groupKey, (queueEpoch.get(groupKey) || 0) + 1);
  if (!jobs.length && !inFlight.size) failedJobs = 0;

  undelivered = undelivered.filter((row) => row.groupKey !== groupKey);
  try {
    await chrome.storage.local.remove(queueKey(groupKey));
    await chrome.storage.local.remove(resultsKey(groupKey));
    await chrome.storage.local.remove(`commentDrain:${groupKey}`);
  } catch {
    // Teardown; memory is already empty for this group.
  }
  if (!jobs.length && !inFlight.size) await closeWorker();
  return { cleared: true, pending: 0, groupKey };
}
async function resumeQueue(message, sender) {
  const groupKey = message?.groupKey || null;
  const feedTabId = sender?.tab?.id ?? null;
  bindFeedTab(groupKey, feedTabId);
  stopping = false;
  const restored = await loadParkedJobs(groupKey, feedTabId);
  await loadUndelivered(groupKey);
  // Reading the parked queue back is not the same as running it. A feed tab
  // announces itself on every page load, and draining there used to mean merely
  // reloading a group with parked jobs opened the worker. `start` is set by
  // finishRun (and again after a remount while comments are still draining).
  if (message?.start && jobs.length) drain();
  await flushComments({ groupKey });
  return { restored, pending: jobs.length, draining };
}

/* --------------------------------------------------------------- keepalive */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fb-scraper-run") return;
  const tabId = port.sender?.tab?.id ?? null;
  if (tabId != null) feedTabIds.add(tabId);
  ports.add(port);

  port.onMessage.addListener((message) => {
    // Any traffic resets the idle timer; a ping carries nothing else.
    if (message?.type === "resumeQueue") {
      resumeQueue(message, { tab: { id: tabId } }).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    // Do not stop the drain here. Facebook remounts the feed tab when a
    // worker loads a permalink; that drops this port and used to park the
    // queue. Only a tab that is actually gone abandons the run.
    scheduleAbandonCheck(tabId);
  });
});

const handlers = {
  ingest: (message) => ingest(message.captures || []),
  lookupGroupOutlet: (message) => lookupGroupOutlet(message),
  queueComments: (message, sender) => queueComments(message, sender),
  queueStatus: (message) => queueStatus(message),
  stopRun: (message) => stopRun(message),
  clearQueue: (message) => clearQueue(message),
  resumeQueue: (message, sender) => resumeQueue(message, sender),
  flushComments: (message) => flushComments(message),
  loadCollector: (message, sender) => loadCollector(message, sender),
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then(respond)
    .catch((error) => respond({ error: error.message || String(error) }));
  return true;
});
