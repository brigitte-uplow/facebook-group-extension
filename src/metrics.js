// The tallies under a post: reactions, comments, shares, views.
//
// Facebook writes a count in whichever form the surface uses — a worded
// aria-label, a bare number on a button, or one line per reaction on the emoji
// pile — so each is tried in turn, strongest first, and a summed per-reaction
// floor is used only when no overall total is shown at all. Loaded after
// src/patterns.js.
(() => {
  const { normalizeWhitespace, readText, parseCount } = globalThis.__fbGroupText;
  const {
    COUNT_BUTTON_LABELS,
    REACTION_TALLY_PATTERN,
    COMMENT_COUNT_PATTERN,
  } = globalThis.__fbGroupPatterns;

  const firstNumber = (...values) =>
    values.find((value) => typeof value === "number") ?? null;

  function countsFromButtons(scope) {
    const counts = {};
    for (const node of scope.querySelectorAll("span, div")) {
      // Leaves only: an ancestor holds the button's "Like" text as well.
      if (node.querySelector("span, div")) continue;
      const text = readText(node);
      if (!/^[\d.,]+\s*[KkMm]?$/.test(text)) continue;
      const label = normalizeWhitespace(
        node.closest('[role="button"], [role="link"]')?.getAttribute("aria-label")
      );
      if (!label) continue;
      const hit = COUNT_BUTTON_LABELS.find(([, pattern]) => pattern.test(label));
      if (hit && counts[hit[0]] === undefined) counts[hit[0]] = parseCount(text);
    }
    return counts;
  }

  const ariaLabels = (nodes) => nodes.map((node) => node.getAttribute("aria-label"));

  const countLines = (labels, scope) =>
    [...labels, readText(scope)]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const findCount = (lines, pattern) => {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return parseCount(match[1]);
    }
    return null;
  };

  function getMetrics(scope, warn) {
    const lines = countLines(ariaLabels(Array.from(scope.querySelectorAll("[aria-label]"))), scope);
    const find = (pattern) => findCount(lines, pattern);

    const byLabel = countsFromButtons(scope);

    let likes = find(/all reactions:?\s*([\d.,]+\s*[KkMm]?)/i);
    // Comet renders "All reactions:" as a label above the total, not beside it.
    if (likes === null) {
      const label = lines.findIndex((line) => /^all reactions:?$/i.test(line));
      if (label >= 0) likes = parseCount(lines[label + 1]?.match(/^[\d.,]+\s*[KkMm]?$/)?.[0]);
    }
    if (likes === null) likes = find(/([\d.,]+\s*[KkMm]?)\s*(?:reactions?|people reacted)/i);
    if (likes === null && byLabel.likes !== undefined) likes = byLabel.likes;
    // A floor, not a total: with no overall tally, sum each reaction's own count.
    if (likes === null) {
      const perReaction = lines
        .map((line) => line.match(REACTION_TALLY_PATTERN))
        .filter(Boolean)
        .map((match) => parseCount(match[1]));
      if (perReaction.length) likes = perReaction.reduce((sum, count) => sum + count, 0);
    }
    if (likes === null) {
      // Comet renders the total as a bare number beside the emoji pile.
      const pile = scope.querySelector(
        '[aria-label*="reaction" i], [aria-label*="Like:" i], [aria-label*="see who reacted" i]'
      );
      const nearby = readText(pile?.closest('[role="button"]') || pile?.parentElement);
      likes = parseCount(nearby.match(/[\d.,]+[KkMm]?/)?.[0]);
    }
    if (likes === null) warn("metrics.likes:missing");

    return {
      likes,
      comments: firstNumber(find(COMMENT_COUNT_PATTERN), byLabel.comments),
      shares: firstNumber(find(/([\d.,]+\s*[KkMm]?)\s*shares?\b/i), byLabel.shares),
      views: firstNumber(find(/([\d.,]+\s*[KkMm]?)\s*views?\b/i), byLabel.views),
      // Facebook never shows a save count to a visitor.
      saves: null,
    };
  }

  globalThis.__fbGroupMetrics = Object.freeze({
    firstNumber,
    countsFromButtons,
    ariaLabels,
    countLines,
    findCount,
    getMetrics,
  });
})();
