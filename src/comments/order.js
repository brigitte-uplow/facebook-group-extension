// Putting a comment thread into a known order: Newest, All Comments, or Most
// relevant.
//
// "Most relevant" hides comments, so a thread is re-sorted before it is walked.
// The chip that opens the menu is a text node rather than a labelled control,
// and the menu itself is portalled to the end of <body>, so the choice is found
// by wording. Facebook does not always acknowledge the click, so the outcome is
// verified two ways — the chip's new label, and the thread re-rendering
// underneath — and retried. Loaded after src/posts/detect.js.
(() => {
  const { normalizeWhitespace } = globalThis.__fbGroupText;
  const { motion, randInt } = globalThis.__fbGroupMotion;
  const { sleep } = motion;
  const {
    COMMENT_ORDER_TRIGGER_PATTERN,
    COMMENT_ORDER_LABEL_PATTERN,
    COMMENT_ORDER_ARIA_PATTERN,
    COMMENT_ORDER_CHOICES,
  } = globalThis.__fbGroupPatterns;
  const {
    orderLabel,
    trimLabel,
    controlsLabelled,
    menuItemMatching,
    closeMenus,
    clickWithoutNavigating,
    dispatchPointerEvents,
    POINT_AT_EVENTS,
    findPostDialog,
    insideDialog,
  } = globalThis.__fbGroupDom;
  const { commentRoots } = globalThis.__fbGroupPostDetect;

  // The collapsed chip is often a combobox/listbox. MENU_SELECTOR includes
  // those roles, so treating "inside a listbox" as "this is a menu item" skips
  // the only control that can open Newest.
  const insideOrderMenu = (node) =>
    Boolean(
      node?.closest?.(
        '[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'
      )
    );

  function inScope(scope, node) {
    if (!scope || !node) return false;
    return scope === node || scope.contains(node);
  }

  function liveScope(element) {
    if (element?.isConnected) return element;
    return (
      findPostDialog() ||
      globalThis.__fbGroupPostDetect.photoCommentColumn?.() ||
      document.querySelector('div[role="main"]') ||
      document.body
    );
  }

  // Same idea as the feed-order helper: a nested article that contains a feed
  // is the column, not a post. The comment chip lives inside a real post.
  function insidePostArticle(node) {
    let article = node?.closest?.('div[role="article"]');
    while (article) {
      if (!article.querySelector('div[role="feed"]')) return true;
      article = article.parentElement?.closest('div[role="article"]') || null;
    }
    return false;
  }

  // The feed chip is "Most relevant" too. It sits on the page, outside posts
  // and outside the permalink dialog; clicking it would remount the group
  // instead of fetching this thread. On a photo page the same words label the
  // thread, in the column beside the picture.
  function isFeedOrderChip(node) {
    if (!node || insideDialog(node) || insidePostArticle(node)) return false;
    const column = globalThis.__fbGroupPostDetect.photoCommentColumn?.();
    return !column || !column.contains(node);
  }

  // controlsLabelled climbs to the nearest clickable, which inside a post is
  // often the permalink <a> wrapping the whole card. Clicking that opens the
  // dialog (or navigates) and never touches Newest — which is why the feed
  // sort works (that chip is not inside a post) and the worker's did not.
  function orderClickableFor(host) {
    let node = host;
    for (let step = 0; node && step <= 6; step += 1) {
      if (
        node.matches?.(
          '[role="button"], [role="combobox"], [role="listbox"], [aria-haspopup]'
        )
      ) {
        return node;
      }
      if (node.matches?.('a[href], [role="link"]')) return null;
      node = node.parentElement;
    }
    return null;
  }

  function namesOrder(text) {
    const label = normalizeWhitespace(text);
    if (!label) return false;
    return (
      COMMENT_ORDER_TRIGGER_PATTERN.test(label) ||
      COMMENT_ORDER_LABEL_PATTERN.test(label) ||
      COMMENT_ORDER_ARIA_PATTERN.test(label)
    );
  }

  function rankOrderHits(hits, scope) {
    const usable = hits.filter(
      ({ control }) => control && !insideOrderMenu(control) && !isFeedOrderChip(control)
    );
    return (
      usable.find(({ host, control }) => inScope(scope, host) || inScope(scope, control)) ||
      usable.find(({ control }) => insideDialog(control)) ||
      usable.find(({ control }) => insidePostArticle(control)) ||
      null
    );
  }

  function findCommentOrderControl(scope) {
    const live = liveScope(scope);
    const labelled = controlsLabelled(COMMENT_ORDER_TRIGGER_PATTERN)
      .map(({ host, label }) => ({
        host,
        label,
        control: orderClickableFor(host),
      }))
      .filter(({ control }) => control);
    const fromText = rankOrderHits(labelled, live);
    if (fromText) return fromText;

    const described = Array.from(
      document.querySelectorAll('[role="button"], [role="combobox"], [aria-haspopup]')
    )
      .filter((node) => !insideOrderMenu(node) && !isFeedOrderChip(node))
      .map((node) => {
        const aria = node.getAttribute("aria-label") || "";
        const visible = orderLabel(node);
        return { control: node, host: node, label: visible || trimLabel(aria), aria, visible };
      })
      .filter(({ aria, visible }) => namesOrder(visible) || namesOrder(aria));
    return rankOrderHits(described, live);
  }

  function findCommentOrderItem(choices, trigger) {
    const byRole = menuItemMatching(choices);
    if (byRole) return byRole;
    for (const pattern of choices) {
      const hits = controlsLabelled(pattern).filter(
        ({ control }) => control !== trigger && !trigger.contains(control)
      );
      const inMenu = hits.find(({ control }) => insideOrderMenu(control));
      if (inMenu) return inMenu.control;
      const clickable = hits
        .map(({ host, control }) => orderClickableFor(host) || control)
        .find((node) => node && node !== trigger);
      if (clickable) return clickable;
    }
    return null;
  }

  const ORDER_CONTROL_WAIT_MS = 5000;
  const ORDER_VERIFY_MS = 3500;
  const ORDER_REFETCH_MS = 1200;
  const ORDER_POLL_MS = 150;
  const ORDER_RETRIES = 2;

  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const first = check();
      if (first) return resolve(first);
      let observer = null;
      const finish = (value) => {
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

  const orderSnapshot = (element) => {
    const roots = commentRoots(element);
    return { first: roots[0] || null, count: roots.length };
  };

  // Whether the chip (or the menu item it opened) now says the order was taken.
  function orderApplied(element, choices, item) {
    if (item?.getAttribute?.("aria-checked") === "true") return true;
    if (item?.getAttribute?.("aria-selected") === "true") return true;
    const found = findCommentOrderControl(element);
    return Boolean(found && choices.some((pattern) => pattern.test(found.label)));
  }

  function openOrderMenu(trigger, host) {
    dispatchPointerEvents(trigger, POINT_AT_EVENTS);
    clickWithoutNavigating(trigger);
    if (host && host !== trigger && host.isConnected) {
      dispatchPointerEvents(host, POINT_AT_EVENTS);
      if (orderClickableFor(host) === trigger) return;
    }
  }

  async function setCommentOrder(element, order = "newest", options = {}) {
    const { force = false } = options;
    const choices = COMMENT_ORDER_CHOICES[order];
    if (!choices) return { order: null, verified: false, reason: "unknown_order" };

    const scopeOf = () => liveScope(element);
    let found = findCommentOrderControl(scopeOf());
    if (!found) {
      found = await waitFor(() => findCommentOrderControl(scopeOf()), ORDER_CONTROL_WAIT_MS);
    }
    if (!found) return { order: null, verified: false, reason: "control_not_found" };

    const already = choices.some((pattern) => pattern.test(found.label));
    // Already in the order asked for. Nothing to click — unless the dialog
    // painted none of the thread, in which case re-selecting Newest is what
    // actually fetches it (same refetch the feed chip does for New posts).
    if (already && !force) {
      return { order: found.label, verified: true, reason: null };
    }

    let chosen = null;
    let reason = "not_verified";
    let trigger = found.control;
    let host = found.host;

    for (let attempt = 0; attempt <= ORDER_RETRIES; attempt += 1) {
      found = findCommentOrderControl(scopeOf()) || found;
      trigger = found.control;
      host = found.host;
      const before = orderSnapshot(scopeOf());
      openOrderMenu(trigger, host);
      await sleep(randInt(180, 320));
      let item = findCommentOrderItem(choices, trigger);
      if (!item && host && host !== trigger && host.isConnected) {
        clickWithoutNavigating(host);
        await sleep(randInt(180, 320));
        item = findCommentOrderItem(choices, trigger);
      }
      if (!item) {
        closeMenus();
        reason = "choice_not_offered";
        await sleep(randInt(200, 400));
        continue;
      }
      chosen = orderLabel(item);
      dispatchPointerEvents(item, POINT_AT_EVENTS);
      clickWithoutNavigating(item);

      const deadline = Date.now() + ORDER_VERIFY_MS;
      let applied = false;
      let changed = false;
      let refetchUntil = Infinity;
      while (Date.now() < deadline && Date.now() < refetchUntil) {
        await sleep(ORDER_POLL_MS);
        const now = orderSnapshot(scopeOf());
        if (now.first !== before.first || now.count !== before.count) changed = true;
        if (!applied && orderApplied(scopeOf(), choices, item)) {
          applied = true;
          refetchUntil = Date.now() + ORDER_REFETCH_MS;
        }
        if (applied && changed) break;
      }

      if (applied || changed) {
        // Newest is a network round trip, same as switching the feed to New
        // posts: give Facebook a beat to paint the thread before the walker
        // decides the dialog is empty.
        if (!changed) await sleep(randInt(400, 700));
        return { order: chosen, verified: true, reason: null, refetched: changed };
      }
      reason = "not_verified";
      closeMenus();
      await sleep(randInt(200, 400));
    }

    return { order: chosen, verified: false, reason };
  }

  globalThis.__fbGroupCommentOrder = Object.freeze({
    findCommentOrderControl,
    findCommentOrderItem,
    setCommentOrder,
  });
})();
