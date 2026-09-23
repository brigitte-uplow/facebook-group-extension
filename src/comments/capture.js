// A post's thread, taken inline in the feed, and the budget for taking it.
//
// Facebook's own tally is read before anything is clicked, so an empty thread
// is never opened and a long one can be given proportionate time: roughly a
// page of comments per four seconds, floored and capped. A thread the feed
// cannot finish is not retried here — it is handed to the worker tab, which
// opens the post's own permalink. Loaded after src/comments/expand.js.
(() => {
  const {
    firstNumber,
    countsFromButtons,
    ariaLabels,
    countLines,
    findCount,
  } = globalThis.__fbGroupMetrics;
  const { COMMENT_COUNT_PATTERN } = globalThis.__fbGroupPatterns;
  const { stripNoise } = globalThis.__fbGroupDom;
  const { commentRoots, outsideComments } = globalThis.__fbGroupPostDetect;
  const { getComments } = globalThis.__fbGroupCommentExtract;

  // Facebook's own tally, read before opening, so an empty thread never opens.
  function getCommentCount(element) {
    const roots = commentRoots(element);
    const labels = ariaLabels(
      outsideComments(Array.from(element.querySelectorAll("[aria-label]")), roots)
    );
    const scope = stripNoise(element);
    // The group feed writes no worded tally, only a number on the button.
    return firstNumber(
      findCount(countLines(labels, scope), COMMENT_COUNT_PATTERN),
      countsFromButtons(scope).comments
    );
  }

  const COMMENTS_PER_PAGE = 10;
  const SECONDS_PER_PAGE = 4;
  const MIN_THREAD_SECONDS = 8;
  const MAX_THREAD_SECONDS = 90;

  function threadTarget(expected, target) {
    const cap = target > 0 ? target : Infinity;
    const wanted = Math.min(expected ?? cap, cap);
    return Number.isFinite(wanted) ? wanted : 0;
  }

  const threadPages = (expected, target) =>
    Math.ceil((threadTarget(expected, target) || 100) / COMMENTS_PER_PAGE);

  function threadBudgetSeconds(expected, target) {
    const pages = threadPages(expected, target);
    return Math.min(MAX_THREAD_SECONDS, Math.max(MIN_THREAD_SECONDS, pages * SECONDS_PER_PAGE));
  }

  function threadSettleMs(expected, target) {
    const pages = threadPages(expected, target);
    if (pages <= 1) return 450;
    if (pages <= 3) return 800;
    return 1400;
  }

  async function captureThread(element, options = {}) {
    const {
      target = 100,
      order = "newest",
      includeReplies = true,
      scrapedAt = new Date().toISOString(),
    } = options;

    const result = {
      order: null,
      verified: null,
      orderReason: null,
      rendered: 0,
      clicks: 0,
      comments: [],
      exhausted: false,
      needsWorker: false,
      expected: getCommentCount(element),
      reason: null,
    };

    if (result.expected === 0) {
      result.exhausted = true;
      result.reason = "no_comments";
      return result;
    }

    const walkTarget = threadTarget(result.expected, target);

    if (!element.isConnected) {
      result.needsWorker = true;
      result.reason = "post_recycled";
      return result;
    }

    // Nothing inside a post is clicked here any more. Expanding a thread in the
    // feed meant clicking "View more comments" and the order chip inside a card
    // that Facebook wraps in the post's own permalink anchor — which either
    // navigated the tab to that permalink, or, once the navigation was blocked,
    // opened the post's dialog in place and stalled the walk behind it. Both
    // were the same click. The card is read exactly as it was rendered, and a
    // thread that needs more than that is the worker's, which opens the
    // permalink where clicking costs the feed nothing.
    result.comments = getComments(element, target, scrapedAt).comments;
    result.rendered = result.comments.length;
    result.exhausted = false;
    const enough =
      result.expected != null && result.expected > 0
        ? result.comments.length >= Math.min(walkTarget, result.expected)
        : result.exhausted;
    if (enough) {
      result.reason = "inline_feed";
      return result;
    }
    result.needsWorker = true;
    result.reason = "needs_worker";
    return result;
  }

  globalThis.__fbGroupCommentCapture = Object.freeze({
    getCommentCount,
    threadTarget,
    threadBudgetSeconds,
    threadSettleMs,
    captureThread,
  });
})();
