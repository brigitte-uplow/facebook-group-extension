// One rendered comment, read into a record.
//
// A comment's author, age, and body all arrive glued together: the aria-label
// reads "Comment by Myrna Palolan 8 hours ago", and Comet repeats the author's
// name as the body's first line. Each is split back out here. Comments carry no
// id, because a permalink is only rendered once the comment is linked to, so
// position is the dedupe key the server uses. Loaded after src/utils/dom.js.
(() => {
  const {
    normalizeWhitespace,
    readText,
    isChromeLine,
    firstLine,
    unique,
    parseCount,
  } = globalThis.__fbGroupText;
  const {
    TRAILING_RELATIVE_PATTERN,
    parseAbsoluteLabel,
    parseRelativeLabel,
  } = globalThis.__fbGroupTime;
  const { COMMENT_HREF_PATTERN } = globalThis.__fbGroupPatterns;
  const { textBlocks } = globalThis.__fbGroupDom;
  const { findAuthorLink } = globalThis.__fbGroupPostContent;

  function getCommentAuthorLabel(commentArticle) {
    const label = commentArticle.getAttribute("aria-label") || "";
    const fromLabel = label.match(/^Comment by (.+?)(?:\s+on\b|$)/i)?.[1];
    if (fromLabel) return fromLabel.trim();
    const link = findAuthorLink(commentArticle);
    return link ? firstLine(link) || null : null;
  }

  // Facebook glues the age onto the author: "Myrna Palolan 8 hours ago".
  function splitCommentAuthor(label) {
    if (!label) return { authorHandle: null, publishedAt: null };
    const match = label.match(TRAILING_RELATIVE_PATTERN);
    if (!match) return { authorHandle: normalizeWhitespace(label) || null, publishedAt: null };
    return {
      authorHandle: normalizeWhitespace(label.slice(0, match.index)) || null,
      publishedAt: normalizeWhitespace(match[1]) || null,
    };
  }

  function commentTimeAnchor(commentArticle) {
    return Array.from(commentArticle.querySelectorAll("a[href]")).find((anchor) =>
      COMMENT_HREF_PATTERN.test(anchor.getAttribute("href") || "")
    );
  }

  function getCommentPublishedAt(commentArticle, fallback, nowIso) {
    const anchor = commentTimeAnchor(commentArticle);
    const labels = unique([
      anchor?.getAttribute("aria-label"),
      anchor?.getAttribute("title"),
      readText(anchor).split("\n").pop(),
      fallback,
    ]).map((label) => normalizeWhitespace(label));

    for (const label of labels) {
      const absolute = parseAbsoluteLabel(label, nowIso);
      if (absolute) return absolute;
    }
    // Anything that does not read as an age is furniture, usually a separator dot.
    return labels.find((label) => parseRelativeLabel(label, nowIso)) || fallback || null;
  }

  // Comet repeats the author's name as the body's first line, in the same block.
  function stripAuthorLines(text, names) {
    if (!text) return text;
    const wanted = names.filter(Boolean).map((name) => name.trim());
    const lines = text.split("\n");
    while (lines.length > 1 && wanted.includes(lines[0].trim())) lines.shift();
    return normalizeWhitespace(lines.join("\n"));
  }

  function getCommentBody(commentArticle, names) {
    const blocks = textBlocks(commentArticle)
      .map((block) => readText(block))
      .filter((text) => text && !names.includes(text) && !isChromeLine(text));
    if (!blocks.length) return null;
    return stripAuthorLines(normalizeWhitespace(unique(blocks).join("\n")), names) || null;
  }

  function getComments(element, limit, nowIso, { exclude = [] } = {}) {
    const cap = limit > 0 ? limit : Infinity;
    const comments = [];
    let dropped = 0;
    // Every nested article except the post itself is a comment.
    const nodes = Array.from(element.querySelectorAll('div[role="article"]')).filter(
      (node) => node !== element && !exclude.includes(node)
    );

    for (const node of nodes) {
      if (comments.length >= cap) break;
      const label = getCommentAuthorLabel(node);
      const { authorHandle, publishedAt: labelTime } = splitCommentAuthor(label);
      const text = getCommentBody(node, unique([label, authorHandle]));
      if (!text) {
        if (label) dropped += 1;
        continue;
      }
      comments.push({
        // Position is the server-side dedupe key; ids need a rendered permalink.
        externalCommentId: null,
        authorHandle,
        text,
        likes: parseCount(
          (node.getAttribute("aria-label") || "").match(/([\d.,]+[KkMm]?)\s*reactions?/i)?.[1]
        ),
        publishedAt: getCommentPublishedAt(node, labelTime, nowIso),
      });
    }

    return { comments, dropped, capped: nodes.length > cap };
  }

  globalThis.__fbGroupCommentExtract = Object.freeze({
    getCommentAuthorLabel,
    splitCommentAuthor,
    commentTimeAnchor,
    getCommentPublishedAt,
    getCommentBody,
    getComments,
  });
})();
