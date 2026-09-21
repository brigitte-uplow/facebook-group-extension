// Sorting the group's feed itself: New posts, Recent activity, Most relevant.
//
// Separate from comment ordering, which sorts one thread: this is the chip
// above the feed, and its wording varies by group type (a listings group says
// "New listings"). The hard part is telling it apart from the identically
// worded chips inside posts, so candidates inside any post article, inside a
// detected post, or inside a dialog are ruled out. Loaded after
// src/posts/detect.js.
(() => {
  const { normalizeWhitespace } = globalThis.__fbGroupText;
  const { motion, randInt } = globalThis.__fbGroupMotion;
  const {
    FEED_ORDER_TRIGGER_PATTERN,
    FEED_ORDER_LABEL_PATTERN,
    FEED_ORDER_CHOICES,
    MENU_SELECTOR,
  } = globalThis.__fbGroupPatterns;
  const {
    orderLabel,
    controlsLabelled,
    menuItemMatching,
    closeMenus,
    insideDialog,
    insideMenu,
    findPostDialog,
    clickWithoutNavigating,
  } = globalThis.__fbGroupDom;
  const { detectPosts } = globalThis.__fbGroupPostDetect;

  function insidePostArticle(node) {
    let article = node.closest('div[role="article"]');
    while (article) {
      if (!article.querySelector('div[role="feed"]')) return true;
      article = article.parentElement?.closest('div[role="article"]') || null;
    }
    return false;
  }

  function outsidePosts(controls, { allowDialogs = false } = {}) {
    const posts = detectPosts().posts;
    return controls.filter(
      ({ control }) =>
        !insidePostArticle(control) &&
        !posts.some((post) => post.contains(control)) &&
        (allowDialogs || !insideDialog(control))
    );
  }

  function findFeedOrderControl() {
    const labelled = outsidePosts(controlsLabelled(FEED_ORDER_TRIGGER_PATTERN)).find(
      ({ control }) => !insideMenu(control)
    );
    if (labelled) return labelled;
    const described = Array.from(
      document.querySelectorAll('[role="button"], [role="combobox"]')
    ).find(
      (node) =>
        FEED_ORDER_LABEL_PATTERN.test(normalizeWhitespace(node.getAttribute("aria-label"))) &&
        !insideDialog(node)
    );
    return described ? { control: described, label: orderLabel(described) } : null;
  }

  const findFeedOrderTrigger = () => findFeedOrderControl()?.control || null;

  function findFeedOrderItem(choices, trigger) {
    const byRole = menuItemMatching(choices);
    if (byRole) return byRole;
    for (const pattern of choices) {
      const hit = outsidePosts(controlsLabelled(pattern), { allowDialogs: true }).find(
        ({ control }) => control !== trigger && !trigger.contains(control)
      );
      if (hit) return hit.control;
    }
    return null;
  }

  async function setFeedOrder(order = "new") {
    const choices = FEED_ORDER_CHOICES[order];
    if (!choices) return { order: null, changed: false, reason: "unknown_order" };
    if (document.querySelector(MENU_SELECTOR) || findPostDialog()) {
      return { order: null, changed: false, reason: "page_busy" };
    }

    const found = findFeedOrderControl();
    if (!found) return { order: null, changed: false, reason: "control_not_found" };

    const { control: trigger, label: current } = found;
    if (choices.some((pattern) => pattern.test(current))) {
      return { order: current, changed: false, reason: "already_set" };
    }

    clickWithoutNavigating(trigger);
    await motion.sleep(randInt(450, 900));
    const item = findFeedOrderItem(choices, trigger);
    if (!item) {
      closeMenus();
      return { order: current, changed: false, reason: "menu_item_not_found" };
    }

    const chosen = orderLabel(item);
    clickWithoutNavigating(item);
    await motion.sleep(randInt(2000, 3500));
    return { order: chosen, changed: true, reason: null };
  }

  globalThis.__fbGroupFeedOrder = Object.freeze({
    insidePostArticle,
    outsidePosts,
    findFeedOrderControl,
    findFeedOrderTrigger,
    findFeedOrderItem,
    setFeedOrder,
  });
})();
