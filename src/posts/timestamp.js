// When a post was published, out of a header that may only say "8h".
//
// Facebook puts the age in whichever of a dozen places the layout of the day
// prefers: a title attribute, an aria-label, a tooltip, or bare text next to
// the author. Candidate labels are gathered from the header first, because a
// label from the body is as likely to belong to a quoted post as to this one,
// and only then resolved to an instant. Loaded after src/posts/detect.js.
(() => {
  const { readText, unique } = globalThis.__fbGroupText;
  const {
    TIMESTAMP_HREF_PATTERN,
    normalizeTimestampLabel,
    looksLikeTimestampCandidate,
    extractTimestampCandidates,
    parseAbsoluteLabel,
    parseRelativeLabel,
  } = globalThis.__fbGroupTime;
  const { POST_URL_PATTERN } = globalThis.__fbGroupPatterns;
  const { postAnchors, isProfileOnlyLink } = globalThis.__fbGroupLinks;
  const { stripNoise } = globalThis.__fbGroupDom;
  const { findAuthorLink } = globalThis.__fbGroupPostContent;
  const { timestampExcludeRoots, outsideComments } = globalThis.__fbGroupPostDetect;

  function postHeaderContainer(element, authorLink) {
    const heading = authorLink?.closest("h2, h3, h4");
    const container = heading?.closest('[role="article"]') || heading?.parentElement || element;
    return element.contains(container) ? container : element;
  }

  function headerNodes(element, roots, selector) {
    const authorLink = findAuthorLink(element);
    const container = postHeaderContainer(element, authorLink);

    return Array.from(container.querySelectorAll(selector)).filter((node) => {
      if (!element.contains(node)) return false;
      if (roots.some((root) => root.contains(node))) return false;
      if (node === authorLink || authorLink?.contains(node)) return false;
      if (node.closest('[role="button"], [role="toolbar"]')) return false;
      return !isProfileOnlyLink(node);
    });
  }

  // Links that carry the age even when they are not a canonical post URL.
  function timestampAnchors(element, roots) {
    return headerNodes(
      element,
      roots,
      "a[href], [role='link'], span[tabindex], div[tabindex]"
    ).filter((node) => {
      const href = node.getAttribute("href") || "";
      if (POST_URL_PATTERN.test(href) || TIMESTAMP_HREF_PATTERN.test(href)) return true;

      const label = normalizeTimestampLabel(
        [node.getAttribute("aria-label"), node.getAttribute("title"), readText(node)]
          .filter(Boolean)
          .join(" ")
      );
      return looksLikeTimestampCandidate(label);
    });
  }

  function headerLineTimestampLabels(element) {
    const lines = readText(stripNoise(element))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];

    // Stop at the first long line: past the header, the body starts.
    const header = [];
    for (const line of lines.slice(1, 8)) {
      if (line.length > 80) break;
      header.push(line);
    }
    const hit = header.find((line) => looksLikeTimestampCandidate(line));
    return hit ? [normalizeTimestampLabel(hit)] : [];
  }

  function headerTimestampLabels(element, roots) {
    return headerNodes(
      element,
      roots,
      "a[href], span, time, abbr, [aria-label], [title], [role='link']"
    ).flatMap((node) => [
      node.getAttribute("datetime"),
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-tooltip-content"),
    ]);
  }

  function headerTextLabels(element, roots) {
    return headerNodes(
      element,
      roots,
      "a[href], span, time, abbr, [aria-label], [title], [role='link']"
    ).map((node) => readText(node));
  }

  function anchorTimestampLabels(anchor) {
    const labels = [];
    for (const node of [anchor, ...anchor.querySelectorAll("[aria-label], [title]")]) {
      labels.push(node.getAttribute("aria-label"), node.getAttribute("title"));
    }
    labels.push(readText(anchor).split("\n").pop());
    return labels;
  }

  const asCandidates = (labels) =>
    unique(
      labels
        .map((label) => normalizeTimestampLabel(label))
        .filter(Boolean)
        .flatMap((label) => extractTimestampCandidates(label))
    );

  function timestampLabels(element, roots) {
    const own = [];

    for (const node of element.querySelectorAll("time[datetime], abbr[title], abbr[data-utime]")) {
      if (roots.some((root) => root.contains(node))) continue;
      own.push(
        node.getAttribute("datetime"),
        node.getAttribute("title"),
        node.getAttribute("data-utime")
      );
      own.push(readText(node));
    }

    const anchors = new Set([
      ...outsideComments(postAnchors(element), roots),
      ...timestampAnchors(element, roots),
    ]);
    for (const anchor of anchors) own.push(...anchorTimestampLabels(anchor));

    own.push(...headerTimestampLabels(element, roots));

    return {
      own: asCandidates(own),
      body: asCandidates([...headerTextLabels(element, roots), ...headerLineTimestampLabels(element)]),
    };
  }

  const FUTURE_SLACK_MS = 6 * 60 * 60 * 1000;

  function notInFuture(iso, nowIso) {
    if (!iso) return null;
    const at = Date.parse(iso);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(at) || !Number.isFinite(now)) return iso;
    return at - now > FUTURE_SLACK_MS ? null : iso;
  }

  function resolveLabels(labels, nowIso) {
    for (const label of labels) {
      const absolute = notInFuture(parseAbsoluteLabel(label, nowIso), nowIso);
      if (absolute) return { at: absolute, approximated: false };
    }
    for (const label of labels) {
      const relative = parseRelativeLabel(label, nowIso);
      if (relative) return { at: relative, approximated: true };
    }
    return null;
  }

  function storyHeaderAgeLabels(element, roots) {
    const authorLink = findAuthorLink(element);
    if (!authorLink) return [];

    const authorBlock = authorLink.closest("h2, h3, h4, strong") || authorLink;
    const labels = [];
    const nodes = Array.from(
      element.querySelectorAll(
        "a[href], [role='link'], span[tabindex], div[tabindex], time, abbr"
      )
    );

    for (const node of nodes) {
      if (roots.some((root) => root.contains(node))) continue;
      if (authorBlock.contains(node)) continue;
      const position = authorBlock.compareDocumentPosition(node);
      if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (node.closest('[dir="auto"]') || node.getAttribute("dir") === "auto") break;

      // Embedded original's author row (with or without role=article).
      if (node.matches("a[href]") && isProfileOnlyLink(node) && node !== authorLink) break;
      if (node.matches("h2, h3, h4") && !authorBlock.contains(node)) {
        const nestedAuthor = node.querySelector("a[href]");
        if (
          nestedAuthor &&
          nestedAuthor !== authorLink &&
          isProfileOnlyLink(nestedAuthor)
        ) {
          break;
        }
      }

      if (node.closest('[role="button"], [role="toolbar"]')) continue;
      if (isProfileOnlyLink(node)) continue;

      const text = readText(node);
      const raws = [
        node.getAttribute("datetime"),
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("data-tooltip-content"),
        text.split("\n").pop(),
      ];
      for (const raw of raws) {
        const label = normalizeTimestampLabel(raw);
        if (label && looksLikeTimestampCandidate(label)) labels.push(label);
      }
      if (labels.length) break;
    }
    return asCandidates(labels);
  }

  function getPublishedAt(element, roots, nowIso, warn) {
    const exclude = timestampExcludeRoots(element, roots);
    const header = resolveLabels(storyHeaderAgeLabels(element, exclude), nowIso);
    if (header) {
      if (header.approximated) warn("post.publishedAt:approximated_from_relative");
      return header.at;
    }

    let bestUtime = 0;
    for (const node of element.querySelectorAll("[data-utime]")) {
      if (exclude.some((root) => root.contains(node))) continue;
      const utime = Number(node.getAttribute("data-utime"));
      if (utime > bestUtime) bestUtime = utime;
    }
    if (bestUtime > 0) return new Date(bestUtime * 1000).toISOString();

    const labels = timestampLabels(element, exclude);

    const own = resolveLabels(labels.own, nowIso);
    if (own) {
      if (own.approximated) warn("post.publishedAt:approximated_from_relative");
      return own.at;
    }
    const body = resolveLabels(labels.body, nowIso);
    if (body) {
      warn("post.publishedAt:from_body_text");
      if (body.approximated) warn("post.publishedAt:approximated_from_relative");
      return body.at;
    }

    const timestampLike = [...labels.own, ...labels.body].filter(looksLikeTimestampCandidate);
    warn(timestampLike.length ? "post.publishedAt:unresolved" : "post.publishedAt:missing");
    return null;
  }

  globalThis.__fbGroupPostTimestamp = Object.freeze({
    headerNodes,
    timestampAnchors,
    anchorTimestampLabels,
    asCandidates,
    timestampLabels,
    notInFuture,
    resolveLabels,
    storyHeaderAgeLabels,
    getPublishedAt,
  });
})();
