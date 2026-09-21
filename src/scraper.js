// The scraper's public face: one rendered post parsed into a capture, the
// diagnostics that explain what a page looked like, and the __fbGroupScraper
// namespace the collector and the background worker drive it through.
//
// Nothing here walks the DOM on its own. Detection, identity, timestamps,
// media, metrics, comments, and feed ordering each live in their own half and
// publish a namespace; this file composes them and owns the shape of a capture.
// Loaded last of the scraper's halves, after every namespace it reads.
(() => {
  const {
    normalizeWhitespace,
    readText,
    unique,
    captureIdFor,
    newCaptureId,
    cleanUrl,
  } = globalThis.__fbGroupText;
  const {
    sleep,
    motion,
    setMotion,
    seededRandom,
    nextRandom,
    randFloat,
    randInt,
    lag,
    resetLag,
    glideBy,
    glideTo,
  } = globalThis.__fbGroupMotion;
  const {
    VERSION,
    PLATFORM,
    SCHEMA_VERSION,
    EXTRACTOR_VERSION,
    FEED_ORDER_TRIGGER_PATTERN,
  } = globalThis.__fbGroupPatterns;
  const {
    postAnchors,
    commentParentUrl,
  } = globalThis.__fbGroupLinks;
  const {
    stripNoise,
    controlsLabelled,
    insideDialog,
    findPostDialog,
    blockedNavigations,
    holdNavigationGuard,
  } = globalThis.__fbGroupDom;
  const {
    findAuthorLink,
    getAuthor,
    getCaption,
    getHashtags,
    expandText,
    hasTruncatedText,
  } = globalThis.__fbGroupPostContent;
  const {
    isCommentArticle,
    commentRoots,
    detectPosts,
  } = globalThis.__fbGroupPostDetect;
  const { getPublishedAt } = globalThis.__fbGroupPostTimestamp;
  const {
    permalinkAnchor,
    getPermalink,
    revealPermalink,
    readStampedId,
    pageStatePostId,
    getExternalPostId,
  } = globalThis.__fbGroupPostIdentity;
  const { getThumbnailUrl, getDurationSeconds, hasVideoAttachment } = globalThis.__fbGroupMedia;
  const { getMetrics } = globalThis.__fbGroupMetrics;
  const { getComments } = globalThis.__fbGroupCommentExtract;
  const { setCommentOrder } = globalThis.__fbGroupCommentOrder;
  const {
    expandCommentText,
    commentExpanders,
    renderedCommentCount,
    topLevelCommentRoots,
    expandComments,
  } = globalThis.__fbGroupCommentExpand;
  const { getCommentCount, captureThread } = globalThis.__fbGroupCommentCapture;
  const { scrapePermalinkComments } = globalThis.__fbGroupCommentPermalink;
  const {
    findFeedOrderControl,
    findFeedOrderTrigger,
    setFeedOrder,
  } = globalThis.__fbGroupFeedOrder;

  /* ------------------------------------------------------------------- group */

  function onGroupFeed() {
    const group = getGroup();
    if (!group?.externalId) return false;
    if (!document.querySelector('div[role="feed"]')) return false;
    // Anything past the group's own slug is a post's route, not the feed's.
    return new RegExp(`^/groups/${group.externalId}/?$`).test(location.pathname);
  }

  function getGroup() {
    const externalId = location.pathname.match(/\/groups\/([^/]+)/)?.[1] || null;
    if (!externalId) return null;
    return {
      externalId,
      // Titles arrive as "(3) Group Name | Facebook".
      name:
        normalizeWhitespace(document.title)
          .replace(/\s*\|\s*Facebook$/i, "")
          .replace(/^\(\d+\+?\)\s*/, "") || null,
      url: `${location.origin}/groups/${externalId}/`,
    };
  }

  /* ------------------------------------------------------------------- entry */
  const captureKey = (permalink, author, caption, postId) =>
    postId || permalink || `${author?.displayName || ""}::${(caption || "").slice(0, 120)}`;
  function parsePost(element, options = {}) {
    const {
      includeComments = true,
      maxCommentsPerPost = 20,
      scrapedAt = new Date().toISOString(),
    } = options;

    const warnings = [];
    const warn = (code) => {
      if (!warnings.includes(code)) warnings.push(code);
    };

    // Both cost a walk of the whole subtree, so they are paid for once here.
    const roots = commentRoots(element);
    const scope = stripNoise(element);

    const author = getAuthor(element);
    const anchor = permalinkAnchor(element, roots);
    const permalink = anchor ? cleanUrl(anchor.href) : null;
    const parentPostUrl = commentParentUrl(anchor);
    const caption = getCaption(scope, author);
    const truncated = hasTruncatedText(element);

    if (!author.displayName) warn("author.displayName:missing");
    if (!caption) warn("post.caption:missing");
    if (truncated) warn("post.caption:truncated");
    const {
      id: externalVideoId,
      attachment,
      borrowed,
      pageState,
      mismatch,
    } = getExternalPostId(element, permalink, roots);
    if (!externalVideoId) warn("externalVideoId:missing");
    if (attachment) warn("externalVideoId:from_attachment");
    if (borrowed) warn("externalVideoId:borrowed_href");
    if (pageState) warn("externalVideoId:from_page_state");
    if (mismatch) warn("externalVideoId:page_state_mismatch");

    const group = getGroup();
    let sourceUrl = permalink;
    if (!sourceUrl && pageState && externalVideoId && group?.externalId) {
      sourceUrl = `${location.origin}/groups/${group.externalId}/posts/${externalVideoId}/`;
      warn("sourceUrl:derived_from_post_id");
    }
    if (!sourceUrl) {
      sourceUrl = cleanUrl(location.href);
      warn("sourceUrl:fallback_group_url");
    }

    const { comments, dropped, capped } = includeComments
      ? getComments(element, maxCommentsPerPost, scrapedAt)
      : { comments: [], dropped: 0, capped: false };

    if (dropped) warn("comments:dropped_without_text");
    if (capped) warn("comments:capped");

    const metrics = getMetrics(scope, warn);
    const commentsComplete =
      includeComments &&
      !capped &&
      !commentExpanders(element, true).length &&
      (metrics.comments === null || comments.length >= metrics.comments);
    const identity =
      externalVideoId && group?.externalId
        ? `${PLATFORM}:${group.externalId}:${externalVideoId}`
        : permalink || null;
    if (!identity) warn("captureId:random");

    const capture = {
      captureId: identity ? captureIdFor(identity) : newCaptureId(),
      platform: PLATFORM,
      sourceUrl,
      scrapedAt,
      phase: includeComments ? "full" : "fast",
      schemaVersion: SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      externalVideoId,
      group,
      author,
      post: {
        caption,
        hashtags: getHashtags(element, caption),
        publishedAt: getPublishedAt(element, roots, scrapedAt, warn),
        hasVideo: hasVideoAttachment(scope),
        thumbnailUrl: getThumbnailUrl(scope),
        durationSeconds: getDurationSeconds(element),
        // Reels only, and a group feed never attributes one.
        soundName: null,
      },
      metrics,
      comments,
      commentsComplete,
      warnings,
    };

    const key = captureKey(permalink, author, caption, pageState ? externalVideoId : null);

    return {
      key,
      altKeys: unique([permalink, captureKey(null, author, caption)])
        .filter(Boolean)
        .filter((candidate) => candidate !== key),
      permalink,
      truncated,
      capture,
      // Set only when this unit is a comment on another post; null for a post.
      comment: parentPostUrl
        ? {
            externalCommentId: null,
            authorHandle: author.displayName || author.handle || null,
            text: caption,
            likes: metrics.likes,
            publishedAt: capture.post.publishedAt,
          }
        : null,
      parentPostUrl,
      parentPostId: parentPostUrl ? externalVideoId : null,
    };
  }

  function diagnose() {
    const { posts, strategies, feed } = detectPosts();
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaPosinset: element.getAttribute("aria-posinset"),
      childDivs: element.querySelectorAll("div").length,
      postAnchors: postAnchors(element).length,
      nestedArticles: element.querySelectorAll('div[role="article"]').length,
      authorLink: readText(findAuthorLink(element)).slice(0, 60) || null,
      permalink: getPermalink(element),
      stampedPostId: readStampedId(element),
      textPreview: readText(element).slice(0, 500),
    });

    return {
      version: VERSION,
      url: location.href,
      title: document.title,
      pageIdTagger: globalThis.__fbGroupPageId?.stats?.() || null,
      feedOrder: (() => {
        const found = findFeedOrderControl();
        return {
          controlFound: Boolean(found),
          label: found?.label ?? null,
          role: found?.control.getAttribute("role") || found?.control.tagName.toLowerCase() || null,
          ariaLabel: found?.control.getAttribute("aria-label") || null,
          candidates: controlsLabelled(FEED_ORDER_TRIGGER_PATTERN).map(({ control, label }) => ({
            label,
            role: control.getAttribute("role") || control.tagName.toLowerCase(),
            ruledOut:
              posts.some((post) => post.contains(control)) || insideDialog(control),
          })),
        };
      })(),
      onGroupFeed: onGroupFeed(),
      counts: {
        feedRole: Boolean(document.querySelector('div[role="feed"]')),
        feedFallback: feed?.getAttribute("role") || feed?.tagName,
        articleNodes: document.querySelectorAll('div[role="article"]').length,
        commentArticles: Array.from(document.querySelectorAll('div[role="article"]')).filter(
          isCommentArticle
        ).length,
        feedChildren: strategies.feedChildren.length,
        permalinkAnchors: postAnchors(feed).length,
        permalinkUnits: strategies.permalinks.length,
        detectedPosts: posts.length,
      },
      strategySamples: {
        articles: strategies.articles.slice(0, 2).map(describe),
        feedChildren: strategies.feedChildren.slice(0, 2).map(describe),
        permalinks: strategies.permalinks.slice(0, 2).map(describe),
      },
      detectedSamples: posts.slice(0, 3).map(describe),
    };
  }

  globalThis.__fbGroupScraper = {
    version: VERSION,
    platform: PLATFORM,
    schemaVersion: SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    diagnose,
    // Shared with collector.js, which drives the same parsers while scrolling.
    detectPosts,
    parsePost,
    hasTruncatedText,
    expandText,
    // "See more" across a whole thread, so a long comment is stored whole.
    expandCommentText,
    expandComments,
    commentExpanders,
    captureThread,
    // The worker tab's half: the whole thread, on the post's own permalink.
    scrapePermalinkComments,
    setCommentOrder,
    setFeedOrder,
    findFeedOrderTrigger,
    // A dialog over the feed is the reader's, and the walk waits behind it.
    findPostDialog,
    // What the navigation guard stopped, for the status line and the trace,
    // and the switch that holds it open for the length of a run.
    blockedNavigations,
    holdNavigationGuard,
    onGroupFeed,
    getCommentCount,
    renderedCommentCount,
    topLevelCommentRoots,
    getPermalink,
    revealPermalink,
    // Lets the collector skip the hover for a post page state already named.
    pageStatePostId,
    getGroup,
    sleep,
    glideBy,
    glideTo,
    lag,
    resetLag,
    randInt,
    randFloat,
    nextRandom,
    // The gesture engine's clock and dice; see setMotion.
    motion,
    setMotion,
    seededRandom,
  };
})();
