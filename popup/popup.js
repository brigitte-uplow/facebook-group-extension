const els = Object.fromEntries(
  [
    "context",
    "collected",
    "rendered",
    "order",
    "mode",
    "uploadState",
    "queue",
    "route",
    "run",
    "stop",
    "status",
    "results",
    "preview",
    "download",
    "copy",
    "clear",
  ].map((id) => [id, document.getElementById(id)])
);

// Written by `npm run config` from .env.local, so the bearer token is not
// checked in. Undefined when that has not been run yet. The upload itself
// happens in the background worker, which needs the same config for the reads
// a run makes on its own; this copy only decides whether to warn that there is
// nowhere for a finished run to send its posts.
const destination = globalThis.__uplowConfig ?? null;

// Order matters: each file reads the globals the ones before it published, and
// collector.js reads the scraper's. Matches COLLECTOR_FILES in background.js.
const CONTENT_SCRIPTS = [
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
  "src/collector.js",
];

let payload = null;
let tabId = null;
let pollTimer = null;
let groupName = null;
let commentDrainAsked = false;

const captureCount = () => payload?.captures?.length ?? 0;

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function showPayload(data) {
  payload = data;
  els.results.hidden = false;
  els.download.hidden = false;
  els.copy.hidden = false;
  els.preview.hidden = false;
  els.preview.textContent = JSON.stringify(data, null, 2);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Injected explicitly so tabs opened before the extension was installed or
// reloaded still work, and so code edits always take effect.
async function runInPage(method, args = [], namespace = "__fbGroupCollector") {
  // Status and export only need the isolated collector. The MAIN-world tagger
  // remounts every other Facebook group tab in the profile, so it waits for
  // Start — injecting it on every popup poll was enough to look like a reload
  // of this tab had reloaded the rest.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS,
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ns, name, callArgs) => globalThis[ns][name](...callArgs),
    args: [namespace, method, args],
  });
  return result;
}

// Starting a run is the one call that cannot go through runInPage. autoScroll
// resolves when the run *ends* — hours later, at the cutoff — and Chrome waits
// on a promise an injected function returns, so awaiting it would hold the
// popup open for the length of the sweep. The call is kicked off and
// deliberately dropped; how it goes is read back through getStatus like
// everything else on this window.
async function drainInPage() {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS,
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      globalThis.__fbGroupCollector.continueComments().catch(() => {});
    },
  });
}

async function startInPage(fromTop) {
  // This tab only. The tagger lives in Facebook's own JS world, and putting
  // it there is what used to remount every other group tab — so it is not a
  // content script, and it is not injected for status reads.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/page-id.js"],
    world: "MAIN",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS,
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (options) => {
      globalThis.__fbGroupCollector.autoScroll(options).catch(() => {});
    },
    args: [{ fromTop }],
  });
}

// Nothing here configures the run. How posts are read and how the feed is
// travelled both live in the collector: comments are always captured, threads
// are always walked newest-first up to 100 comments, and a run hands its posts
// over when it ends. This window watches that, and offers a copy of the buffer
// for a reader who wants one.
//
// The one thing it decides is when a run begins. Loading a group page sets the
// collector up but does not scroll it, because only the tab being looked at can
// scroll and several groups are usually open at once — so which one goes, and
// when, is a question only somebody looking at the browser can answer.
// Why the feed's order is reported here at all: under Facebook's default
// ranking the feed hides posts and reshuffles the rest between loads, so a run
// on a ranked feed is not a partial version of a good run — it is a run that
// cannot reach the whole group however long it scrolls. That is worth seeing
// without opening DevTools, and it is the one thing on this window a reader can
// still fix by hand, by setting the filter themselves.
function orderLine(status) {
  // Buy/sell groups use "New listings"; discussion groups use "New posts".
  if (/^new (posts|listings)$/i.test(status.feedOrder || "")) {
    return { text: "Feed sorted by newest posts.", kind: "ok" };
  }
  if (status.feedOrder) {
    return {
      text: `Feed still sorted by "${status.feedOrder}" — Facebook's ranking hides posts, so set the group's filter to "New posts" or "New listings" by hand.`,
      kind: "error",
    };
  }
  // No order settled: either no pass has reached the control yet, or there was
  // none to reach. The reason is the difference, and only the second is a
  // problem worth putting in front of a reader.
  if (status.feedOrderReason === "control_not_found") {
    return { text: "Couldn't find the group's sort filter — set it to \"New posts\" or \"New listings\" by hand.", kind: "error" };
  }
  return { text: "", kind: "" };
}

// Where the run stops, which is a date: the walk reads down until the posts are
// older than the cutoff, re-reading posts the database already holds on the way
// so their engagement gets a fresh reading. This window reports that; it does
// not get to decide it.
function modeLine(status) {
  if (!status.cutoffResolved) {
    return { text: "Checking whether this group has already been scraped…", kind: "" };
  }
  const until = cutoffLabel(status.cutoff);
  const window =
    status.scrapeMode === "incremental"
      ? "the last 48 hours"
      : until;
  if (status.drainingComments) {
    return { text: `Collecting comments for posts already read back to ${window}.`, kind: "ok" };
  }
  if (status.reachedCutoff || status.walkFinished) {
    if ((status.queue?.held || 0) > 0 && !status.queueStopped) {
      return { text: `Read every post back to ${window} — comments start on their own.`, kind: "ok" };
    }
    return { text: `Read every post back to ${window} — this run is done.`, kind: "ok" };
  }
  return { text: `Reading every post back to ${window}.`, kind: "ok" };
}

// The worker tabs, which is where the comments actually come from. Worth a line
// of its own because the feed scrolling on is no longer evidence that the
// threads are being read: the two halves run at different speeds, and a worker
// that has stopped moving looks exactly like one that is busy unless the counts
// are on screen.
//
// Nothing is stored until it is whole, so a post waiting on its thread is a post
// with no row yet — which is what `held` counts, and why it is worth a number of
// its own beside the queue's.
function queueLine(status) {
  const queue = status.queue || {};
  const outstanding = (queue.pending || 0) + (queue.inFlight || 0);
  const held = queue.held || 0;

  if (status.queueStopped && !status.drainingComments && (outstanding || held)) {
    return {
      text: `${held} post(s) parked waiting for comments — Start again to finish them.`,
      kind: "",
    };
  }
  if (!outstanding && !held) return { text: "", kind: "" };
  const lanes = queue.lanes > 1 ? `, ${queue.lanes} at a time` : "";
  return {
    text: `${outstanding} post(s) queued for comments${lanes}; ${held} waiting on a comment read, then uploaded.`,
    kind: "",
  };
}

// Whether the tab is still on the page a run can be read from. The feed tab
// has no way to navigate itself, so this is never something the extension can
// put right: a post's own route, or another page entirely, is a run that has
// stopped collecting until somebody brings the tab back.
function routeLine(status) {
  if (status.drainingComments) return { text: "", kind: "" };
  if (status.onGroupFeed !== false) return { text: "", kind: "" };
  return {
    text: `This tab is not on the group's feed, so nothing is being collected — go back to the group's feed and press Resume.`,
    kind: "error",
  };
}

// The cutoff is an ISO instant with an offset; the window only needs its day.
function cutoffLabel(cutoff) {
  const at = cutoff ? new Date(cutoff) : null;
  if (!at || Number.isNaN(at.getTime())) return "the cutoff date";
  return at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// What happened to the posts, which is not something this window does any
// more: a run hands its buffer over as soon as it finishes, and the popup is
// closed for almost all of that. So this reports rather than offers, and the
// one case worth a warning is a run with nowhere to send what it collected.
function uploadLine(status) {
  if (status.uploading) return { text: "Uploading to Uplow…", kind: "" };
  const last = status.lastUpload;
  if (last?.error) {
    return {
      text: `Upload failed (${last.error}) — the posts are still here and will be sent again.`,
      kind: "error",
    };
  }
  if (last?.failed) {
    return {
      text: `Stored ${last.stored} capture(s); ${last.failed} were rejected and are still here.`,
      kind: "error",
    };
  }
  if (last) return { text: `Stored ${last.stored} capture(s) in Uplow.`, kind: "ok" };
  if ((status.reachedCutoff || status.walkFinished) && status.collected) {
    return { text: "Sending the saved posts to Uplow…", kind: "" };
  }
  if (!destination?.url || !destination?.key) {
    return {
      text: "No upload target — run `npm run config`, then reload the extension. Posts collected meanwhile are kept.",
      kind: "error",
    };
  }
  return { text: "Posts are uploaded automatically when the run finishes.", kind: "" };
}

// What the one button on this window is for, which depends entirely on what the
// page is already doing. A run reaching the cutoff is the only finished sweep
// there is, and resuming past it would do nothing — the walk's own loop stops
// on it — so that state names Clear rather than pretending otherwise.
function runButton(status) {
  if (status.stopped) return { label: "Reload the page to collect", disabled: true };
  // Starting here would walk a page that is not the feed, and nothing in the
  // extension can take the tab back to it.
  if (status.onGroupFeed === false && !status.drainingComments) {
    return { label: "Go back to the group's feed", disabled: true };
  }
  if (status.autoScrolling) return { label: "Collecting…", disabled: true };
  if (status.drainingComments) return { label: "Collecting comments…", disabled: true };
  if ((status.queue?.held || 0) > 0) {
    // Walk already finished — comments are starting without a click.
    if (!status.queueStopped && (status.walkFinished || status.reachedCutoff)) {
      return { label: "Collecting comments…", disabled: true };
    }
    return { label: "Collect comments", disabled: false };
  }
  if (status.reachedCutoff) return { label: "Finished — Clear to read again", disabled: true };
  if (status.walked) return { label: "Resume collecting", disabled: false };
  return { label: "Start collecting", disabled: false };
}

function applyStatus(status) {
  if (!status) return;
  els.collected.textContent = status.collected;
  els.rendered.textContent = status.renderedNow;
  const order = orderLine(status);
  els.order.textContent = order.text;
  els.order.className = `status ${order.kind}`.trim();
  const mode = modeLine(status);
  els.mode.textContent = mode.text;
  els.mode.className = `status ${mode.kind}`.trim();
  const queue = queueLine(status);
  els.queue.textContent = queue.text;
  els.queue.className = `status ${queue.kind}`.trim();
  const route = routeLine(status);
  els.route.textContent = route.text;
  els.route.className = `status ${route.kind}`.trim();
  els.stop.hidden = !(
    status.autoScrolling ||
    status.drainingComments ||
    (commentDrainAsked && (status.queue?.held || 0) > 0)
  );
  const upload = uploadLine(status);
  els.uploadState.textContent = upload.text;
  els.uploadState.className = `status ${upload.kind}`.trim();
  const run = runButton(status);
  els.run.textContent = run.label;
  els.run.disabled = run.disabled;
  groupName = status.groupName || groupName;
}

async function refreshStatus() {
  try {
    const status = await runInPage("getStatus");
    applyStatus(status);
    // A stopped collector answers getStatus like a live one — the counts and
    // the group are still readable — so without this the window reports a run
    // that is not happening and cannot start.
    if (status?.stopped) {
      setStatus(status.stoppedReason, "error");
    } else if (status?.drainingComments) {
      setStatus("Collecting comments in the worker window. The feed may reload; that is expected.");
    } else if (
      !status?.autoScrolling &&
      !status?.queueStopped &&
      (status?.walkFinished || status?.reachedCutoff) &&
      (status?.queue?.held || 0) > 0
    ) {
      // The walk is over. Kick comments from here too, in case the page script
      // from before the reload is still sitting on Collect comments.
      if (!commentDrainAsked) {
        commentDrainAsked = true;
        drainInPage().catch(() => {
          commentDrainAsked = false;
        });
      }
      setStatus("Collecting comments in the worker window. The feed may reload; that is expected.");
    } else if (status?.onGroupFeed === false) {
      // Said here too: a run that walked off the feed leaves the line below
      // reading "Auto-scrolling…" forever otherwise.
      setStatus("Paused — this tab is on a post's page, not the group's feed.", "error");
    } else if (status?.autoScrolling) {
      // No denominator unless something asked for a count: the run is walking
      // toward a date, and how many posts lie above it is not known in advance.
      setStatus(
        status.progress
          ? `Auto-scrolling… ${status.progress.collected}${
              status.progress.targetPosts === null ? "" : `/${status.progress.targetPosts}`
            } posts, ${status.progress.elapsedSeconds}s elapsed.`
          : "Auto-scrolling…"
      );
    }
    // The run is unattended, so the export section has to appear on its own as
    // posts arrive; there is no longer a click to hang it off. It also has to
    // go away on its own, because the upload at the end of a run empties the
    // buffer this preview is of.
    if (!status?.collected) {
      payload = null;
      // A run that has handed its posts over has nothing left to export, and
      // that is exactly the state where Clear is the only way to read the feed
      // again — so the section stays for the button and drops the two actions
      // that would have nothing to act on.
      const resettable = Boolean(status?.walked);
      els.results.hidden = !resettable;
      els.download.hidden = resettable;
      els.copy.hidden = resettable;
      els.preview.hidden = resettable;
    } else if (els.results.hidden || captureCount() !== status.collected) {
      showPayload(await runInPage("getCollection"));
    }
    return status;
  } catch {
    return null;
  }
}

async function init() {
  const tab = await getActiveTab();
  tabId = tab?.id;
  const isGroup = /facebook\.com\/groups\//.test(tab?.url || "");
  els.context.textContent = isGroup
    ? (tab.title || "").replace(/\s*\|\s*Facebook$/i, "")
    : "Open a Facebook group feed to start collecting.";
  if (!isGroup) {
    // There is no collector in a page that is not a group feed, so there is
    // nothing for the button to start.
    els.run.disabled = true;
    return;
  }

  // The live counter and the upload line above are authoritative; don't repeat
  // a number here that goes stale a second later.
  setStatus("Press Start to scroll this group. Reload the page to start over.");
  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 1000);
}

els.run.addEventListener("click", async () => {
  els.run.disabled = true;
  try {
    const status = await runInPage("getStatus");
    const held = status?.queue?.held || 0;
    // Held threads mean the walk already finished. Scrolling again would
    // restart the feed from wherever it is (usually the top after a remount).
    if (held) {
      await drainInPage();
      setStatus("Collecting comments in the worker window. The feed will not scroll.");
      await refreshStatus();
      return;
    }
    const fromTop = !status?.walked;
    await startInPage(fromTop);
    setStatus("Collecting. The feed scrolls itself from here.");
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "error");
  }
  await refreshStatus();
});

// Stop ends the session now rather than letting the worker grind through its
// backlog first. It does not upload: captures stay in the buffer with their
// parked jobs, and the next Start reads both back.
els.stop.addEventListener("click", async () => {
  els.stop.disabled = true;
  try {
    const result = await runInPage("stopCollecting");
    setStatus(
      result?.parked
        ? `Stopped. ${result.parked} post(s) parked for the next run.`
        : "Stopped.",
      "ok"
    );
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "error");
  }
  els.stop.disabled = false;
  await refreshStatus();
});

els.clear.addEventListener("click", async () => {
  try {
    const status = await runInPage("getStatus");
    const groupKey = status?.groupKey || null;
    // The worker is a different process from the page. Clearing only the
    // collector left its 55 parked jobs in place, and the next Start loaded
    // them back. Tell the worker first, and drop the disk copy even if that
    // message lands on an older background that does not know clearQueue.
    if (groupKey) {
      await chrome.runtime.sendMessage({ type: "clearQueue", groupKey }).catch(() => null);
      await chrome.storage.local.remove(`commentQueue:${groupKey}`).catch(() => null);
    }
    await runInPage("clearCollection");
    commentDrainAsked = false;
    payload = null;
    els.results.hidden = true;
    await refreshStatus();
    setStatus("Saved posts and comment queue cleared.", "ok");
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "error");
  }
});

function slugify(value) {
  return (value || "facebook-group")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// The preview is a snapshot, but posts keep arriving while the popup is open,
// so exports re-read the live collection first.
async function exportPayload() {
  const fresh = await runInPage("getCollection").catch(() => null);
  if (fresh) showPayload(fresh);
  return payload;
}

els.download.addEventListener("click", async () => {
  if (!(await exportPayload())) return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(groupName)}-captures-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus(`Downloaded ${captureCount()} capture(s) as JSON.`, "ok");
});

els.copy.addEventListener("click", async () => {
  if (!(await exportPayload())) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setStatus(`Copied ${captureCount()} capture(s) — paste into ingest_engagement.`, "ok");
  } catch (error) {
    setStatus(`Copy failed: ${error.message}`, "error");
  }
});

window.addEventListener("unload", () => clearInterval(pollTimer));

init();
