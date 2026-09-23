// Getting a thread to render: clicking "View more comments", "View 4 replies",
// the hidden-comment notices, and every "See more" that truncates a body.
//
// Comments arrive over the network, so each round polls for new ones rather
// than sleeping a fixed time, and stops once three rounds in a row add nothing.
// Clicking an expander can re-render its neighbours out of the document, and
// some expanders are wrapped in anchors that would navigate away, so each click
// is checked and defanged first. Loaded after src/comments/order.js.
(() => {
  const { sleep } = globalThis.__fbGroupMotion;
  const {
    SEE_MORE_PATTERN,
    MORE_COMMENTS_PATTERN,
    MORE_REPLIES_PATTERN,
    HIDDEN_COMMENTS_PATTERN,
  } = globalThis.__fbGroupPatterns;
  const {
    findButtons,
    navigatesAway,
    attemptsNavigation,
    clickWithoutNavigating,
    scrollToBottom,
  } = globalThis.__fbGroupDom;
  const { commentRoots } = globalThis.__fbGroupPostDetect;
  const { setCommentOrder } = globalThis.__fbGroupCommentOrder;

  const MAX_SEE_MORE_ROUNDS = 3;
  const SEE_MORE_SETTLE_MS = 250;
  // Two silent rounds, not three. A round that answers is seen the moment it
  // does, so a round that does not is real evidence rather than a slow poll.
  const STAGNANT_ROUNDS_TO_STOP = 2;
  const MIN_SETTLE_MS = 350;

  async function expandCommentText(scope) {
    let clicks = 0;
    for (let round = 0; round < MAX_SEE_MORE_ROUNDS; round += 1) {
      const buttons = findButtons(scope, SEE_MORE_PATTERN);
      if (!buttons.length) break;
      for (const button of buttons) {
        // Expanding one comment re-renders its neighbours out of the document.
        if (!button.isConnected) continue;
        if (attemptsNavigation(button)) continue;
        clickWithoutNavigating(button);
        clicks += 1;
      }
      await sleep(SEE_MORE_SETTLE_MS);
    }
    return clicks;
  }

  function commentExpanders(element, includeReplies) {
    const top = findButtons(element, MORE_COMMENTS_PATTERN);
    const hidden = findButtons(element, HIDDEN_COMMENTS_PATTERN).filter(
      (button) => !top.includes(button)
    );
    if (!includeReplies) return [...top, ...hidden];
    const replies = findButtons(element, MORE_REPLIES_PATTERN).filter(
      (button) => !top.includes(button) && !hidden.includes(button)
    );
    return [...top, ...hidden, ...replies];
  }

  const renderedCommentCount = (element) => commentRoots(element).length;

  const topLevelCommentRoots = (element) => {
    const roots = commentRoots(element);
    return roots.filter((node) => !roots.some((other) => other !== node && other.contains(node)));
  };

  const articleCount = (element) => element.querySelectorAll('div[role="article"]').length;

  // Comments arrive over the network, so each round waits for the thread to
  // grow rather than sleeping a fixed time.
  //
  // Watched rather than polled, because the tab this runs in is hidden: Chrome
  // clamps setTimeout in a hidden page to roughly a second, so the old 250ms
  // poll cost four times what it asked for and every round paid that on top of
  // the wait itself. A MutationObserver is not clamped, so growth is seen when
  // it happens. Counting the thread is a subtree query, so it is done only once
  // the far cheaper tally of article nodes has moved.
  function waitForComments(element, from, timeoutMs, count) {
    const read = count || (() => renderedCommentCount(element));
    return new Promise((resolve) => {
      const first = read();
      if (first > from) return resolve(first);

      let articles = articleCount(element);
      let observer = null;
      const finish = (value) => {
        clearTimeout(timer);
        observer?.disconnect();
        resolve(value);
      };
      const timer = setTimeout(() => finish(read()), timeoutMs);

      observer = new MutationObserver(() => {
        const nodes = articleCount(element);
        if (nodes <= articles) return;
        articles = nodes;
        const rendered = read();
        if (rendered > from) finish(rendered);
      });
      observer.observe(element, { childList: true, subtree: true });
    });
  }

  async function expandComments(element, options = {}) {
    const {
      rounds = 40,
      target = 0,
      includeReplies = true,
      maxSeconds = 45,
      settleMs = 2500,
      order = "newest",
      clicksPerRound = 6,
      scrollHost = null,
      expected = null,
      topLevelOnly = false,
    } = typeof options === "number" ? { rounds: options } : options;

    const cap = target > 0 ? target : Infinity;
    const count = topLevelOnly
      ? () => topLevelCommentRoots(element).length
      : () => renderedCommentCount(element);
    let rendered = count();
    const result = {
      order: null,
      verified: null,
      orderReason: null,
      clicks: 0,
      rendered,
      exhausted: false,
    };
    if (rounds <= 0) return result;
    // Always Newest (or the asked order) before anything is read. A thread
    // that already shows Facebook's full count is still in "Most relevant"
    // until this click, and those comments are the wrong ones to store.
    if (order) {
      const sorted = await setCommentOrder(element, order, {
        force: expected > 0 && rendered === 0,
      });
      result.order = sorted.order;
      result.verified = sorted.verified;
      result.orderReason = sorted.reason;
      rendered = count();
      // Newest is what fetches the thread. Give that round trip a beat
      // before deciding there is nothing to expand.
      if (rendered === 0) {
        rendered = await waitForComments(element, 0, settleMs, count);
      }
      result.rendered = rendered;
    }

    if (rendered >= cap) return result;

    const deadline = Date.now() + maxSeconds * 1000;
    let stagnantRounds = 0;
    // What the thread has actually taken to answer, which is worth more than the
    // budget guessed for it: a round that waits the full settle after the
    // network has already gone quiet is the walk's largest idle cost, and there
    // are two of them at the end of every thread. The first answers set the
    // ceiling for the rest, with generous headroom and the guess as the cap.
    let slowestAnswerMs = 0;
    const waitBudget = () =>
      slowestAnswerMs ? Math.min(settleMs, Math.max(MIN_SETTLE_MS, slowestAnswerMs * 2)) : settleMs;

    while (
      result.clicks < rounds &&
      rendered < cap &&
      Date.now() < deadline &&
      stagnantRounds < STAGNANT_ROUNDS_TO_STOP
    ) {
      const buttons = commentExpanders(element, includeReplies);
      if (!buttons.length && !scrollHost) {
        // A dialog with no expander yet is the shell, not an empty thread.
        // One settle used to end the walk here, before the comment budget,
        // which is how a permalink still painting its comments was read as none.
        const left = deadline - Date.now();
        if (rendered === 0 && expected > 0 && left > 0) {
          rendered = await waitForComments(element, 0, Math.min(waitBudget(), left), count);
          if (rendered > 0) {
            stagnantRounds = 0;
            continue;
          }
          if (deadline - Date.now() > 50) continue;
        }
        result.exhausted = true;
        break;
      }

      // Top-level expanders come first and replies last, so a thread only
      // spends clicks on replies once there is no more of it left to open.
      // Replies are still collected; they just never crowd out the comments the
      // target is counted in.
      for (const button of buttons.slice(0, clicksPerRound)) {
        // Clicking one expander can re-render the others out of the document.
        if (!button.isConnected) continue;
        if (navigatesAway(button) || attemptsNavigation(button)) continue;
        clickWithoutNavigating(button);
        result.clicks += 1;
      }
      if (scrollHost) scrollToBottom(scrollHost);

      const before = rendered;
      const askedAt = Date.now();
      rendered = await waitForComments(element, before, waitBudget(), count);
      if (rendered > before) {
        slowestAnswerMs = Math.max(slowestAnswerMs, Date.now() - askedAt);
        stagnantRounds = 0;
      } else {
        stagnantRounds += 1;
      }
      // Nothing left to click and scrolling stopped producing comments.
      if (!buttons.length && stagnantRounds >= STAGNANT_ROUNDS_TO_STOP) result.exhausted = true;
    }

    result.rendered = rendered;
    return result;
  }

  globalThis.__fbGroupCommentExpand = Object.freeze({
    expandCommentText,
    commentExpanders,
    renderedCommentCount,
    topLevelCommentRoots,
    waitForComments,
    expandComments,
  });
})();
