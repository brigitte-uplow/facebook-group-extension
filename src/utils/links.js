// What an href says: which group it belongs to, whose profile it is, and
// whether it points at a post at all.
//
// Every function here answers a question about a URL or an anchor and touches
// nothing else on the page, so the walkers can ask without knowing the shape of
// a Facebook route. Loaded after src/patterns.js.
(() => {
  const {
    POST_URL_PATTERN,
    PROFILE_URL_PATTERN,
    COMMENT_HREF_PATTERN,
    RESERVED_PATH_SEGMENTS,
  } = globalThis.__fbGroupPatterns;
  const { TIMESTAMP_HREF_PATTERN } = globalThis.__fbGroupTime;

  function postAnchors(scope) {
    return Array.from(scope.querySelectorAll("a[href]")).filter((anchor) =>
      POST_URL_PATTERN.test(anchor.getAttribute("href") || "")
    );
  }

  const groupSlug = (href) => {
    try {
      const url = new URL(href, location.origin);
      return (
        url.pathname.match(/\/groups\/([^/]+)/)?.[1] ||
        url.searchParams.get("idorvanity") ||
        url.searchParams.get("group_id") ||
        null
      );
    } catch {
      return null;
    }
  };

  function isForeignGroupUrl(href) {
    const here = groupSlug(location.href);
    const there = groupSlug(href);
    return Boolean(here && there && here !== there);
  }

  // The vanity slug where there is one, else the numeric profile id.
  function handleFromProfileUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const groupMember = url.pathname.match(/\/groups\/[^/]+\/user\/(\d+)/);
      if (groupMember) return groupMember[1];
      const segment = url.pathname.split("/").filter(Boolean)[0] || null;
      if (!segment) return null;
      if (RESERVED_PATH_SEGMENTS.has(segment.toLowerCase())) return url.searchParams.get("id");
      return decodeURIComponent(segment);
    } catch {
      return null;
    }
  }

  function isProfileOnlyLink(node) {
    const href = node.getAttribute?.("href") || "";
    if (!href) return false;
    return (
      PROFILE_URL_PATTERN.test(node.href) &&
      !POST_URL_PATTERN.test(href) &&
      !TIMESTAMP_HREF_PATTERN.test(href)
    );
  }

  function commentParentUrl(anchor) {
    if (!COMMENT_HREF_PATTERN.test(anchor?.getAttribute("href") || "")) return null;
    try {
      const url = new URL(anchor.href, location.origin);
      return `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  }

  globalThis.__fbGroupLinks = Object.freeze({
    postAnchors,
    groupSlug,
    isForeignGroupUrl,
    handleFromProfileUrl,
    isProfileOnlyLink,
    commentParentUrl,
  });
})();
