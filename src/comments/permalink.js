// The worker tab's half: a whole thread, read on the post's own permalink.
//
// A permalink usually opens the post in a dialog, but not always — some routes
// render it into the main column instead — so the wait accepts either. The
// budget is longer than the feed's, because this tab exists only to finish the
// one thread the feed could not. Loaded after src/comments/capture.js.
(() => {
  const { findPostDialog, scrollPane } = globalThis.__fbGroupDom;
  const { isCommentArticle } = globalThis.__fbGroupPostDetect;
  const { getComments } = globalThis.__fbGroupCommentExtract;
  const { setCommentOrder } = globalThis.__fbGroupCommentOrder;
  const {
    expandComments,
    expandCommentText,
    renderedCommentCount,
  } = globalThis.__fbGroupCommentExpand;
  const {
    getCommentCount,
    threadTarget,
    threadBudgetSeconds,
    threadSettleMs,
  } = globalThis.__fbGroupCommentCapture;

  // The post as the dialog renders it: an article that is not a comment.
  function dialogPostArticle(dialog) {
    return (
      Array.from(dialog.querySelectorAll('div[role="article"]')).find(
        (node) => !isCommentArticle(node)
      ) || null
    );
  }

  const WORKER_MIN_THREAD_SECONDS = 12;

  function waitUntil(check, timeoutMs) {
    return new Promise((resolve) => {
      const first = check();
      if (first) return resolve(first);
      let settled = false;
      let observer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer?.disconnect();
        resolve(value);
      };
      const timer = setTimeout(() => finish(check()), timeoutMs);
      const root = document.body || document.documentElement;
      if (!root) return finish(null);
      observer = new MutationObserver(() => {
        const next = check();
        if (next) finish(next);
      });
      observer.observe(root, { childList: true, subtree: true });
    });
  }

  const threadScope = () =>
    findPostDialog() || document.querySelector('div[role="main"]') || document.body || null;

  // Dialog chrome without comments is not a thread. Hidden worker tabs often
  // paint the shell first and the comments seconds later; starting the walk on
  // the shell is how a post Facebook says has comments is read as empty.
  function threadShell() {
    if (findPostDialog()) return true;
    if (renderedCommentCount(document.body) > 0) return true;
    return null;
  }

  function commentsReady(scope) {
    const host = scope || threadScope();
    if (!host) return null;
    return renderedCommentCount(host) > 0 ? host : null;
  }

  // Grey bars Facebook paints while a dialog is still fetching. A loaded post
  // can still have one on a photo, so this only matters while the thread itself
  // has not appeared.
  const SKELETON_SELECTOR = [
    '[data-visualcompletion="loading-state"]',
    '[role="progressbar"]',
    '[aria-busy="true"]',
    '[aria-label="Loading" i]',
    '[aria-label="Loading..." i]',
  ].join(", ");

  function commentSkeleton(scope) {
    const host = scope || threadScope();
    if (!host) return false;
    return Boolean(host.querySelector(SKELETON_SELECTOR));
  }

  function readComments(scope, scrapedAt) {
    const host = scope || threadScope();
    if (!host) return [];
    const dialogNow = findPostDialog();
    return getComments(host, 0, scrapedAt, {
      exclude: dialogNow ? [dialogPostArticle(dialogNow)].filter(Boolean) : [],
    }).comments;
  }

  async function scrapePermalinkComments(options = {}) {
    const {
      target = 100,
      order = "newest",
      includeReplies = true,
      scrapedAt = new Date().toISOString(),
      expected = null,
      waitMs = 45000,
    } = options;

    const result = {
      comments: [],
      order: null,
      verified: null,
      orderReason: null,
      rendered: 0,
      clicks: 0,
      exhausted: false,
      reason: null,
      expected,
    };

    await waitUntil(threadShell, waitMs);

    let scope = threadScope();
    if (!scope) {
      result.reason = "permalink_unavailable";
      result.error = "permalink_unavailable";
      return result;
    }

    const tally = expected ?? getCommentCount(scope);
    result.expected = tally;
    if (tally === 0) {
      result.exhausted = true;
      result.reason = "no_comments";
      return result;
    }

    // Same loop the feed uses for "New posts": the dialog often paints with
    // none of the thread until Newest is clicked, so switch the chip before
    // walking. Re-select even when it already says Newest if still empty —
    // that refetch is what loads the messages.
    let sorted = { order: null, verified: false, reason: "control_not_found" };
    // One switch to Newest, then a single refetch if the thread is still a
    // shell. Repeating the menu five times was most of the wait between posts.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      scope = threadScope() || scope;
      const empty = tally > 0 && !commentsReady(scope);
      // The first pass is the chance to paint. Still on the skeleton after
      // that means the permalink stalled; another menu click will not fetch
      // it. The worker reloads this URL instead of spending the thread budget
      // on grey bars.
      if (attempt > 0 && empty && commentSkeleton(scope)) {
        result.reason = "dialog_skeleton";
        result.error = "dialog_skeleton";
        return result;
      }
      sorted = await setCommentOrder(scope, order, { force: empty });
      result.order = sorted.order;
      result.verified = sorted.verified;
      result.orderReason = sorted.reason;
      if (empty) {
        await waitUntil(() => commentsReady(threadScope()), attempt === 0 ? 2500 : 4000);
        scope = threadScope() || scope;
      }
      if (commentsReady(scope) || tally === 0) break;
    }

    scope = threadScope() || scope;
    if (tally > 0 && !commentsReady(scope) && commentSkeleton(scope)) {
      result.reason = "dialog_skeleton";
      result.error = "dialog_skeleton";
      return result;
    }

    const maxSeconds = Math.max(
      WORKER_MIN_THREAD_SECONDS,
      threadBudgetSeconds(tally, target)
    );
    const settleMs = threadSettleMs(tally, target);
    const walkTarget = threadTarget(tally, target);

    const outcome = await expandComments(scope, {
      target: walkTarget,
      // Already switched above; asking again would reopen the same menu.
      order: sorted.verified && commentsReady(scope) ? null : order,
      maxSeconds,
      settleMs,
      includeReplies,
      scrollHost: scrollPane(scope),
      expected: tally,
      topLevelOnly: true,
    });
    result.order = outcome.order || sorted.order;
    result.verified = outcome.verified ?? sorted.verified;
    result.orderReason = outcome.orderReason || sorted.reason;
    result.rendered = outcome.rendered;
    result.clicks = outcome.clicks;
    result.exhausted = outcome.exhausted;
    scope = threadScope() || scope;
    await expandCommentText(scope);
    result.comments = readComments(scope, scrapedAt);
    // The dialog's articles land before their text. A shell counts as rendered,
    // and getComments drops an article with no body, so a thread that is still
    // painting would be stored as empty. Wait out the same budget for a body.
    if (!result.comments.length && tally > 0 && outcome.rendered > 0) {
      const deadline = Date.now() + maxSeconds * 1000;
      while (!result.comments.length && Date.now() < deadline) {
        const left = deadline - Date.now();
        await waitUntil(() => {
          const host = threadScope();
          return host && readComments(host, scrapedAt).length ? host : null;
        }, Math.min(4000, left));
        scope = threadScope() || scope;
        await expandCommentText(scope);
        result.comments = readComments(scope, scrapedAt);
      }
    }
    // A post Facebook says has comments, read as having none, is a page that did
    // not render rather than a thread that is empty — a tab the desktop never
    // painted, or a permalink that answered with something other than the post.
    // Said as an error so the queue retries it and, if it fails again, the
    // capture carries `comments:worker_failed` instead of quietly claiming a post
    // with ninety comments has none.
    if (!result.comments.length && tally > 0) {
      result.error = "thread_did_not_render";
      result.exhausted = false;
    }
    return result;
  }

  globalThis.__fbGroupCommentPermalink = Object.freeze({
    dialogPostArticle,
    scrapePermalinkComments,
  });
})();
