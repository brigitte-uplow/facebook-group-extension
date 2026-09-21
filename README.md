# Facebook Group Post Scraper

A Chrome extension (Manifest V3) that collects posts from a Facebook group feed as you scroll and exports them as structured JSON. Parsing and collection are entirely local; the only thing that leaves the browser is what a finished run uploads to the Uplow MCP server, plus the two reads it makes to find out where to stop.

## Why it collects continuously instead of scraping once

Facebook **virtualizes** the group feed: once a post scrolls well out of view, its content is removed from the DOM and the slot is replaced by an empty spacer to keep memory flat. So scrolling past 20+ posts and *then* scraping can only ever return the handful still near the viewport — the rest no longer exist in the page.

To work around that, a content script harvests each post while it is still rendered and merges it into a buffer in `chrome.storage.local`, keyed per group. The collector attaches itself to any `facebook.com/groups/*` page and harvests whatever is scrolled past; the self-scrolling run is started from the popup. The counters in the popup make the difference visible: **waiting to upload** (what the current run has collected and not yet handed over) versus **on screen now** (what is currently rendered).

Two consequences worth knowing:

- Posts you scrolled past *before* installing or reloading the extension are unrecoverable. Scroll back up — the collector picks them up as Facebook re-renders them.
- A post is saved as it appeared when it passed by. If it is still rendered when re-harvested, richer data wins: longer text, higher counts, more comments.

## Where a run stops

A run always starts at the newest post and walks down. Where it stops is **a date**, chosen from the group's outlet in Uplow:

- **`lastDiscoveredAt` is null** (or the group is not in the table yet): first sweep. The cutoff is `2026-09-01T00:00:00+08:00`.
- **`lastDiscoveredAt` is set**: the group has already been ingested at least once. The cutoff is **48 hours before the run starts**.

A Facebook-group capture re-dates that outlet's `lastDiscoveredAt` on ingest, so the next Start on the same group takes the short window on its own. The walk reads down until the posts are older than the cutoff it chose and then ends.

**A post already in the database is read again rather than skipped, and the re-reading updates it.** That is the point of the date. Likes, comments and shares keep moving long after a post is published, so a run that stopped at the first post it had already stored could only ever see a post's engagement as it was the day it was first collected.

A post is recognised by its **`externalPostId`** — the Facebook post id, the only id Facebook and this database agree on. At the start of a run the extension reads back what the database already holds for the group (`list_outlets` to find the source, then `list_engagements`), which gives it, per post id: the row's `captureId`, its `likes`, `commentsCount`, `shares`, `capturePhase` and `commentsComplete`. That one read is what the rest of this section is built on.

**A post that is already stored is re-sent under the `captureId` its row already has.** The backend keys rows on `captureId` and replaces what it finds, so matching on the post id and then reusing the row's key is what turns the reading into an update: a post whose likes went from 12 to 40 ends up as one row saying 40, with its new comments merged in, rather than two rows disagreeing about which count is current.

A post with no row yet has no key to reuse, so it keeps the `captureId` the scraper **derives** from it — the group and post id hashed together, or the permalink where there is no id. Deriving rather than randomising matters for exactly one case: a later run that cannot reach the server still produces the same id for that post, so it updates the row instead of inserting a second one. Only a post with neither an id nor a permalink falls back to a random id.

### Every post is read, every run

There used to be a skip here: a post whose likes, comments and shares matched the stored row, and whose thread had been read in full, was left alone. It never fired. This MCP exposes no `list_engagements`, so the map it compared against was hardcoded empty, and every post was read and re-sent regardless — which is what still happens, now without the code that pretended otherwise. `readStoredEngagement`, `unchangedSince` and the `unchanged` counter are gone; `src/background.js` carries a note saying what to put back if the server grows the tool.

Two things keep the walk from ending too early, both in `collectPost()`:

- **One old post is not the cutoff.** Facebook floats pinned and announcement posts above a feed that is otherwise newest-first, so it takes `PRE_CUTOFF_POSTS_TO_END_RUN` (3) consecutive pre-cutoff posts to end the run. A single old post is skipped and the walk carries on past it. Below the cutoff every post is older than it, so the streak only ever runs out downward.
- **An undated post is never a floor.** `post.publishedAt` is null where the scraper could not resolve a timestamp, and reading that as "old" would end a run on a post that may well be today's. Such a post is collected instead — a redundant capture costs less than a lost sweep.

**There is no post-count ceiling and no limit on how long a run may take.** The date is the whole boundary: however many posts a group has published since the cutoff is how many one run reads, and however long the feed makes that take is how long it takes. A count or a clock that ended runs early would end them somewhere the data could not explain. Everything else that stops a run stops it because the feed did — the end of it, or a scroll that loads nothing new.

The one wait that is still bounded is waiting for a page that is not the run's to scroll: a tab in the background, or a post the reader opened and left open. `MAX_PAGE_UNAVAILABLE_MS` (10 minutes) caps that, because scrolling underneath a reader is the thing the wait exists to avoid and looping on it forever would mean the posts already collected never get handed over. A session that gives up there uploads what it has, and Resume continues from where the page ended up.

`getStatus()` reports `cutoff`, `reachedCutoff`, `uploadedThisRun`, `queue` (the comment worker's `pending` / `inFlight` / `failed` / `parked`, plus `held`, the posts kept out of an upload until their thread lands) and `queueStopped`. `reachedCutoff` is the only one of them that means "done".

Note what the server is *not* asked. Earlier versions read it to find out **where to stop**; a post's own timestamp answers that locally now. Nothing is read back at all.

The buffer follows from the same idea. `state.entries` holds **only the posts of the current run** — it is not a history of the group. A successful upload — which happens on its own when the run ends — empties it, because the posts are in the database now and the database is where history lives. A failed or partial upload leaves it exactly as it was, so the run is the retry. The one number that survives an upload is the run's own tally, which is what the popup counts rather than anything a boundary is drawn against.

Emptying the buffer mid-run raises one question the cutoff does not answer: the posts are gone from `entries`, so nothing would stop the walk re-reading them and spending a permalink load and an upload to tell the backend what it was just told. `state.uploaded` is the answer — post ids an upload in this page load has handed over, which the walk skips. It is deliberately **not persisted**, because a later page load is a later run and is meant to re-read those posts for their new counts.

## What it extracts

The export is a flat list of captures — **one object per post, never one per group** — in the shape `src/contract.ts` declares:

```json
{ "captures": [ { "captureId": "…", "platform": "facebook_group", "…": "…" } ] }
```

| Field | Notes |
| --- | --- |
| `captureId` | The existing row's key where the post is already stored, matched on `externalPostId`, so the backend updates that row. Otherwise a UUID derived from the post (group + post id, else permalink), which stays the same on every later run |
| `platform`, `schemaVersion`, `extractorVersion` | Constants identifying what produced the capture |
| `sourceUrl` | The post's own permalink, tracking params stripped. Falls back to the feed URL |
| `scrapedAt` | ISO-8601, from the most recent pass |
| `phase` | `full` when comments were collected, `fast` when they were skipped |
| `externalVideoId` | The group post id: Facebook's own page state for the post, then the hrefs in its subtree — including a photo link's `set=gm.` id, which names the post while its `fbid` names only the picture |
| `group.externalId`, `.name`, `.url` | Which group the post came from |
| `author.handle`, `.displayName`, `.profileUrl`, `.verified` | Handle is the vanity slug, or the numeric profile id when that is all the link gives |
| `post.caption` | The post body; "See more" is expanded first so long posts aren't truncated |
| `post.publishedAt` | **ISO-8601 or null, never a relative label.** A `5h` resolves to an instant and warns that it was approximated |
| `post.hashtags` | Hashtags off the caption without `#`. Mentions are deliberately not extracted here — the backend derives them from `post.caption` at ingest, so the extension ships no entity catalog and no matcher |
| `post.hasVideo` | Whether the post carries a video of its own, which is what tells the backend to download and transcribe it |
| `post.thumbnailUrl`, `.durationSeconds`, `.soundName` | Largest non-avatar image or video poster; duration for videos, sound never for group posts |
| `metrics.likes`, `.comments`, `.shares`, `.views`, `.saves` | Counts normalized from `1.2K` style labels. `likes` is total reactions; `saves` is never visible to a visitor |
| `comments[].authorHandle`, `.text`, `.likes`, `.publishedAt` | The author and age arrive glued together and are split apart; the name repeated at the top of the body is stripped. A comment's age is kept as its raw label |
| `commentsComplete` | False whenever a cap, an unclicked "view more", or Facebook's own count says the thread is short |
| `warnings` | `field:reason` codes for everything that fell back or failed |

Two deliberate asymmetries:

- **A post's date is ISO or nothing; a comment's can stay a raw label.** Post dates are compared across posts, so a `5h` is resolved against the scrape time — and says so in `warnings`. Comment dates aren't, so passing the label through beats claiming a precision it doesn't have.
- **`comments[].externalCommentId` is always null.** Facebook only exposes a comment id when a permalink happens to be rendered, so position in the array is the only identifier every comment reliably has.

`author.verified` is `true` on a badge and `null` otherwise: absence of a badge means the page never said, not that the author is unverified.

`post.hasVideo` is read off the post's links rather than a `<video>` element, because the feed does not mount one until the reader presses play — which is also why `post.durationSeconds` is null for most video posts and cannot stand in for it. Neither can `post.thumbnailUrl`, which falls back to the largest image on any post. Links inside the comment threads and links naming another group's video are both excluded, on the same reasoning that keeps `externalVideoId` from borrowing an id off a reshare: a commenter's paste is not the post's attachment. Where two passes disagree, the one that saw a video wins, since the pass that missed it saw a post that had not finished rendering.

A post's own id comes out of Facebook's page state. Every feed story is a React component whose props carry the real `post_id`, and those props hang off the DOM node as expandos that an isolated content script cannot see — it gets a different JS wrapper for the same node. So `src/page-id.js` runs in the page's own JS world, reads the id, and stamps it on the element as `data-fb-post-id`; `src/scraper.js` reads the attribute back in the isolated world and validates it there, where the hrefs and the current group are. A stamped id is used only once it is id-shaped, is not a comment id from the unit's own links, and agrees with the post's own permalink where it has one — a disagreement ships the permalink's id and warns `externalVideoId:page_state_mismatch`. Anything else is dropped rather than downgraded, because a wrong id joins to another post's row.

Not every build of Facebook attaches those props to its DOM nodes — some attach only event expandos, leaving a post's own node carrying nothing, in which case the tree is entered from the `__reactContainer$` fiber root instead and descended to the unit. Failing that too, `page-id.js` has a second source entirely: it wraps `fetch` and `XMLHttpRequest` (hence `document_start`), reads each story's id out of the `/api/graphql/` responses that render the feed, and joins it back to the post on the head of the post's own text. Responses are cloned before being read, so nothing the page sees changes. Two costs come with that: only responses arriving after the script is installed are seen, so a feed scrolled before it loaded has to be scrolled again, and a text head matching two stories is refused rather than guessed.

A wrapped request is only half of how a story reaches the page. The first screen of a group feed is server-rendered, its stories shipped in inline `<script>` JSON that no wrapper can see, and Comet appends more of the same as the feed streams — so `harvestInline()` reads those blobs too, once each, on every tagging pass. Without it the newest posts at the top of the feed were the one place no id could be found, which is where a scrape usually starts. `stats().inlineRead` counts the blobs read and `heads()` lists the text-to-id pairs harvested so far, which is what tells an id that was never harvested apart from a head that does not appear in the unit's text.

Neither side of that join is compared as text. A payload carries what the author typed, while the DOM carries what Comet rendered it as, and the two agree on almost nothing that is not a letter or a digit: emoji become `<img alt>` that `innerText` cannot see at all, spacing is rewritten, `See more` is appended, punctuation and currency marks are split across nodes or swapped for lookalikes. So both sides are reduced to a skeleton — NFKC-normalised, lowercased, everything but letters and digits dropped — and matched on the first or last forty skeleton characters, since a post can lose either end between the payload and the page. Letters and digits are the post: a payload that disagrees with the page about *those* is a different post, and is not matched.

Where a caption cannot be a key on either side — all emoji, or words that live inside an image — the story is held by its author id instead, and used only while that author has exactly one such story. That tier is deliberately narrow: it never serves as a second guess at a story whose text merely failed to match, because that case is indistinguishable from a different post by the same author. A bare reshare is the other shape the join has to allow for: it wrote nothing of its own, so the row shows the embedded story's words while the id the row needs is the resharer's. Those texts are harvested into a second, lower-priority map, consulted only once a story's own words have failed, because the original may also be in the feed under its own id with the very same text; an ambiguous match is refused in either map rather than guessed. A tombstone (`This content isn't available right now`) is the one shape no join can reach: no text of its own, no permalink, and no id on the page or in the payload that rendered it. Nobody wrote it, so `looksLikePost` rejects a unit that is nothing but one, and it never becomes a capture. The two placeholder lines are also treated as chrome, for the post that has words of its own and merely embeds an unavailable story — that one is still a post.

That matters most for the posts that used to have no id at all. Reading an id off an href needs an href: Facebook populates the header link only once the reader points at it, a post with an attachment has a photo or reel link to read a (wrong) `fbid` off in the meantime, and a post with comments has their permalinks to borrow one from — but a text-only post with an empty thread has neither, and shipped with `externalVideoId:missing` and the feed URL as its `sourceUrl`. Page state names it anyway, and its `sourceUrl` is derived from that id (`sourceUrl:derived_from_post_id`). The four href tiers and the header hover — `revealPermalink`, which is also what fills in a missing `publishedAt` — remain for every post page state cannot answer for; the hover is skipped only when a validated id is already in hand.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `facebook-scraper-extension` folder.
3. Pin the extension so the toolbar icon is visible.

## Use

Open a group feed (`facebook.com/groups/...`), then open the popup and press **Start collecting**. The extension travels the feed itself from the newest post down and stops at whichever comes first — the cutoff date (see above) or the end of the feed.

Loading the page sets the collector up but deliberately does not start it. Only the tab being looked at can scroll — a backgrounded tab's timers are throttled and its run gives up after `MAX_PAGE_UNAVAILABLE_MS` — so several groups open at once would be several runs racing each other, all but one of them in a tab that cannot make progress. Opening the tabs first and starting them one at a time is the arrangement that actually works, and it is the only one a single person could plausibly be doing.

The only other button while a run is going is **Stop**, which ends the session without ending the run — see the comment worker below for what it parks. There is nothing to configure. Reload the page to start a fresh run from the top; the button resumes a run that ended rather than restarting it, so a sweep interrupted by a spell in the background keeps its place. Scrolling yourself works too, and posts you pass are harvested whether or not a run is going; open the popup any time to see the count and export.

The first thing a run does, before it reads a single post, is put the group's own feed filter into **New posts**. Every group has that filter, and Facebook defaults it to "Most relevant" — a ranking that hides posts outright and reshuffles what is left between page loads, so the same scroll down the feed reads a different, partial feed every time and no amount of scrolling reaches the rest. Under "New posts" the feed is the group's history in order, which is what makes a walk down it exhaustive and resumable. It is set once per page load, because switching the filter refetches the whole feed rather than reordering the posts already on screen: doing it after collection had started would strand the run in an order that no longer exists. "Recent activity" is deliberately not accepted as a substitute — it floats old posts back up as comments arrive, so a downward scroll never passes a post just once. A group whose filter can't be found, or whose menu doesn't offer "New posts", is collected in whatever order it arrived in; the popup says so above the status line, and `getStatus().feedOrder` / `.feedOrderReason` report which order that was and why. That is the one thing in the popup a reader can still fix by hand — setting the group's filter yourself has the same effect.

**The feed tab clicks nothing that can open a post.** This is the rule three earlier builds kept trying to get away without. Expanding a thread in the feed meant clicking "View more comments" and the order chip inside a post card; expanding a photo post's caption meant clicking a "See more" that Facebook renders inside the anchor that opens the post. Both took the tab to `/permalink/…`, and once the navigation was blocked the same clicks still ran Facebook's own handler and opened the post's **dialog** over the feed — where the walk stalls, because a dialog is normally the reader's and the collector waits behind it. A live run with `blockedNavigations` empty, `dialogOpen` true and the URL untouched is what finally told them apart: there was no navigation to block, only a click that opened a post. So the card is read exactly as rendered, a "See more" that sits inside a link is left alone and its caption stays truncated, and anything needing more than that is the worker's.

Comments are **not** read on the feed tab. From 0.13.0 there are worker tabs, alone in their own minimized window, that do nothing but open post permalinks. When the walk meets a post whose thread is longer than the card is showing, it stores the post, hands the permalink to that worker, and scrolls straight on; the comments come back by message minutes later and are folded into the post's entry then. A post whose whole thread is already on the card — which is most posts in a busy group — is read where it stands and never queued.

That split is the whole point of the release. Every earlier way of reading a thread cost the feed tab the page it was walking: the comment tally is often an anchor to the permalink, so clicking it landed the tab on `/permalink/…` with the *home* feed rendered behind it; the `history.back()` that repaired that remounted the chronological feed at its newest posts, sending an hour-old walk back to the top; and the dialog that did work stopped the scroll for as long as the thread took to read. The feed tab now has no way to navigate at all — `restoreFeedRoute`, `openPostDialog` and the rest of the dialog subsystem are deleted rather than left unused, and the tab never calls `history.back`, `location.assign` or `reload`.

Enumerating the controls that navigate turned out not to be a strategy — each release found another one — so a run now holds a guard that makes navigation impossible rather than unlikely. A `pushState`, `replaceState`, `location.assign` or `location.replace` that would change the **path** is dropped and recorded; query and hash rewrites are left alone, since that is how Facebook stores a filter or a scroll position and blocking them breaks the page for nothing.

The guard is held for the whole run, not per click, and that is the correction a live run forced. The first build closed it 250ms after each click on the theory that Comet routes on a microtask. It does not: resolving a route is a network round trip, and the navigation lands seconds after the click that asked for it — so the tab walked off to a permalink with `blockedNavigations` empty, the guard having shut long before. Held open it cannot use "we are mid-click" to tell our navigation from the reader's, so it uses intent instead: a trusted click or keypress within the last two seconds means the person asked, and the route is let through. Outside a run each click still gets its own short window, and the release puts every patched method back.

What the guard caught is kept rather than swallowed — `getStatus().blockedNavigations` lists each attempt with how it tried and where it was going, the `[fbgs] pass` trace carries the running count, and a control the guard actually caught is not clicked again on later rounds. An empty list on a run that stayed on the feed is the expected reading; an empty list on a run that did not is the guard failing to see what moved the tab, which is how the trailing-window bug was found.

That covers what the tab does deliberately; the other half is what it does by accident. Every control the feed tab clicks — the caption's "See more", the ones inside comments, the feed's sort chip and a thread's — goes through `clickWithoutNavigating`, because on a photo post Facebook renders "See more" *inside* the anchor that opens the post, and a run that expanded such a caption ended up exactly where the tally used to put it: `/permalink/…` with the home feed behind it. Cancelling the click is not enough on its own, since Comet's router reads the `href` off the anchor rather than letting the browser follow it, so the attribute is taken off for the length of the click and put back after. And because nothing may take the tab back, a tab that ends up off the feed anyway is reported rather than worked around: `getStatus()` carries `onGroupFeed`, `offFeedSince` and `offFeedReason`, the run ends with "the tab left the group's feed" instead of the generic covered-page reason, and the popup replaces its Start button with a line saying to go back to the feed and Resume.

In the worker, each post is sorted from "Most relevant" to "Newest" and paged down to 100 **top-level** comments (replies come with them and are stored, but do not count toward the hundred) or the end of the thread. The sort is verified rather than assumed: the chip has to agree that the order changed, or the thread underneath it has to be replaced, within about six seconds and up to two re-openings of the menu. A sort that cannot be proved still keeps its comments, tagged `comments:unsorted` on the capture, because a hundred comments in Facebook's relevance order stored under the name of the newest hundred is the one failure nothing downstream could see.

**Two permalinks are read at a time.** A thread is a page load, a wait for Facebook to paint it and a walk down it — most of that spent waiting rather than working — so the queue is drained by `WORKER_LANES` lanes, each a tab of its own inside the one hidden window. Two, not more: a lane is a logged-in Facebook tab opening a post every half-minute, and how many of those an account can run before Facebook starts refusing them is not a thing to discover on a live sweep. `queueStatus` reports `lanes` alongside `inFlight`, so a queue that is merely deep can be told from one that has stalled. The lanes share one window, because there is then one thing to keep out of sight rather than one per lane, and every lane tab is created by the worker into that window — `assertWorkerTab` accepts a tab only if the worker made it, so a lane can never become the tab being scrolled.

A lane that reads a post Facebook says has comments and finds none is treated as a page that did not render rather than a thread that is empty: `scrapePermalinkComments` returns `thread_did_not_render`, the queue retries the job once, and a second failure puts `comments:worker_failed` on the capture. Whether a second tab in a minimized window paints the way the first one does is the one thing about the lanes that no offline test can answer, so it is made to announce itself rather than to quietly file posts with ninety comments as having none.

Waiting for a thread to grow is **watched, not polled**. The worker's tabs are hidden, where Chrome clamps `setTimeout` to about a second, so the old 250ms poll cost four times what it asked for and every round of every thread paid it twice over. A `MutationObserver` is not clamped, so a thread that answers in 300ms is read in 300ms; the expensive count of comment roots is taken only once the far cheaper tally of `role="article"` nodes has moved. The settle window is then sized from what the thread has actually been taking to answer rather than from the guess made for it, and two silent rounds end a walk instead of three — a round that answers is seen the moment it does, so one that stays silent is evidence rather than a slow poll.

**A post is stored once, when its reading is whole — never before, and in the batch the run hands over at the end.** The hand-over is unchanged: scrolling collects, the worker fills in the threads, and `finishRun` uploads the lot when there is nothing left to read. A post the worker still owes a thread stays in the buffer with no row at all, however many runs that takes, because a capture is not a draft: `ingest_engagement` marks a claimed video **completed** on the strength of one, so a post stored with the two comments its feed card happened to preview closes the work out at that reading and nothing downstream can see that it is one. A thread arriving is persisted, not uploaded — what the hold is for is that the comments are there to go with the post when the batch goes, not that they arrive in a request of their own.

**A hold ends when the queue stops owing the post an answer, not when a clock runs out.** That distinction is the bug this release exists for. The hold used to have a three-minute safety release, measured against a queue drained one permalink at a time: from the fourth or fifth post onward every post's clock expired while its job was still waiting its turn, so it was filed `comments:worker_timeout`, uploaded with the comments its card had previewed, and its entry deleted — after which the worker's answer arrived for an entry that no longer existed (`applied: false, reason: "no_entry"`), and `state.uploaded` made the post skippable on every later run. The comments were not late; they were unstorable, and the row that replaced them claimed a ninety-comment post had two.

So `queueStatus` now reports `postIds` — every post the queue still owes an answer for, queued, in flight, or parked on disk — and `releaseAbandonedPending` holds a post for exactly as long as its job appears in that set. A job that exists nowhere is a post waiting on nothing, and only then is the hold released, marked `comments:worker_lost` rather than passed off as a thread that was read. There is a grace period before the question is asked at all, because the message that queues a job is still in flight when the post starts waiting, and a stale reading of the queue is not evidence about the queue as it is now; the old wall clock survives only as a backstop set far beyond the drain budget, for a queue that claims a job it never answers for. `uploadCollection` reads the queue immediately before deciding, so the decision is never made on a reading from whenever the last pass happened to ask.

The worker window is asked to open minimized, but "minimized" is a request to the window manager rather than a guarantee, and a session with no window manager — Xvfb, the stripped Linux desktops that automation runs in — ignores it silently. The worker then opens over the feed with a permalink in it, which looks exactly like the feed tab having navigated to a post, and a bot driving the screen may go on to click the wrong window. So the state is read back after the window is created and again after every navigation, since loading a page raises the window on some desktops. A window that did not minimize is moved off the side of the display instead, `-32000` first and `+32000` if that was clamped back. A desktop that defeats both is reported rather than papered over: `workerHidden` in the queue status reads `minimized`, `offscreen` or `visible`. Only the window this extension created is ever moved, minimized or read — `assertWorkerWindow` guards each call the way `assertWorkerTab` guards the tab ones, so the feed's window is never touched.

**A run has two phases, and the worker belongs to the second.** Opening a permalink remounts every Facebook tab in the profile — the feed tab among them — so a thread read while the walk was going reloaded the very tab doing the walking and sent it back to the top of the feed. That is what a night of "the page keeps reloading" turned out to be, and it was settled by running a walk with the worker disabled: 24 posts, no reload, where the same walk with the worker draining lost its place every few posts. So the walk only queues — `queueComments` carries `defer` while `autoScrolling` is true — and `finishRun` drains the queue once there is no walk left to lose. A remount during phase two costs nothing: the posts are collected and persisted, the queue is on disk, and the tab keeps its id so the answers still reach it.

A parked queue is read back on page load but **not** run there. The feed tab announces itself to the worker on every load, and draining at that point meant that simply reloading a group which had jobs parked opened the worker and sent it to a permalink — and a Facebook tab navigating remounts every other Facebook tab in the profile, so reloading one group appeared to reload them all, with no run going and nobody having asked for one. The jobs are loaded and left alone; `finishRun` sends `resumeQueue` with `start` set, and that is the only thing that drains them.

**Stop** ends the scrolling session now rather than letting the worker grind through its backlog. The jobs already running are given about fifteen seconds to finish, anything still queued is parked in `chrome.storage.local` — the running ones first, in lane order, ahead of what was queued behind them and uncharged an attempt — and the worker window closes. Nothing is uploaded. The posts stay in the buffer with their jobs; the next Start reads both back. A run that reaches the cutoff on its own is the hand-over: it waits for the queue to drain, then closes the window and uploads.

If you open a post yourself, collection pauses until you close it rather than fighting you for the page. Every dialog on the feed tab is yours now — nothing in the extension opens one.

When the run ends — cutoff reached, end of feed, or a page that stayed covered — it uploads what it collected to Uplow on its own. There is no upload button, and there never was a moment to press one: the popup is closed for almost all of a run, and a run that had to be watched to its finish would not be an unattended one. The buffer is emptied only by a hand-over the server accepted in full; anything else leaves the posts exactly where they are, retried twice on the spot and then again the next time the page is loaded. The popup reports which of those happened, and `getStatus()` carries the same thing as `uploading` and `lastUpload`.

**Download JSON** and **Copy JSON** are still there for a reader who wants a copy; both re-read the live buffer first, and neither empties it. **Clear** throws away the buffer, the walk behind it, and the comment queue with them — the entries those jobs were going to land on are gone, so parking them would only deliver comments to posts the next run has not read yet.

The buffer persists across a page reload, so a run interrupted halfway resumes toward the same cutoff instead of starting its count over.

## When nothing is scraped

`src/scraper.js` still exposes a `diagnose()` helper that reports how many candidate nodes each detection strategy found plus a text preview of the first few, which distinguishes a detection failure from a field-extraction failure. It has no button; call it from DevTools on the group page, switching the console's context dropdown from `top` to the extension's content script context first (the scraper lives in an isolated world):

```js
copy(await __fbGroupScraper.diagnose());
```

Its `feedOrder` field is the group's own filter as the scraper sees it: whether the control was found at all, what it currently says, and every element on the page whose words match one of the order labels — including the ones ruled out for sitting inside a post or a menu. An empty `candidates` list is a wording problem and a list whose every entry was ruled out is a scoping problem; the two need opposite fixes. That is what tells a feed left on "Most relevant" because the chip could not be seen apart from one nothing tried to order — and `__fbGroupCollector.getStatus().feedOrderReason` names the outcome of the last attempt (`control_not_found`, `menu_item_not_found`, `already_set`).

Its `pageIdTagger` field is the main-world half reporting in, and `stampedPostId` on each sample is what that half read for that post. `null` for the former means the tagger never ran at all, which is a different failure from props that carry no id. The tagger itself lives in the page's own world, so it is the one thing here you inspect with the console context left on `top`:

```js
__fbGroupPageId.stats();
```

How posts are located, in order — the results are pooled, validated, and any candidate that *contains* another candidate is dropped as a container:

1. `div[role="article"]` nodes that aren't comments.
2. Direct `div` children of `div[role="feed"]`.
3. Climbing up from every group-post permalink anchor to its enclosing unit.

That third strategy plus the container filter is what fixes the common failure where a single wrapper element swallows the entire feed and every field comes back `null`.

## Files

```
manifest.json             permissions, content scripts, popup registration
src/contract.ts           the capture shape, as types only — never loaded at runtime
src/page-id.js            main-world post id reader; stamps data-fb-post-id
src/text.js               reading text off the DOM, stripping UI furniture, capture ids
src/time.js               a printed age ("3h", "Yesterday at 5:03 PM") to an ISO string
src/motion.js             scrolling in jittered, decaying ticks; the seedable clock/dice
src/patterns.js           every URL shape, control wording, and version stamp
src/utils/links.js        what an href says: group, profile, post, comment
src/utils/dom.js          finding controls by label, clicking them, reading panes
src/posts/content.js      author row, caption, hashtags, "See more" on a post
src/posts/detect.js       which nodes are posts, and which are comments under them
src/posts/timestamp.js    a post's publishedAt, out of a header that may say "8h"
src/posts/identity.js     a post's permalink and the id the group knows it by
src/media.js              thumbnail, duration, whether there is a video attached
src/metrics.js            reactions, comments, shares, views
src/comments/extract.js   one rendered comment, read into a record
src/comments/order.js     one thread's order: Newest / All Comments / Most relevant
src/comments/expand.js    clicking a thread open, and waiting for it to arrive
src/comments/capture.js   a thread taken inline in the feed, and its time budget
src/comments/permalink.js the worker tab's half: a whole thread on its permalink
src/feed-order.js         the group feed's own sort chip ("New posts")
src/scraper.js            parsePost/diagnose, and the __fbGroupScraper namespace
src/collector.js          observers, merging, persistence, auto-scroll, run boundary,
                          queueing comments and folding the worker's answers back in
src/background.js         the only network client (ingest), and the comment worker:
                          one minimized window, a persisted FIFO queue, serial drain
popup/popup.html          UI
popup/popup.js            injection, polling, export, clipboard
popup/popup.css           styling
```

`scraper.js` does no state management and `collector.js` does no parsing; the collector drives the scraper's `detectPosts`/`parsePost` while scrolling.

There is no build step, so the scraper's halves are plain scripts loaded in order rather than modules: each publishes one frozen namespace on `globalThis` (`__fbGroupText`, `__fbGroupPatterns`, `__fbGroupPostDetect`, and so on) and destructures the namespaces it needs at the top. Load order is therefore the dependency order, and it is a topological one — no half reads a namespace published after it. `text.js`, `time.js` and `motion.js` do not touch the DOM looking for posts at all — they are given a string, or a distance to scroll. **Anything that injects the scraper has to inject every half, in that order**: the `content_scripts` entry in `manifest.json`, `SCRAPER_FILES` in `src/background.js` (which omits `collector.js`, since the worker tab never sweeps a feed), and `CONTENT_SCRIPTS` in `popup/popup.js`.

## Acceptance checklist for the two-tab worker (0.13.0)

The claim this release rests on — that the feed tab never navigates and never loses its place — is one only a live group can settle. Walk this once on a real group before trusting a long run to it.

A temporary trace is built in for exactly this. The feed tab logs `[fbgs] pass` once per collection pass with its URL and scroll position, plus `[fbgs] feed tab unloading` and `[fbgs] feed tab popstate` if either ever fires. Watch the content script's console context (switch the dropdown from `top` to the extension's isolated world). **Delete the three `console.debug` calls in `src/collector.js` once this checklist has been walked** — they are diagnostics for this release, not permanent instrumentation.

1. **Start a run on a busy group** with several long threads near the top. Two windows should exist afterwards: the one you are looking at, and a minimized one. The minimized one should have exactly one tab in it, moving from permalink to permalink, and no new tab should ever appear in the feed window's tab strip. On a host with no window manager the second window will be off-screen rather than minimized; `queueStatus.workerHidden` says which. If it reads `visible`, the worker is sitting over the feed and the placement fallback has been beaten — the thing to raise before anything else, since a bot driving the screen will be clicking the wrong window.
2. **Watch the feed tab's console for the whole run.** There must be no `unloading` and no `popstate` line at all, the `href` on every `[fbgs] pass` line must be the plain group URL, and `scrollY` must only ever increase. A single `popstate` is the failure this release exists to remove — note which post preceded it. `blockedNavigations` on the same line should stay at `0`; a count that climbs means the guard is doing its job but some control is still trying, and `getStatus().blockedNavigations` names it.
3. **Check sibling group tabs.** Open two other groups in the same window before starting. The 0.12.18 note claims navigating a Facebook tab remounted siblings at their newest posts; the blank-first-then-navigate sequence and the separate window are the defences against it. If a sibling scrolls itself back to the top while the worker is running, that defence is not enough, and the fallback to raise before changing anything is a separate browser profile for the worker.
4. **Confirm the comments actually arrive.** The popup's queue line should rise as long threads are met and fall again behind the walk. A queue that climbs while `held` climbs with it and neither ever falls is a worker that has stopped; check the service worker's console from `chrome://extensions`.
5. **Confirm the threads are sorted.** Spot-check a long post in the exported JSON: the first comment should be the newest, and the capture should not carry `comments:unsorted`. If it does, the chip could not be verified on that post — worth a note, not a failure.
6. **Press Stop with several posts queued.** The minimized window should close within about fifteen seconds rather than grinding through the backlog. The popup should say how many posts are parked, and the upload should go out with only the finished ones.
7. **Start again.** The parked posts should get their comments before anything newly discovered does, and the walk should resume from where it was rather than from the top of the feed.
8. **Close the feed tab mid-run**, then reopen the group and start again. Same expectation as the Stop: nothing is lost, and the parked posts are read first.

## Caveats

- **Nothing is marked up until React has hydrated.** `src/page-id.js` runs at `document_start`, which is before Comet hydrates the server-rendered first screen, and stamping `data-fb-post-id` onto a node React is in the middle of adopting is a mutation it did not make — React answers with error #418 and throws the server's markup away to re-render. On a machine with several group tabs open that was enough to make reloading one tab remount the rest, which read exactly like the scraper navigating tabs it never touched. So the first tagging pass waits for the `load` event and an idle tick; only the inline blobs, which are read and never written, are harvested before that. `__fbGroupPageId.version` in the page's own console says which build is live — and note that reloading the extension does **not** reload a page already open, so a stale version there means the page still needs a refresh.
- **Selectors are inherently brittle.** Facebook's markup is obfuscated and changes often, so the scraper targets ARIA roles/labels, `href` shapes, and text heuristics rather than class names. If captions or engagement counts start coming back `null`, the fallbacks in `src/scraper.js` (`getCaption`, `getMetrics`) are the places to adjust.
- **English UI assumed.** Comment authors and engagement counts are matched against English strings such as `Comment by …`, `comments`, `shares`, and `See more`. Switch Facebook to English or localize the regexes.
- **The group's feed filter is matched by its English labels too** ("Most relevant", "Recent activity", "New posts"), falling back to a control whose `aria-label` mentions sorting. It is matched by its words rather than by a role, because on a live feed the chip turned out to be a bare `<span>` inside a div carrying no role at all — the click is left to bubble to whichever ancestor holds the handler. That widens what can be hit by mistake, so a candidate is rejected if it sits inside a post, a dialog, or an open menu: a comment thread's ordering menu is worded identically and is portalled to the end of `<body>`, right where the feed's own chip lives, and clicking one of its items would re-sort somebody's thread. A switch is never attempted while any menu is open. If no chip is found, the feed is collected under Facebook's ranking — the one failure here that costs coverage rather than fields, since a ranked feed never serves the whole group.
- **The comment ordering menu is matched by its English labels** ("Most relevant", "Newest", "All comments"). If it can't be found, or the click can't be proved to have landed, the thread is still walked and stored — tagged `comments:unsorted`, under whatever order Facebook applied.
- **Comments are read on the post's permalink in a second, minimized window**, not on the feed. A post whose whole thread is already on its feed card is read there instead. Nothing is clicked on the feed tab to get into a thread, the feed tab has no way to navigate at all, and every control it does click is stripped of the link around it first. If the tab still ends up off the group's feed, the run stops collecting and the popup says to bring it back.
- The feed tab must stay in the foreground: Facebook throttles a backgrounded tab's timers and the run pauses itself while the tab is hidden. The **worker** window is minimized on purpose and reads fine there, which is the one place this build asks Facebook to serve a background tab — if comment counts start coming back short on long threads, an un-minimized (but unfocused) worker window is the first thing to try.
- **A worker window you can see is a window manager that refused to minimize it**, not the feed tab navigating. It is common on Linux automation hosts with no window manager; the fallback moves the window off-screen, and `workerHidden` in the queue status says which of the two took. Note that an off-screen or minimized worker is a hidden tab, so Chrome clamps its timers to about a second and throttles harder after five minutes — the same trade named in the point above, and the reason a `visible` worker is slow-but-correct rather than broken.
- Auto-scrolling fast and far can get you rate limited or temporarily blocked by Facebook. The loop travels the feed in short runs of small stepped flicks — swipe-length gaps between the flicks of a run, then one variable, human-length pause at the end of it, half a second to four seconds — and a run never covers more than a screenful, because a post scrolled past before the harvest sees it is a post lost. A pace governor caps the whole session at 12-20 posts a minute; the thread reads are usually slower than that anyway, which is where most of a run's time actually goes. The deadline is not derived from the pace — it is sized against a deliberately slower 8 posts a minute plus the thread reads, roughly six and a half minutes for 20 posts, so that a machine spending time waiting for the page still finishes its run.
- **The gestures adapt to how loaded the machine is**, which matters on a hosted browser or VM where timers are starved and paints arrive late. Every gesture times its own sleeps, and a tab running behind gets more and smaller steps per flick, shorter runs before each stop, and a wait for the viewport to stop changing before the beat is harvested. Nothing is ever scrolled past to save time: a slow machine collects the same posts, just slower.
- Scraping Facebook is against their Terms of Service, and group content may include personal data. Use this on groups you have legitimate access to, and handle the output responsibly.

## Development

No build step — plain JS. After editing, hit the reload arrow on `chrome://extensions`. The scraper is re-injected on every run and deliberately has no "already loaded" guard, so you do **not** need to reload the Facebook tab to pick up changes.

The collector's state object is the exception. It survives re-injection on purpose, so that a popup-triggered inject never drops what has been collected — which means a build that **renames or removes a key on it** would otherwise inherit the old shape and throw on first read. `STATE_VERSION` in `src/collector.js` guards that: bump it whenever that object's keys change, and an incompatible predecessor is replaced instead of reused.

Two things a bumped `STATE_VERSION` cannot fix in an already-open tab, both resolved by refreshing it once:

- The superseded build's scroll listeners were bound to anonymous functions and cannot be unbound, so it keeps harvesting alongside the new one. Its observer and timers are torn down, and the saved-collection key is versioned so the two formats can't overwrite each other, but its wasted work continues until the page reloads.
- Its `chrome.storage` writes still land under the old key. That key is deleted on the next hydrate, so nothing accumulates.

Reloading the extension also detaches every content script already in a tab from the extension itself. `chrome.storage` still looks callable there, but each call throws `Extension context invalidated` — and because the collector persists from a `MutationObserver`, that fires on every change to the feed, which on Facebook is constantly. The collector detects this by checking `chrome.runtime.id` (the thing that actually disappears), then shuts itself down: observer disconnected, timers cleared, harvests and persists refused, `getStatus().stopped` set. Anything already collected stays readable, and re-injecting from the popup revives it.
