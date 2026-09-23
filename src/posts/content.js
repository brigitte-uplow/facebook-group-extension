// Who wrote a post and what it says: the author row, the caption, and the
// hashtags in it.
//
// Facebook truncates long captions behind a "See more" control and repeats the
// author's name inside the body, so reading the text means expanding it first
// and then filtering out the furniture. Loaded after src/utils/dom.js.
(() => {
  const {
    normalizeWhitespace,
    readText,
    isChromeLine,
    firstLine,
    unique,
    cleanUrl,
  } = globalThis.__fbGroupText;
  const {
    POST_URL_PATTERN,
    PROFILE_URL_PATTERN,
    SEE_MORE_PATTERN,
  } = globalThis.__fbGroupPatterns;
  const { handleFromProfileUrl } = globalThis.__fbGroupLinks;
  const {
    textBlocks,
    findButtons,
    trimLabel,
    clickableFor,
    navigatesAway,
    attemptsNavigation,
    clickWithoutNavigating,
  } = globalThis.__fbGroupDom;

  /* ------------------------------------------------------------------ author */

  function findAuthorLink(element) {
    const heading = element.querySelector("h2 a[href], h3 a[href], h4 a[href], strong a[href]");
    if (heading && readText(heading)) return heading;
    return Array.from(element.querySelectorAll("a[href]")).find((anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (POST_URL_PATTERN.test(href) || /\/groups\/[^/]+\/?$/.test(href)) return false;
      if (!PROFILE_URL_PATTERN.test(anchor.href)) return false;
      const text = readText(anchor);
      return text.length > 1 && text.length < 80 && !/^\d/.test(text);
    });
  }

  // Null rather than false: a missing badge only means the page never said.
  function isVerified(element) {
    const badge = element.querySelector(
      '[aria-label*="Verified" i]:not([aria-label*="unverified" i]), [title*="Verified" i]'
    );
    return badge ? true : null;
  }

  function getAuthor(element) {
    const link = findAuthorLink(element);
    if (!link) {
      const heading = element.querySelector("h2, h3, h4");
      const text = heading ? firstLine(heading) : "";
      return {
        handle: null,
        displayName: text || null,
        profileUrl: null,
        verified: isVerified(element),
      };
    }
    const profileUrl = cleanUrl(link.href);
    return {
      handle: handleFromProfileUrl(profileUrl),
      displayName: firstLine(link) || null,
      profileUrl,
      verified: isVerified(element),
    };
  }

  /* ----------------------------------------------------------------- caption */

  function getCaption(scope, author) {
    const explicit = scope.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'
    );
    if (explicit) {
      const text = readText(explicit);
      if (text) return text;
    }

    // Structural: leaf text blocks grouped by their parent, wordiest group wins.
    const groups = new Map();
    textBlocks(scope).forEach((block) => {
      if (block.closest('h2, h3, h4, [role="button"], [role="toolbar"]')) return;
      const text = readText(block);
      if (!text || isChromeLine(text) || text === author?.displayName) return;
      const key = block.parentElement?.parentElement || scope;
      groups.set(key, [...(groups.get(key) || []), text]);
    });
    let structural = "";
    groups.forEach((texts) => {
      const joined = normalizeWhitespace(texts.join("\n"));
      if (joined.length > structural.length) structural = joined;
    });

    // Textual: whole unit's innerText minus header/footer furniture.
    const textual = normalizeWhitespace(
      readText(scope)
        .split("\n")
        .filter((line) => line && !isChromeLine(line) && line !== author?.displayName)
        .join("\n")
    );

    // Structural is more precise; textual only rescues layouts it misses.
    return structural || textual || null;
  }

  function getHashtags(element, caption) {
    const tags = (caption || "").match(/#[\p{L}\p{N}_]+/gu)?.map((tag) => tag.slice(1)) || [];
    const linked = Array.from(element.querySelectorAll('a[href*="/hashtag/"]')).map((anchor) => {
      const slug = (anchor.getAttribute("href") || "").match(/\/hashtag\/([^/?#]+)/)?.[1];
      return slug ? decodeURIComponent(slug) : null;
    });
    return unique([...tags, ...linked]);
  }

  // A photo post's "See more" is rendered inside the anchor that opens the
  // post, and stripping the href off that anchor was not enough: Facebook's own
  // handler still runs and opens the post. So the ones that sit inside a link
  // are left alone and their captions stay truncated — a shortened caption is a
  // smaller loss than a walk that ends up inside the post it was reading.
  const MAX_SEE_MORE_ROUNDS = 4;
  const CAPTION_READY_MS = 800;
  const CAPTION_STABLE_MS = 180;
  const CAPTION_EXPAND_MS = 1200;

  const inNestedArticle = (node, root) => {
    const article = node.closest?.('div[role="article"]');
    return Boolean(article && article !== root && root.contains(article));
  };

  const isSeeMoreLabel = (value) => SEE_MORE_PATTERN.test(trimLabel(value || ""));

  function captionSignature(element) {
    const explicit = element.querySelector(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'
    );
    if (explicit) return readText(explicit);
    const blocks = [];
    for (const block of textBlocks(element)) {
      if (inNestedArticle(block, element)) continue;
      if (block.closest("h2, h3, h4, [role='toolbar']")) continue;
      const text = readText(block);
      if (!text || isChromeLine(text)) continue;
      blocks.push(text);
    }
    return blocks.join("\n");
  }

  function findCaptionSeeMore(element, options = {}) {
    const allowNavigate = options.allowNavigate === true;
    const found = [];
    const consider = (control) => {
      if (!control || found.includes(control)) return;
      if (inNestedArticle(control, element)) return;
      if (!allowNavigate && (navigatesAway(control) || attemptsNavigation(control))) return;
      found.push(control);
    };

    for (const button of findButtons(element, SEE_MORE_PATTERN)) consider(button);

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!isSeeMoreLabel(node.nodeValue)) continue;
      const host = node.parentElement;
      if (!host || inNestedArticle(host, element)) continue;
      consider(clickableFor(host));
    }
    return found;
  }

  function waitForCaptionReady(element, timeoutMs) {
    return new Promise((resolve) => {
      if (findCaptionSeeMore(element).length) return resolve("see-more");
      let last = captionSignature(element);
      let lastChange = Date.now();
      let dirty = false;
      let observer = null;
      let pollTimer = null;
      const started = Date.now();
      const finish = (reason) => {
        clearTimeout(pollTimer);
        observer?.disconnect();
        resolve(reason);
      };
      observer = new MutationObserver(() => {
        dirty = true;
      });
      observer.observe(element, { childList: true, subtree: true, characterData: true });
      const poll = () => {
        if (findCaptionSeeMore(element).length) return finish("see-more");
        if (dirty) {
          dirty = false;
          const next = captionSignature(element);
          if (next !== last) {
            last = next;
            lastChange = Date.now();
          }
        }
        if (Date.now() - lastChange >= CAPTION_STABLE_MS) return finish("stable");
        if (Date.now() - started >= timeoutMs) return finish("timeout");
        pollTimer = setTimeout(poll, 50);
      };
      poll();
    });
  }

  function waitForCaptionExpand(element, before, timeoutMs) {
    return new Promise((resolve) => {
      const grown = () => captionSignature(element).length > before.length;
      if (grown()) return resolve(true);
      let observer = null;
      let settleTimer = null;
      const finish = (value) => {
        clearTimeout(timer);
        clearTimeout(settleTimer);
        observer?.disconnect();
        resolve(value);
      };
      const timer = setTimeout(() => finish(grown()), timeoutMs);
      observer = new MutationObserver(() => {
        if (grown()) return finish(true);
        // See more is gone but the replacement text can land a frame later.
        if (!findCaptionSeeMore(element).length && !settleTimer) {
          settleTimer = setTimeout(() => finish(grown()), 200);
        }
      });
      observer.observe(element, { childList: true, subtree: true, characterData: true });
    });
  }

  async function expandText(element) {
    if (!element?.isConnected) return 0;
    // Fast bursts paint the card before "See more". Wait until that control
    // appears, or until the caption stops changing, before reading it.
    await waitForCaptionReady(element, CAPTION_READY_MS);
    let clicks = 0;
    for (let round = 0; round < MAX_SEE_MORE_ROUNDS; round += 1) {
      const buttons = findCaptionSeeMore(element);
      if (!buttons.length) break;
      const before = captionSignature(element);
      for (const button of buttons) {
        if (!button.isConnected) continue;
        clickWithoutNavigating(button);
        clicks += 1;
      }
      await waitForCaptionExpand(element, before, CAPTION_EXPAND_MS);
    }
    return clicks;
  }

  const hasTruncatedText = (element) =>
    findCaptionSeeMore(element, { allowNavigate: true }).length > 0;

  globalThis.__fbGroupPostContent = Object.freeze({
    findAuthorLink,
    isVerified,
    getAuthor,
    getCaption,
    getHashtags,
    expandText,
    hasTruncatedText,
  });
})();
