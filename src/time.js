// Turning the age Facebook printed into an ISO timestamp.
//
// The same fact is rendered a dozen ways — "3h", "about 2 days ago", "Yesterday
// at 5:03 PM", "September 8", "9/8/25", a bare ISO string — so there is a parser
// per format and `parseAbsoluteLabel`/`parseRelativeLabel` try them in turn.
// Extracting the label from the DOM is src/scraper.js's job; this only parses.
(() => {
  const {
    normalizeWhitespace,
    isChromeLine,
    unique,
  } = globalThis.__fbGroupText;

  const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];

  const RELATIVE_UNIT_SECONDS = {
    s: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    hour: 3600,
    hours: 3600,
    d: 86_400,
    day: 86_400,
    days: 86_400,
    w: 604_800,
    week: 604_800,
    weeks: 604_800,
    mo: 2_629_800,
    month: 2_629_800,
    months: 2_629_800,
    y: 31_557_600,
    year: 31_557_600,
    years: 31_557_600,
  };

  const RELATIVE_UNITS = Object.keys(RELATIVE_UNIT_SECONDS).join("|");
  const RELATIVE_HEDGE = "(?:about|around|almost|over|nearly)\\s+";

  const RELATIVE_LABEL = `(?:${RELATIVE_HEDGE})?(\\d+|an?)\\s*(${RELATIVE_UNITS})(?:\\s+ago)?`;

  const RELATIVE_LABEL_PATTERN = new RegExp(`^${RELATIVE_LABEL}$`, "i");
  const TRAILING_RELATIVE_PATTERN = new RegExp(
    `[\\s·•]+((?:${RELATIVE_HEDGE})?(?:\\d+\\s*(?:${RELATIVE_UNITS})(?:\\s+ago)?|an?\\s+(?:${RELATIVE_UNITS})\\s+ago)|just now|yesterday|today)$`,
    "i"
  );

  const MONTH_NAME_PATTERN = MONTHS.map((month) => `${month.slice(0, 3)}[a-z]*`).join("|");
  const MONTH_DATE_SNIPPET_PATTERN = new RegExp(
    `\\b(?:(?:${MONTH_NAME_PATTERN})\\s+\\d{1,2}|\\d{1,2}\\s+(?:${MONTH_NAME_PATTERN}))(?:,?\\s*(?:20\\d{2}))?(?:\\s+at\\s+\\d{1,2}:\\d{2}\\s*(?:am|pm)?)?`,
    "i"
  );
  const EMBEDDED_RELATIVE_PATTERN = new RegExp(`\\b${RELATIVE_LABEL}\\b`, "i");

  // Group feed permalinks often use query params instead of /posts/<id>.
  const TIMESTAMP_HREF_PATTERN =
    /multi_permalinks=|story_fbid=|[?&]fbid=|\/groups\/[^/]+\/(?:posts|permalink)\//;

  function normalizeTimestampLabel(text) {
    return normalizeWhitespace(text)
      .replace(/^[·•\-–—]+\s*/g, "")
      .replace(/\s*[·•\-–—]+\s*$/g, "")
      .trim();
  }

  function looksLikeTimestampCandidate(text) {
    const candidate = normalizeTimestampLabel(text);
    if (!candidate || candidate.length > 80) return false;
    if (isChromeLine(candidate)) {
      // Relative ages are chrome when stripping captions, but are timestamps here.
      return (
        /^(just now|yesterday|today)$/i.test(candidate) ||
        RELATIVE_LABEL_PATTERN.test(candidate) ||
        TRAILING_RELATIVE_PATTERN.test(candidate)
      );
    }
    return (
      RELATIVE_LABEL_PATTERN.test(candidate) ||
      TRAILING_RELATIVE_PATTERN.test(candidate) ||
      MONTH_DATE_SNIPPET_PATTERN.test(candidate) ||
      /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(candidate) ||
      /\b20\d{2}-\d{2}-\d{2}\b/.test(candidate) ||
      (/^yesterday\b/i.test(candidate) && /\d{1,2}:\d{2}/.test(candidate))
    );
  }
  function parseTimeOfDay(text) {
    const match = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!match) return { hours: 0, minutes: 0, found: false };
    let hours = Number(match[1]);
    const meridiem = match[3]?.toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    return { hours, minutes: Number(match[2]), found: true };
  }

  const isoOrNull = (date) => (Number.isNaN(date.getTime()) ? null : date.toISOString());

  function parseNumericDate(text, nowIso) {
    const match = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (!match) return null;

    let month = Number(match[1]);
    let day = Number(match[2]);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    let year = match[3] ? Number(match[3]) : new Date(nowIso).getFullYear();
    if (year < 100) year += 2000;

    const { hours, minutes } = parseTimeOfDay(text);
    return isoOrNull(new Date(year, month - 1, day, hours, minutes));
  }

  function parseYesterdayWithTime(text, nowIso) {
    const candidate = normalizeWhitespace(text);
    if (!/^yesterday\b/i.test(candidate)) return null;

    const now = new Date(nowIso);
    if (Number.isNaN(now.getTime())) return null;

    const parsed = new Date(now);
    parsed.setDate(parsed.getDate() - 1);

    const { hours, minutes, found } = parseTimeOfDay(candidate);
    if (found) parsed.setHours(hours, minutes, 0, 0);
    return parsed.toISOString();
  }

  function parseMonthDayYear(text, nowIso) {
    const monthMatch = text.match(new RegExp(`\\b(${MONTH_NAME_PATTERN})\\b`, "i"));
    if (!monthMatch) return null;

    const monthIndex = MONTHS.findIndex((month) =>
      new RegExp(`^${month.slice(0, 3)}`, "i").test(monthMatch[1])
    );
    if (monthIndex < 0) return null;

    const before = text.slice(0, monthMatch.index);
    const after = text.slice(monthMatch.index + monthMatch[0].length);
    // "September 8" and "8 September" both appear on Facebook.
    let day = Number(after.match(/^\s*,?\s*(\d{1,2})\b/)?.[1]);
    if (!day || day > 31) day = Number(before.match(/(\d{1,2})\s*$/)?.[1]);
    if (!day || day > 31) return null;

    // Facebook omits the year for anything in the current one.
    const year = Number(text.match(/\b(20\d{2})\b/)?.[1]) || new Date(nowIso).getFullYear();
    const { hours, minutes } = parseTimeOfDay(text);
    return isoOrNull(new Date(year, monthIndex, day, hours, minutes));
  }

  function extractTimestampCandidates(label) {
    const text = normalizeTimestampLabel(label);
    if (!text) return [];

    const candidates = [text];
    const trailing = text.match(TRAILING_RELATIVE_PATTERN);
    if (trailing?.[1]) candidates.push(trailing[1]);

    const onTail = text.match(/\bon\s+(.+)$/i);
    if (onTail?.[1]) candidates.push(onTail[1]);

    const monthSnippet = text.match(MONTH_DATE_SNIPPET_PATTERN);
    if (monthSnippet?.[0]) candidates.push(monthSnippet[0]);

    return unique(candidates);
  }

  function parseIsoLabel(text) {
    const match = text.match(
      /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/
    );
    return match ? isoOrNull(new Date(match[0])) : null;
  }

  function parseAbsoluteLabel(label, nowIso) {
    for (const candidate of extractTimestampCandidates(label)) {
      const text = normalizeWhitespace(candidate);
      if (!text || !/\d/.test(text)) continue;

      const parsed =
        parseIsoLabel(text) ||
        parseMonthDayYear(text, nowIso) ||
        parseNumericDate(text, nowIso) ||
        parseYesterdayWithTime(text, nowIso);
      if (parsed) return parsed;
    }

    return null;
  }

  function resolveRelativeMatch(match, nowIso) {
    const now = new Date(nowIso);
    if (Number.isNaN(now.getTime())) return null;

    const seconds = RELATIVE_UNIT_SECONDS[match[2].toLowerCase()];
    if (!seconds) return null;
    const quantity = /^\d+$/.test(match[1]) ? Number(match[1]) : 1;
    return new Date(now.getTime() - quantity * seconds * 1000).toISOString();
  }
  function parseRelativeLabel(label, nowIso) {
    for (const candidate of extractTimestampCandidates(label)) {
      const text = normalizeWhitespace(candidate).toLowerCase();
      const now = new Date(nowIso);
      if (Number.isNaN(now.getTime())) continue;

      if (text === "just now" || text === "today") return now.toISOString();
      if (text.startsWith("yesterday")) {
        return parseYesterdayWithTime(candidate, nowIso) ||
          new Date(now.getTime() - RELATIVE_UNIT_SECONDS.d * 1000).toISOString();
      }

      const match = text.match(RELATIVE_LABEL_PATTERN) || text.match(EMBEDDED_RELATIVE_PATTERN);
      if (!match) continue;
      const resolved = resolveRelativeMatch(match, nowIso);
      if (resolved) return resolved;
    }

    return null;
  }

  globalThis.__fbGroupTime = Object.freeze({
    TRAILING_RELATIVE_PATTERN,
    TIMESTAMP_HREF_PATTERN,
    normalizeTimestampLabel,
    looksLikeTimestampCandidate,
    extractTimestampCandidates,
    parseAbsoluteLabel,
    parseRelativeLabel,
  });
})();
