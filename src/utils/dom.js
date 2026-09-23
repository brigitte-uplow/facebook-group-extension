// The page plumbing every walker shares: finding controls by their label,
// clicking them without following a link, and reading the panes they open.
//
// Facebook ships randomized class names and portals its menus to the end of
// <body>, so controls are located by role and wording rather than by structure.
// Nothing here knows what a post or a comment is. Loaded after src/patterns.js.
(() => {
  const { normalizeWhitespace, firstLine } = globalThis.__fbGroupText;
  const { CLICKABLE_SELECTOR, MENU_SELECTOR } = globalThis.__fbGroupPatterns;

  function stripNoise(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('div[role="article"]').forEach((node) => {
      if (node !== clone) node.remove();
    });
    return clone;
  }

  // User text lives in nested `dir="auto"` blocks; only the leaves are the text.
  const textBlocks = (scope) =>
    Array.from(scope.querySelectorAll('div[dir="auto"], span[dir="auto"]')).filter(
      (block) => !block.querySelector('[dir="auto"]')
    );

  function findButtons(element, pattern) {
    return Array.from(element.querySelectorAll('[role="button"], [role="link"]')).filter(
      (button) => {
        // Tested apart: a "See more" whose aria-label is also "See more" used
        // to become "See more See more" and fail the exact-match pattern.
        const text = normalizeWhitespace(button.textContent || "");
        const aria = normalizeWhitespace(button.getAttribute("aria-label") || "");
        return pattern.test(text) || pattern.test(aria);
      }
    );
  }

  const trimLabel = (value) =>
    normalizeWhitespace(value)
      .split("\n")[0]
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[^\p{L}\p{N}]+$/u, "");

  const orderLabel = (element) => trimLabel(firstLine(element));
  const CLICKABLE_CLIMB = 6;

  function clickableFor(host) {
    let node = host;
    for (let step = 0; node && step <= CLICKABLE_CLIMB; step += 1) {
      if (node.matches?.(CLICKABLE_SELECTOR)) return node;
      node = node.parentElement;
    }
    return host;
  }

  function controlsLabelled(pattern) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const label = trimLabel(node.nodeValue);
      if (!label || !pattern.test(label)) continue;
      const host = node.parentElement;
      if (!host) continue;
      const control = clickableFor(host);
      if (found.some((hit) => hit.control === control)) continue;
      found.push({ control, host, label });
    }
    return found;
  }

  // The ordering menu is portalled to the end of <body>, not inside the post.
  function menuItemMatching(patterns) {
    const items = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"]'
      )
    );
    for (const pattern of patterns) {
      const hit = items.find((item) => {
        const label = orderLabel(item);
        if (pattern.test(label)) return true;
        return pattern.test(trimLabel(item.innerText || item.textContent || ""));
      });
      if (hit) return hit;
    }
    return null;
  }

  function closeMenus() {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
    );
  }

  const insideDialog = (node) => Boolean(node.closest('div[role="dialog"]'));
  const insideMenu = (node) => Boolean(node.closest(MENU_SELECTOR));

  // A control whose click would take the page somewhere else. An anchor is the
  // obvious shape, but Comet also renders navigating controls as a bare
  // `[role="link"]` with the destination held in a handler and no href to find,
  // and findButtons() matches those too. The nearest clickable is what decides:
  // a role="button" nested inside a link is the button, and still worth
  // clicking, or expanding a thread inside a linked card would be skipped.
  function navigatesAway(node) {
    if (node.closest?.("a[href]")?.getAttribute("href")) return true;
    const clickable = node.closest?.('[role="button"], [role="link"]');
    return clickable?.getAttribute?.("role") === "link";
  }

  /* ------------------------------------------- nothing here may leave the page */

  // The feed tab must never navigate, and a review cannot keep that true: each
  // release found another control that took it to a post's permalink, where the
  // home feed renders behind the group's id and a walk collects the wrong feed.
  // So rather than enumerate the controls, every synthetic click runs inside a
  // guard that makes navigation impossible and records what tried.
  //
  // The guard used to close a quarter of a second after each click, on the
  // theory that Comet routes on a microtask. It does not: resolving a route is
  // a network round trip, and the navigation lands seconds after the click that
  // asked for it, long after a trailing window has closed. A run that watched
  // its tab walk off to a permalink with nothing recorded is what proved it. So
  // for the length of a run the guard is simply held open.
  //
  // Held open, it cannot use "we are mid-click" to tell our navigation from the
  // reader's, so it uses intent instead: a trusted click or keypress in the last
  // couple of seconds means the person did it, and the route is let through.
  // Everything else during a run is ours and is dropped.
  const NAVIGATION_GUARD_TRAIL_MS = 250;
  const TRUSTED_INTENT_MS = 2000;
  const MAX_BLOCKED_RECORDS = 50;
  const blocked = [];
  // Controls proven to navigate, so a later round does not click them again.
  const knownNavigators = new WeakSet();
  let guardTimer = null;
  let releaseGuard = null;
  let guardHeld = false;
  let lastTrustedAt = 0;

  const recentlyAsked = () => Date.now() - lastTrustedAt < TRUSTED_INTENT_MS;

  function noteTrustedIntent(event) {
    if (event.isTrusted) lastTrustedAt = Date.now();
  }

  function noteBlocked(kind, detail) {
    blocked.push({ kind, detail: detail ?? null, at: new Date().toISOString() });
    if (blocked.length > MAX_BLOCKED_RECORDS) blocked.shift();
  }

  // A path change is what leaves the feed. Query and hash rewrites are how
  // Facebook records a filter or a scroll position, and blocking those would
  // break the page for no gain.
  function leavesPage(url) {
    if (!url) return false;
    try {
      return new URL(url, location.href).pathname !== location.pathname;
    } catch {
      return false;
    }
  }

  function blockUntrustedNavigation(event) {
    if (event.isTrusted) return;
    const anchor = event.target?.closest?.("a[href]");
    const href = anchor?.getAttribute("href");
    if (!href || !leavesPage(href)) return;
    // preventDefault only: stopping propagation would also stop the React
    // handler that expands the caption, which is what the click was for.
    event.preventDefault();
    noteBlocked("anchor", href);
    if (anchor) knownNavigators.add(anchor);
  }

  // Set `__fbGroupRouteTrap = false` from the console to leave Comet's router
  // alone and keep only the href stripping. Dropping a pushState the router
  // believed had happened is the one part of this that could make Facebook
  // reach for a full page load instead, so it has to be switchable without a
  // rebuild while that is being told apart from the tab-reloading Facebook
  // does on its own.
  const trapRoutes = () => globalThis.__fbGroupRouteTrap !== false;

  function installGuard() {
    if (releaseGuard) return;
    const { history } = window;
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    const routeTrap = (kind, original) =>
      function guarded(state, title, url) {
        if (leavesPage(url) && !recentlyAsked()) {
          noteBlocked(kind, String(url));
          if (trapRoutes()) return undefined;
        }
        return original.call(history, state, title, url);
      };
    history.pushState = routeTrap("pushState", pushState);
    history.replaceState = routeTrap("replaceState", replaceState);

    // A route Comet cannot resolve becomes a full page load instead, which is
    // the other half of how the tab left the feed — and a reload is worse than
    // a route change, because it takes the walk back to the top.
    // In a browser these live on Location.prototype and can be replaced. Where
    // they are own, unwritable properties — jsdom, and any engine that locks
    // them down — the assignment is refused and the route trap above carries
    // the weight on its own.
    const proto = Object.getPrototypeOf(location);
    const assign = proto.assign;
    const replace = proto.replace;
    const loadTrap = (kind, original) =>
      function guarded(url) {
        if (leavesPage(url) && !recentlyAsked()) {
          noteBlocked(kind, String(url));
          if (trapRoutes()) return undefined;
        }
        return original.call(location, url);
      };
    let restoreLoads = () => {};
    try {
      if (typeof assign === "function") proto.assign = loadTrap("assign", assign);
      if (typeof replace === "function") proto.replace = loadTrap("replace", replace);
      restoreLoads = () => {
        if (typeof assign === "function") proto.assign = assign;
        if (typeof replace === "function") proto.replace = replace;
      };
    } catch {
      // Locked down; nothing to restore either.
    }

    // The layer above both of those. Comet routes through Chrome's Navigation
    // API, which does not call pushState and so is invisible to the trap above
    // — a run that walked off to a permalink with nothing recorded is what said
    // so. The navigate event covers every same-document navigation whatever
    // started it, and carries `userInitiated`, which is a better answer to "was
    // this the reader?" than anything inferred from timing.
    const nav = globalThis.navigation;
    let releaseNav = () => {};
    if (typeof nav?.addEventListener === "function") {
      const onNavigate = (event) => {
        if (event.userInitiated || recentlyAsked()) return;
        const url = event.destination?.url;
        if (!leavesPage(url)) return;
        noteBlocked("navigate", String(url));
        if (trapRoutes() && event.cancelable) event.preventDefault();
      };
      nav.addEventListener("navigate", onNavigate);
      releaseNav = () => nav.removeEventListener("navigate", onNavigate);
    }

    window.addEventListener("click", blockUntrustedNavigation, true);
    for (const type of ["click", "keydown", "auxclick"]) {
      window.addEventListener(type, noteTrustedIntent, true);
    }

    releaseGuard = () => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      restoreLoads();
      releaseNav();
      window.removeEventListener("click", blockUntrustedNavigation, true);
      for (const type of ["click", "keydown", "auxclick"]) {
        window.removeEventListener(type, noteTrustedIntent, true);
      }
    };
  }

  function dropGuard() {
    const release = releaseGuard;
    releaseGuard = null;
    release?.();
  }

  // Held for the length of a run; outside one, each click still gets its own
  // short window so a one-off expansion is covered too.
  function holdNavigationGuard(on) {
    guardHeld = Boolean(on);
    if (guardHeld) {
      clearTimeout(guardTimer);
      guardTimer = null;
      installGuard();
    } else if (!guardTimer) {
      dropGuard();
    }
  }

  function openNavigationGuard() {
    installGuard();
    if (guardHeld) return;
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      guardTimer = null;
      if (!guardHeld) dropGuard();
    }, NAVIGATION_GUARD_TRAIL_MS);
  }

  const blockedNavigations = () => blocked.slice();
  const attemptsNavigation = (node) => Boolean(node && knownNavigators.has(node));

  // Every anchor above the node, not just the nearest: Facebook nests them, and
  // an outer one still carries the destination once the inner is stripped.
  function ancestorAnchors(node) {
    const anchors = [];
    for (
      let anchor = node?.closest?.("a[href]");
      anchor;
      anchor = anchor.parentElement?.closest?.("a[href]") || null
    ) {
      anchors.push(anchor);
    }
    return anchors;
  }

  // Facebook's router reads the href off the anchor rather than relying on the
  // browser following it, so preventDefault on its own still leaves the page.
  // The href is taken off for the length of the click and put back after.
  function clickWithoutNavigating(node) {
    const anchors = ancestorAnchors(node);
    const hrefs = anchors.map((anchor) => anchor.getAttribute("href"));
    const block = (event) => event.preventDefault();
    const before = blocked.length;

    openNavigationGuard();
    for (const anchor of anchors) {
      anchor.addEventListener("click", block, true);
      anchor.removeAttribute("href");
    }
    try {
      node.click();
    } finally {
      anchors.forEach((anchor, index) => {
        anchor.removeEventListener("click", block, true);
        if (hrefs[index] !== null && !anchor.hasAttribute("href")) {
          anchor.setAttribute("href", hrefs[index]);
        }
      });
    }
    // Anything the guard caught while this click ran belongs to this control.
    if (blocked.length > before) knownNavigators.add(node);
  }

  function findPostDialog() {
    return (
      Array.from(document.querySelectorAll('div[role="dialog"]')).find((dialog) =>
        dialog.querySelector('div[role="article"], [aria-label*="comment" i]')
      ) || null
    );
  }

  function scrollPane(root) {
    let best = null;
    for (const node of [root, ...root.querySelectorAll("div")]) {
      if (node.scrollHeight <= node.clientHeight + 40) continue;
      if (!best || node.scrollHeight > best.scrollHeight) best = node;
    }
    return best;
  }

  function scrollToBottom(host) {
    if (!host) return;
    host.scrollTop = host.scrollHeight;
    host.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  const POINT_AT_EVENTS = ["pointerover", "pointerenter", "mouseover", "mouseenter"];
  const POINT_AWAY_EVENTS = ["pointerout", "pointerleave", "mouseout", "mouseleave"];

  function dispatchPointerEvents(node, types) {
    for (const type of types) {
      // The `enter`/`leave` pair does not bubble; React listens for all four.
      node.dispatchEvent(new MouseEvent(type, { bubbles: !/(enter|leave)$/.test(type) }));
    }
  }

  globalThis.__fbGroupDom = Object.freeze({
    stripNoise,
    textBlocks,
    findButtons,
    trimLabel,
    orderLabel,
    clickableFor,
    controlsLabelled,
    menuItemMatching,
    closeMenus,
    insideDialog,
    insideMenu,
    navigatesAway,
    clickWithoutNavigating,
    holdNavigationGuard,
    blockedNavigations,
    attemptsNavigation,
    findPostDialog,
    scrollPane,
    scrollToBottom,
    POINT_AT_EVENTS,
    POINT_AWAY_EVENTS,
    dispatchPointerEvents,
  });
})();
