// Reading text out of Facebook's DOM, and the ids derived from what it says.
//
// Facebook ships randomized class names, so nothing here selects by class: text
// is read through an innerText approximation, then filtered against the UI
// furniture ("All reactions", "See more", "3 comments") that would otherwise be
// mistaken for content. Loaded before src/scraper.js, which consumes it.
(() => {
  const TRACKING_PARAMS = [
    "__cft__[0]",
    "__tn__",
    "comment_id",
    "notif_id",
    "notif_t",
    "ref",
    "refid",
    "__so__",
    "hoisted_section_header_type",
    "rdid",
    "share_url",
  ];

  // Lines of UI furniture to strip when falling back to text-based extraction.
  const CHROME_LINE_PATTERNS = [
    /^(like|love|haha|wow|sad|angry|care)$/i,
    /^(comment|comments|share|shares|reply|replies|send|save|follow|join|joined|hide|report)$/i,
    /^(see more|see less|see translation|view more comments?|view previous comments?|most relevant|newest|all comments|top comments|write (?:a|an) ?[a-z]*\s*(?:comment|answer|reply))[.…]*$/i,
    /^all reactions:?$/i,
    /^(top contributor|admin|moderator|author|group expert|anonymous participant|edited)$/i,
    // One or more count phrases on a single line: "3 comments", "24 reactions 1 share".
    /^([\d.,]+\s*[KkMm]?\s*(reactions?|comments?|shares?|views?|likes?)[,;·•\s]*)+$/i,
    /^[\d.,]+[KkMm]?$/,
    /^(just now|yesterday|today)$/i,
    /^\d+\s*(s|m|h|d|w|y|min|mins|hr|hrs|hour|hours|day|days|week|weeks|year|years)( ago)?$/i,
    /^[·•\-—\s]+$/,
    /^(public|private|group by|shared with|anyone can find this group)$/i,
    /^this content isn.t available right now$/i,
    /^when this happens, it.s usually because the owner/i,
  ];

  const normalizeWhitespace = (value) =>
    (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  // Tags that innerText would put a line break around.
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
    "TABLE", "TD", "TH", "TR", "UL",
  ]);
  function blockText(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.textContent.replace(/\s+/g, " ");
        continue;
      }
      if (child.nodeType !== 1) continue;
      // Not aria-hidden: the visible reaction row is marked aria-hidden.
      if (child.hasAttribute("hidden")) continue;
      const inner = blockText(child);
      out += BLOCK_TAGS.has(child.tagName) ? `\n${inner}\n` : inner;
    }
    return out;
  }

  const readText = (element) => {
    if (!element) return "";
    const raw = element.isConnected === false ? blockText(element) : element.innerText;
    return normalizeWhitespace(raw).replace(/\s*See (?:more|less)$/i, "");
  };

  const isChromeLine = (line) => CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line));

  // Facebook stacks a control's label above its state ("Most relevant\nSorted by…").
  const firstLine = (element) => readText(element).split("\n")[0] || "";

  const unique = (values) => Array.from(new Set(values.filter(Boolean)));
  function murmur32(text, seed) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      let block = Math.imul(text.charCodeAt(i), 0xcc9e2d51);
      block = (block << 15) | (block >>> 17);
      hash ^= Math.imul(block, 0x1b873593);
      hash = (hash << 13) | (hash >>> 19);
      hash = (Math.imul(hash, 5) + 0xe6546b64) >>> 0;
    }
    hash ^= text.length;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
  }

  const CAPTURE_ID_SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
  function captureIdFor(identity) {
    const hex = CAPTURE_ID_SEEDS.map((seed) =>
      murmur32(identity, seed).toString(16).padStart(8, "0")
    ).join("");
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `8${hex.slice(13, 16)}`,
      `${variant}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join("-");
  }
  function newCaptureId() {
    const source = globalThis.crypto;
    if (typeof source?.randomUUID === "function") return source.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function parseCount(raw) {
    if (raw === null || raw === undefined) return null;
    const match = String(raw).match(/([\d.,]+)\s*([KkMm])?/);
    if (!match) return null;
    const base = Number(match[1].replace(/,/g, ""));
    if (Number.isNaN(base)) return null;
    const suffix = match[2]?.toLowerCase();
    if (suffix === "k") return Math.round(base * 1_000);
    if (suffix === "m") return Math.round(base * 1_000_000);
    return Math.round(base);
  }

  function cleanUrl(href) {
    try {
      const url = new URL(href, location.origin);
      TRACKING_PARAMS.forEach((param) => url.searchParams.delete(param));
      url.hash = "";
      return url.toString();
    } catch {
      return href;
    }
  }

  globalThis.__fbGroupText = Object.freeze({
    normalizeWhitespace,
    readText,
    isChromeLine,
    firstLine,
    unique,
    captureIdFor,
    newCaptureId,
    parseCount,
    cleanUrl,
  });
})();
