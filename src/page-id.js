(() => {
  const VERSION = "0.9.2";
  if (globalThis.__fbGroupPageId?.version === VERSION) return;
  // A tagger from a superseded build still has its observer bound to the feed.
  globalThis.__fbGroupPageId?.stop?.();
  const POST_ID_PATTERN = /^(?:\d{8,}|pfbid[A-Za-z0-9]+)$/;
  const GROUP_URL_PATTERN = /\/groups\/([^/?#"]+)/g;
  const TAG_EVENT = "fbgs:tag-posts";
  const START_EVENT = "fbgs:start-tagger";
  const MARKED_SELECTOR = "[data-fbgs-unit]";
  const ARTICLE_SELECTOR = 'div[role="article"]';
  const UNIT_SELECTOR = `${MARKED_SELECTOR}, ${ARTICLE_SELECTOR}`;
  const FEED_SELECTOR = 'div[role="feed"]';
  const COMMENT_HREF_PATTERN = /comment_id=|\/comment\//;
  const SCAN_DEPTH = 7;
  const SCAN_NODES = 4000;
  const FIBER_HOPS = 12;
  const DESCENT_NODES = 30000;
  const DEBOUNCE_MS = 250;
  const ID_KEYS = [
    "post_id",
    "postID",
    "legacy_story_id",
    "story_fbid",
    "subscription_target_id",
    "ftid",
  ];
  const ID_KEY_RANK = new Map(ID_KEYS.map((key, index) => [key, index]));
  const FOREIGN_SEGMENTS = new Set([
    "attached_story",
    "attached_stories",
    "attachment",
    "attachments",
    "comment",
    "comments",
    "comment_parent",
    "nested_stories",
    "original_post",
    "parent_post",
    "parent_story",
    "shared_story",
    "share_story",
    "sub_stories",
    "target",
    "target_group",
  ]);

  const currentGroup = () => location.pathname.match(/\/groups\/([^/]+)/)?.[1] || null;

  const isForeignPath = (path) =>
    path.split(".").some((segment) => FOREIGN_SEGMENTS.has(segment));
  function scanProps(root) {
    const hits = [];
    const groups = new Set();
    const seen = new WeakSet();
    let budget = SCAN_NODES;

    const walk = (value, path, depth) => {
      if (budget <= 0 || depth > SCAN_DEPTH) return;
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      budget -= 1;

      for (const key of Object.keys(value)) {
        let child;
        // Props can carry accessors, and React's own internals throw on some.
        try {
          child = value[key];
        } catch {
          continue;
        }
        const next = path ? `${path}.${key}` : key;
        const foreign = isForeignPath(next);

        if (typeof child === "string" && !foreign) {
          for (const match of child.matchAll(GROUP_URL_PATTERN)) groups.add(match[1]);
        }
        if (!foreign && ID_KEY_RANK.has(key) && (typeof child === "string" || typeof child === "number")) {
          const id = String(child);
          if (POST_ID_PATTERN.test(id)) hits.push({ path: next, key, value: id, depth });
        }
        walk(child, next, depth + 1);
      }
    };

    walk(root, "", 0);
    return { hits, groups };
  }
  const byStrength = (a, b) =>
    ID_KEY_RANK.get(a.key) - ID_KEY_RANK.get(b.key) || a.depth - b.depth || a.path.length - b.path.length;
  function widerThanUnit(node, unit) {
    if (!node || node.nodeType !== 1 || node === unit) return false;
    for (const other of node.querySelectorAll(UNIT_SELECTOR)) {
      if (other !== unit && !unit.contains(other) && !other.contains(unit)) return true;
    }
    return false;
  }
  function fiberRoot() {
    for (let node = document.body; node; node = node.parentElement) {
      for (const key of Object.keys(node)) {
        if (key.startsWith("__reactContainer$")) return node[key];
      }
    }
    // The mount node is a child of body, not body itself, in some layouts.
    for (const node of document.body?.children || []) {
      for (const key of Object.keys(node)) {
        if (key.startsWith("__reactContainer$")) return node[key];
      }
    }
    return null;
  }
  function fiberByDescent(unit) {
    const root = fiberRoot();
    let fiber = root?.current || root?.stateNode?.current || null;
    if (!fiber) return null;

    let budget = DESCENT_NODES;
    const stack = [fiber];
    while (stack.length && budget > 0) {
      const current = stack.pop();
      budget -= 1;
      const host = current.stateNode;
      if (host && host.nodeType === 1) {
        if (host === unit) return current;
        if (!host.contains(unit)) continue;
      }
      for (let child = current.child; child; child = child.sibling) stack.push(child);
    }
    return null;
  }
  function propsChain(node) {
    const chain = [];
    const keys = Object.keys(node);

    const propsKey = keys.find((key) => key.startsWith("__reactProps$"));
    if (propsKey && node[propsKey]) chain.push(node[propsKey]);

    const fiberKey = keys.find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? node[fiberKey] : fiberByDescent(node);

    for (let hops = 0; fiber && hops < FIBER_HOPS; fiber = fiber.return, hops += 1) {
      if (hops && widerThanUnit(fiber.stateNode, node)) break;
      if (fiber.memoizedProps) chain.push(fiber.memoizedProps);
    }
    return chain;
  }
  function resolve(unit) {
    const group = currentGroup();

    for (const props of propsChain(unit)) {
      const { hits, groups } = scanProps(props);
      if (!hits.length) continue;

      hits.sort(byStrength);
      const best = hits[0];
      if (hits.some((hit) => hit.key === best.key && hit.value !== best.value)) return null;
      const comparable = group
        ? Array.from(groups).filter((named) => /^\d+$/.test(named) === /^\d+$/.test(group))
        : [];
      if (comparable.length && !comparable.includes(group)) return null;

      return { id: best.value, source: "react_props", path: best.path };
    }
    return null;
  }

  /* ------------------------------------------------- ids out of the network */
  const HEAD_LENGTH = 40;
  const HEAD_MINIMUM = 20;
  const MAX_HARVESTED = 600;
  const COLLECT_DEPTH = 48;
  const harvested = new Map();
  const reshared = new Map();
  const skeleton = (text) =>
    (text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  function keep(map, text, id) {
    const body = skeleton(text);
    if (body.length < HEAD_MINIMUM) return;
    const head = body.slice(0, HEAD_LENGTH);
    if (map.has(head)) return;
    // Oldest out first: a long session must not grow this without bound.
    if (map.size >= MAX_HARVESTED) map.delete(map.keys().next().value);
    map.set(head, { id, tail: body.slice(-HEAD_LENGTH) });
  }

  const remember = (text, id) => keep(harvested, text, id);
  const rememberShared = (text, id) => keep(reshared, text, id);
  const AMBIGUOUS_AUTHOR = Symbol("several");
  const unkeyable = new Map();

  function rememberAuthor(authorId, id) {
    if (!unkeyable.has(authorId)) {
      if (unkeyable.size >= MAX_HARVESTED) unkeyable.delete(unkeyable.keys().next().value);
      unkeyable.set(authorId, id);
      return;
    }
    const held = unkeyable.get(authorId);
    if (held !== id) unkeyable.set(authorId, AMBIGUOUS_AUTHOR);
  }

  const AUTHOR_HREF_PATTERN = /\/groups\/[^/]+\/user\/(\d+)|profile\.php\?id=(\d+)|\/user\/(\d+)/;
  function authorOf(unit) {
    for (const anchor of unit.querySelectorAll("a[href]")) {
      const match = (anchor.getAttribute("href") || "").match(AUTHOR_HREF_PATTERN);
      if (match) return match[1] || match[2] || match[3];
    }
    return null;
  }
  const THREAD_SEGMENTS = new Set(["comment", "comments", "comment_parent", "feedback", "top_level_comments"]);
  function firstText(value, depth) {
    if (!value || typeof value !== "object" || depth > 10) return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstText(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const own = value.message?.text ?? value.message_text ?? null;
    if (typeof own === "string" && skeleton(own).length >= HEAD_MINIMUM) return own;

    for (const key of Object.keys(value)) {
      if (THREAD_SEGMENTS.has(key)) continue;
      let child;
      try {
        child = value[key];
      } catch {
        continue;
      }
      if (child && typeof child === "object") {
        const found = firstText(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  function collect(value, storyId, depth, budget) {
    if (budget.left <= 0 || depth > COLLECT_DEPTH || !value || typeof value !== "object") return;
    budget.left -= 1;

    if (Array.isArray(value)) {
      for (const item of value) collect(item, storyId, depth + 1, budget);
      return;
    }

    let own = storyId;
    let named = false;
    for (const key of ID_KEYS) {
      const candidate = value[key];
      if (candidate === undefined || candidate === null) continue;
      if (POST_ID_PATTERN.test(String(candidate))) {
        own = String(candidate);
        named = true;
        break;
      }
    }

    const text = value.message?.text ?? value.message_text ?? null;
    if (own && typeof text === "string") remember(text, own);
    if (named && typeof text !== "string") {
      const embedded = firstText(value, 0);
      if (embedded) rememberShared(embedded, own);
    }
    if (named && skeleton(typeof text === "string" ? text : "").length < HEAD_MINIMUM) {
      const actors = Array.isArray(value.actors) ? value.actors : [];
      const actor = actors.find((candidate) => /^\d+$/.test(String(candidate?.id ?? "")));
      if (actor) rememberAuthor(String(actor.id), own);
    }

    for (const key of Object.keys(value)) {
      if (FOREIGN_SEGMENTS.has(key)) continue;
      const child = value[key];
      if (child && typeof child === "object") collect(child, own, depth + 1, budget);
    }
  }
  function harvest(body) {
    if (typeof body !== "string" || !body.includes("post_id")) return;
    for (const line of body.split("\n")) {
      if (!line.includes("post_id")) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      collect(parsed, null, 0, { left: 60000 });
    }
  }
  const readScripts = new WeakSet();
  let inlineRead = 0;

  function harvestInline() {
    for (const script of document.querySelectorAll("script")) {
      if (readScripts.has(script)) continue;
      readScripts.add(script);
      const body = script.textContent;
      if (!body || !body.includes("post_id")) continue;
      inlineRead += 1;
      harvest(body);
    }
  }
  // Reading a response must not cost the page its memory. Comet's GraphQL
  // replies are chunked and some stay open for the life of the tab, streaming
  // deferred fragments as they are ready. `clone()` tees the stream and the
  // browser holds every byte of both branches until the clone is consumed, so
  // the `.clone().text()` this used to do never resolved on those and the
  // buffer grew for as long as the tab was open — in every group tab at once,
  // which is enough on a small machine for Chrome to start discarding tabs.
  // A discarded tab reloads when it is looked at again, which is what sent a
  // run back to the top of the feed and reloaded its siblings with it.
  //
  // So the clone is drained as it arrives, line by line, and let go of: whole
  // lines are harvested and dropped rather than accumulated, and the read stops
  // at a byte budget or a deadline and cancels, which releases the tee.
  const MAX_HARVEST_BYTES = 8 * 1024 * 1024;
  const MAX_HARVEST_MS = 60000;

  async function harvestStream(response) {
    const reader = response.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    const deadline = Date.now() + MAX_HARVEST_MS;
    let pending = "";
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
        pending += decoder.decode(value, { stream: true });
        // Only whole lines can be parsed, so the tail waits and the rest goes.
        const lastBreak = pending.lastIndexOf("\n");
        if (lastBreak >= 0) {
          harvest(pending.slice(0, lastBreak));
          pending = pending.slice(lastBreak + 1);
        }
        if (bytes >= MAX_HARVEST_BYTES || Date.now() >= deadline) break;
      }
      if (pending) harvest(pending);
    } catch {
      // A read that broke off keeps whatever it had already harvested.
    } finally {
      // Always: an uncancelled clone is the leak this exists to avoid.
      reader.cancel().catch(() => {});
    }
  }

  // Wrapping fetch is the one thing here that touches the page's own plumbing,
  // and it runs at document_start before anything can be told not to. So the
  // off switch has to be something readable that early: set
  // `localStorage.fbgsNoIntercept = "1"` in the page's own console and reload,
  // and ids come only from React props and the inline blobs.
  function intercepting() {
    try {
      return localStorage.getItem("fbgsNoIntercept") !== "1";
    } catch {
      return true;
    }
  }

  function intercept() {
    if (!intercepting()) return;
    const isGraphql = (url) => url.includes("/api/graphql");

    const realFetch = globalThis.fetch;
    if (typeof realFetch === "function" && !realFetch.__fbgsWrapped) {
      const wrapped = function (...args) {
        const result = realFetch.apply(this, args);
        try {
          const url = String(args[0]?.url ?? args[0] ?? "");
          if (isGraphql(url) && result?.then) {
            result
              .then((response) => {
                if (response?.body) harvestStream(response.clone());
                return response;
              })
              .catch(() => {});
          }
        } catch {
          // The call itself is already on its way; only the read failed.
        }
        return result;
      };
      wrapped.__fbgsWrapped = true;
      globalThis.fetch = wrapped;
    }

    const { open, send } = XMLHttpRequest.prototype;
    if (!open.__fbgsWrapped) {
      const wrappedOpen = function (method, url, ...rest) {
        try {
          this.__fbgsUrl = String(url || "");
        } catch {
          // A frozen instance is not one we need to watch.
        }
        return open.call(this, method, url, ...rest);
      };
      wrappedOpen.__fbgsWrapped = true;
      XMLHttpRequest.prototype.open = wrappedOpen;

      const wrappedSend = function (...args) {
        try {
          if (isGraphql(this.__fbgsUrl || "")) {
            this.addEventListener("load", () => {
              try {
                const body = this.responseText;
                // The same budget the streamed read keeps to.
                if (body && body.length <= MAX_HARVEST_BYTES) harvest(body);
              } catch {
                // A binary or cross-origin response has no text to read.
              }
            });
          }
        } catch {
          // Fall through to the real send either way.
        }
        return send.apply(this, args);
      };
      wrappedSend.__fbgsWrapped = true;
      XMLHttpRequest.prototype.send = wrappedSend;
    }
  }
  const AMBIGUOUS = Symbol("ambiguous");

  function matchOn(map, body, read) {
    let found = null;
    for (const [head, entry] of map) {
      if (!body.includes(read(head, entry))) continue;
      if (found && found !== entry.id) return AMBIGUOUS;
      found = entry.id;
    }
    return found;
  }
  function matchIn(map, body) {
    const byHead = matchOn(map, body, (head) => head);
    if (byHead) return byHead;
    return matchOn(map, body, (_head, entry) => entry.tail);
  }

  function resolveFromNetwork(unit) {
    if (!harvested.size && !reshared.size && !unkeyable.size) return null;
    const body = skeleton(unit.innerText);

    if (body.length >= HEAD_MINIMUM) {
      const own = matchIn(harvested, body);
      if (own === AMBIGUOUS) return null;
      if (own) return { id: own, source: "graphql", path: "message.text" };

      const embedded = matchIn(reshared, body);
      if (embedded === AMBIGUOUS) return null;
      if (embedded) return { id: embedded, source: "graphql_reshare", path: "attached_story.message.text" };
    }

    const author = authorOf(unit);
    const only = author ? unkeyable.get(author) : null;
    if (!only || only === AMBIGUOUS_AUTHOR) return null;
    return { id: only, source: "graphql_author", path: "actors.id" };
  }

  /* --------------------------------------------------------------- stamping */
  const resolved = new WeakMap();
  const claims = new Map();

  function claimed(id, unit) {
    const holder = claims.get(id)?.deref?.();
    return Boolean(holder && holder !== unit && holder.isConnected);
  }

  function isHydrated(unit) {
    if (!unit || unit.nodeType !== 1) return false;
    return Object.keys(unit).some(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactProps$")
    );
  }

  function tagOne(unit) {
    if (unit.dataset.fbPostId) return unit.dataset.fbPostId;
    // A node React has not adopted yet has no fiber. Stamping it is the #418
    // that threw the server markup away and remounted every group tab with it.
    if (!isHydrated(unit)) return null;

    let found;
    if (resolved.has(unit)) {
      found = resolved.get(unit);
    } else {
      try {
        found = resolve(unit);
      } catch {
        found = null;
      }
      resolved.set(unit, found);
    }
    if (!found) {
      try {
        found = resolveFromNetwork(unit);
      } catch {
        found = null;
      }
      if (found) resolved.set(unit, found);
    }
    if (!found || claimed(found.id, unit)) return null;

    claims.set(found.id, new WeakRef(unit));
    unit.dataset.fbPostId = found.id;
    unit.dataset.fbPostIdSource = found.source;
    return found.id;
  }
  function isComment(node) {
    if (/^comment by/i.test(node.getAttribute("aria-label") || "")) return true;
    for (const anchor of node.querySelectorAll("a[href]")) {
      if (anchor.closest(ARTICLE_SELECTOR) !== node) continue;
      if (COMMENT_HREF_PATTERN.test(anchor.getAttribute("href") || "")) return true;
    }
    return false;
  }
  function units() {
    const marked = Array.from(document.querySelectorAll(MARKED_SELECTOR));
    if (marked.length) return marked;

    const root =
      document.querySelector(FEED_SELECTOR) || document.querySelector('div[role="main"]') || document;
    return Array.from(root.querySelectorAll(ARTICLE_SELECTOR)).filter(
      (unit) => !unit.parentElement?.closest(ARTICLE_SELECTOR) && !isComment(unit)
    );
  }

  let tagged = 0;
  let passes = 0;

  function tagAll() {
    passes += 1;
    let stamped = 0;
    try {
      harvestInline();
    } catch {
      // A blob that would not parse was never one of ours.
    }
    try {
      for (const unit of units()) {
        if (tagOne(unit)) stamped += 1;
      }
    } catch {
      // A pass that broke off still stamped whatever it got to.
    }
    tagged = stamped;
    return stamped;
  }

  /* -------------------------------------------------------------- triggering */

  let observer = null;
  let timer = null;
  let started = false;

  function tagSoon() {
    clearTimeout(timer);
    timer = setTimeout(tagAll, DEBOUNCE_MS);
  }

  function observe() {
    const feed = document.querySelector(FEED_SELECTOR) || document.querySelector('div[role="main"]');
    if (!feed) {
      timer = setTimeout(observe, 1500);
      return;
    }
    observer?.disconnect();
    observer = new MutationObserver(tagSoon);
    observer.observe(feed, { childList: true, subtree: true });
    tagAll();
  }

  // This file is not a content script. Putting it in MAIN at document_start
  // remounted every other group tab — even when start() itself did no work —
  // and each remounted sibling injected it again, which is the "3 times"
  // cascade. The popup injects it into the tab being started, and start()
  // still waits for that run before wrapping fetch or stamping the DOM.
  function start() {
    if (started) {
      intercept();
      return;
    }
    started = true;
    intercept();
    try {
      harvestInline();
    } catch {
      // A blob that would not parse was never one of ours.
    }
    observe();
  }

  const onDemand = () => {
    tagAll();
  };
  document.addEventListener(TAG_EVENT, onDemand);
  document.addEventListener(START_EVENT, start);
  function stop() {
    observer?.disconnect();
    observer = null;
    started = false;
    clearTimeout(timer);
    document.removeEventListener(TAG_EVENT, onDemand);
    document.removeEventListener(START_EVENT, start);
  }

  globalThis.__fbGroupPageId = {
    version: VERSION,
    event: TAG_EVENT,
    startEvent: START_EVENT,
    start,
    tagAll,
    resolve,
    harvest,
    harvestInline,
    heads: () => [
      ...Array.from(harvested, ([head, entry]) => ({ head, id: entry.id, kind: "own" })),
      ...Array.from(reshared, ([head, entry]) => ({ head, id: entry.id, kind: "reshare" })),
      ...Array.from(unkeyable, ([author, id]) => ({
        head: `author:${author}`,
        id: id === AMBIGUOUS_AUTHOR ? null : id,
        kind: "unkeyable",
      })),
    ],
    skeleton,
    stop,
    stats: () => ({
      version: VERSION,
      passes,
      tagged,
      claims: claims.size,
      marked: document.querySelectorAll(MARKED_SELECTOR).length,
      stamped: document.querySelectorAll("[data-fb-post-id]").length,
      harvested: harvested.size,
      // Reshares, whose text is their embedded story's rather than their own.
      reshared: reshared.size,
      // Stories with no text a join could key on, held by author instead.
      unkeyable: unkeyable.size,
      inlineRead,
      fiberRoot: Boolean(fiberRoot()),
      intercepting: intercepting() && Boolean(globalThis.fetch?.__fbgsWrapped),
      started,
    }),
  };
})();
