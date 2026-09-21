// Which nodes on the page are posts, and which are the comments under them.
//
// Facebook renders posts, shared posts, and comments all as role="article", so
// a unit is identified by what it contains rather than by what it is: comment
// permalinks mark a comment, an embedded feed marks a container. Three
// strategies are pooled and the containers dropped, because no one of them
// holds on every layout. Loaded after src/posts/content.js.
(() => {
  const { readText, isChromeLine, firstLine } = globalThis.__fbGroupText;
  const { looksLikeTimestampCandidate } = globalThis.__fbGroupTime;
  const { COMMENT_HREF_PATTERN, TOMBSTONE_PATTERN } = globalThis.__fbGroupPatterns;
  const { postAnchors } = globalThis.__fbGroupLinks;
  const { findAuthorLink } = globalThis.__fbGroupPostContent;

  // A post opened as a dialog is one the feed already holds, so detection skips it.
  const inDialog = (node) => Boolean(node?.closest?.('div[role="dialog"]'));

  function isCommentArticle(node) {
    if (/^comment by/i.test(node.getAttribute("aria-label") || "")) return true;
    for (const anchor of node.querySelectorAll("a[href]")) {
      if (anchor.closest('[role="article"]') !== node) continue;
      if (COMMENT_HREF_PATTERN.test(anchor.getAttribute("href") || "")) return true;
    }
    return false;
  }

  const commentRoots = (element) =>
    Array.from(element.querySelectorAll('div[role="article"]')).filter(
      (node) => node !== element && isCommentArticle(node)
    );

  const nestedArticleRoots = (element) =>
    Array.from(element.querySelectorAll('div[role="article"]')).filter(
      (node) => node !== element
    );

  const timestampExcludeRoots = (element, roots) => {
    const nested = nestedArticleRoots(element);
    if (!roots?.length) return nested;
    const seen = new Set(roots);
    for (const node of nested) seen.add(node);
    return [...seen];
  };

  const outsideComments = (nodes, roots) =>
    roots.length ? nodes.filter((node) => !roots.some((root) => root.contains(node))) : nodes;

  function getFeed() {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector('div[role="main"]') ||
      document.body
    );
  }

  const isProse = (line) => /\s/.test(line);

  function isTombstone(element) {
    const text = readText(element);
    if (!TOMBSTONE_PATTERN.test(text)) return false;
    const authorName = firstLine(findAuthorLink(element));
    const rest = text
      .split("\n")
      .filter(
        (line) =>
          line &&
          line !== authorName &&
          isProse(line) &&
          !TOMBSTONE_PATTERN.test(line) &&
          !isChromeLine(line) &&
          !looksLikeTimestampCandidate(line)
      )
      .join(" ");
    return rest.trim().length < 40;
  }

  function looksLikePost(element) {
    if (!element || element.getAttribute("role") === "feed") return false;
    if (isCommentArticle(element)) return false;
    if (isTombstone(element)) return false;
    if (postAnchors(element).length) return true;
    const text = element.innerText || "";
    return text.trim().length > 40 && Boolean(findAuthorLink(element));
  }

  function climbToPostRoot(anchor, feed) {
    let node = anchor;
    let best = null;
    while (node && node !== feed && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      if (node.getAttribute?.("role") === "article") best = node;
      if (parent === feed) return node;
      if (!best && (node.innerText || "").trim().length > 60) best = node;
      node = parent;
    }
    return best;
  }

  function isFeedRegionArticle(node) {
    if (!node || node.getAttribute?.("role") !== "article") return false;
    if (node.querySelector('div[role="feed"]')) return true;
    const nestedPosts = Array.from(node.querySelectorAll('div[role="article"]')).filter(
      (article) =>
        article !== node &&
        !isCommentArticle(article) &&
        article.parentElement?.closest('div[role="article"]') === node
    );
    return nestedPosts.length >= 2;
  }

  function dropContainers(candidates) {
    const withoutEmbeds = candidates.filter((candidate) => {
      if (candidate.getAttribute?.("role") !== "article") return true;
      const shareParent = candidates.find(
        (other) =>
          other !== candidate &&
          other.getAttribute?.("role") === "article" &&
          other.contains(candidate) &&
          !isFeedRegionArticle(other)
      );
      return !shareParent;
    });

    return withoutEmbeds.filter(
      (candidate) =>
        !withoutEmbeds.some((other) => other !== candidate && candidate.contains(other))
    );
  }

  function detectPosts() {
    const feed = getFeed();
    const strategies = {};

    strategies.articles = Array.from(document.querySelectorAll('div[role="article"]')).filter(
      (node) => !isCommentArticle(node)
    );
    strategies.feedChildren = Array.from(feed.children).filter((node) => node.tagName === "DIV");
    strategies.permalinks = Array.from(
      new Set(postAnchors(feed).map((anchor) => climbToPostRoot(anchor, feed)))
    ).filter(Boolean);

    const pool = [
      ...strategies.articles,
      ...strategies.feedChildren,
      ...strategies.permalinks,
    ].filter((node) => looksLikePost(node) && !inDialog(node));
    const posts = dropContainers(Array.from(new Set(pool)));
    posts.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    return { posts, strategies, feed };
  }

  globalThis.__fbGroupPostDetect = Object.freeze({
    inDialog,
    isCommentArticle,
    commentRoots,
    nestedArticleRoots,
    timestampExcludeRoots,
    outsideComments,
    getFeed,
    isTombstone,
    looksLikePost,
    climbToPostRoot,
    isFeedRegionArticle,
    dropContainers,
    detectPosts,
  });
})();
