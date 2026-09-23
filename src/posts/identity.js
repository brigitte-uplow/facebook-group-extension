// Which post a unit is: its permalink, and the id the group knows it by.
//
// A feed unit does not always carry its own permalink — Comet renders the
// timestamp link only once the header is hovered — and the hrefs it does carry
// may belong to a commenter's paste rather than to the post. Ids are therefore
// taken from the page's own React state where it can be read, and otherwise
// from hrefs in tiers, strongest claim first. Loaded after src/posts/timestamp.js.
(() => {
  const { unique, cleanUrl } = globalThis.__fbGroupText;
  const { looksLikeTimestampCandidate, extractTimestampCandidates } = globalThis.__fbGroupTime;
  const { sleep } = globalThis.__fbGroupMotion;
  const {
    GROUP_POST_PATTERN,
    POST_ID_PATTERNS,
    ATTACHMENT_ID_FROM,
    BARE_POST_ID_PATTERN,
    OWN_ID_FROM,
    PAGE_ID_EVENT,
    UNIT_ATTRIBUTE,
    COMMENT_HREF_PATTERN,
    COMMENT_ID_PATTERN,
  } = globalThis.__fbGroupPatterns;
  const { postAnchors, isForeignGroupUrl } = globalThis.__fbGroupLinks;
  const { POINT_AT_EVENTS, POINT_AWAY_EVENTS, dispatchPointerEvents } = globalThis.__fbGroupDom;
  const { commentRoots, outsideComments } = globalThis.__fbGroupPostDetect;
  const { headerNodes, anchorTimestampLabels } = globalThis.__fbGroupPostTimestamp;

  function anchorLooksTimestamped(anchor) {
    return anchorTimestampLabels(anchor)
      .flatMap((label) => extractTimestampCandidates(label || ""))
      .some((label) => looksLikeTimestampCandidate(label));
  }

  function permalinkAnchor(element, roots = commentRoots(element)) {
    const anchors = outsideComments(postAnchors(element), roots);
    const preferred = (list) =>
      list.find(
        (anchor) => GROUP_POST_PATTERN.test(anchor.href) && !isForeignGroupUrl(anchor.href)
      ) ||
      list[0] ||
      null;
    return preferred(anchors.filter(anchorLooksTimestamped)) || preferred(anchors);
  }

  function getPermalink(element, roots = commentRoots(element)) {
    const anchor = permalinkAnchor(element, roots);
    return anchor ? cleanUrl(anchor.href) : null;
  }

  const MEDIA_HREF_PATTERN = /\/photo(?:\.php)?\/|[?&]fbid=|\/videos\/|\/reel\/|\/watch\//;

  async function revealPermalink(element, { timeoutMs = 600, pollMs = 100 } = {}) {
    const existing = getPermalink(element);
    if (existing) return existing;

    // Only the timestamp. The header lookup used to cover the whole article, so
    // this also hovered the photo link — Facebook opens that as the post, and
    // the walk then stops on a page it was only trying to read.
    const roots = commentRoots(element);
    const timestampAnchors = globalThis.__fbGroupPostTimestamp?.timestampAnchors;
    const targets = (timestampAnchors ? timestampAnchors(element, roots) : [])
      .filter((node) => node.isConnected)
      .filter((node) => {
        const href = node.getAttribute?.("href") || "";
        return !MEDIA_HREF_PATTERN.test(href) || anchorLooksTimestamped(node);
      });
    if (!targets.length) return null;

    for (const node of targets) dispatchPointerEvents(node, POINT_AT_EVENTS);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!element.isConnected) return null;
        const permalink = getPermalink(element);
        if (permalink) return permalink;
        if (Date.now() >= deadline) return null;
        await sleep(pollMs);
      }
    } finally {
      for (const node of targets) {
        if (node.isConnected) dispatchPointerEvents(node, POINT_AWAY_EVENTS);
      }
    }
  }

  function readStampedId(element) {
    if (element.dataset?.fbPostId) return element.dataset.fbPostId;
    const stamps = element.querySelectorAll?.("[data-fb-post-id]");
    return stamps?.length === 1 ? stamps[0].dataset.fbPostId : null;
  }

  function getPageStatePostId(element, permalink, roots) {
    try {
      element.setAttribute(UNIT_ATTRIBUTE, "");
      document.dispatchEvent(new CustomEvent(PAGE_ID_EVENT));
    } catch {
      // A page that would not take the event simply has no stamp to read.
    }

    const stamped = readStampedId(element);
    if (!stamped || !BARE_POST_ID_PATTERN.test(stamped)) return { id: null, mismatch: false };

    const anchors = Array.from(element.querySelectorAll("a[href]"));
    const isCommentPermalink = (anchor) =>
      COMMENT_HREF_PATTERN.test(anchor.getAttribute("href") || "");
    const owned = unique([
      permalink,
      ...anchors
        .filter((anchor) => !roots.some((root) => root.contains(anchor)) || isCommentPermalink(anchor))
        .map((anchor) => anchor.href),
    ])
      .filter(Boolean)
      .filter((href) => !isForeignGroupUrl(href));

    const commentIds = unique(
      anchors.flatMap((anchor) =>
        Array.from((anchor.getAttribute("href") || "").matchAll(COMMENT_ID_PATTERN), (match) => match[1])
      )
    );
    // A comment id is never a post id, whatever props it came out of.
    if (commentIds.includes(stamped)) return { id: null, mismatch: false };

    for (const pattern of POST_ID_PATTERNS.slice(0, OWN_ID_FROM)) {
      for (const href of owned) {
        const ownId = href.match(pattern)?.slice(1).find(Boolean);
        if (!ownId) continue;
        return ownId === stamped ? { id: stamped, mismatch: false } : { id: null, mismatch: true };
      }
    }

    // Nothing in the unit names the post — the text-only case this exists for.
    return { id: stamped, mismatch: false };
  }

  function pageStatePostId(element, roots = commentRoots(element)) {
    return getPageStatePostId(element, getPermalink(element, roots), roots);
  }

  function getExternalPostId(element, permalink, roots = commentRoots(element)) {
    const page = getPageStatePostId(element, permalink, roots);
    if (page.id) {
      return { id: page.id, attachment: false, borrowed: false, pageState: true, mismatch: false };
    }

    const anchors = Array.from(element.querySelectorAll("a[href]"));
    const inComment = (anchor) => roots.some((root) => root.contains(anchor));
    const isCommentPermalink = (anchor) =>
      COMMENT_HREF_PATTERN.test(anchor.getAttribute("href") || "");
    const hrefsOf = (predicate) => unique(anchors.filter(predicate).map((anchor) => anchor.href));

    // Weakest last: a link a commenter pasted has no claim on the post.
    const tiers = [
      unique([permalink]),
      hrefsOf((anchor) => inComment(anchor) && isCommentPermalink(anchor)),
      hrefsOf((anchor) => !inComment(anchor)),
      hrefsOf((anchor) => inComment(anchor) && !isCommentPermalink(anchor)),
    ].map((hrefs) => hrefs.filter((href) => !isForeignGroupUrl(href)));

    const first = (hrefs, pattern) => {
      for (const href of hrefs) {
        const match = href.match(pattern);
        if (match) {
          const id = match.slice(1).find(Boolean);
          if (id) return id;
        }
      }
      return null;
    };

    for (const [index, pattern] of POST_ID_PATTERNS.entries()) {
      for (const [tier, hrefs] of tiers.entries()) {
        const id = first(hrefs, pattern);
        if (!id) continue;
        return {
          id,
          attachment: index >= ATTACHMENT_ID_FROM,
          borrowed: tier >= 2,
          pageState: false,
          mismatch: page.mismatch,
        };
      }
    }

    return { id: null, attachment: false, borrowed: false, pageState: false, mismatch: page.mismatch };
  }

  globalThis.__fbGroupPostIdentity = Object.freeze({
    anchorLooksTimestamped,
    permalinkAnchor,
    getPermalink,
    revealPermalink,
    readStampedId,
    getPageStatePostId,
    pageStatePostId,
    getExternalPostId,
  });
})();
