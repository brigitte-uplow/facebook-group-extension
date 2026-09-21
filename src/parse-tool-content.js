function parseToolContentText(text) {
  if (typeof text !== "string") {
    throw new Error("Tool content text is not a string");
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Tool content text is empty");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Prefixed summary + JSON, or other wrapper text — extract below.
  }

  const extracted = extractFirstJsonValue(trimmed);
  if (extracted !== null) {
    try {
      return JSON.parse(extracted);
    } catch {
      // Fall through to the clear error below.
    }
  }

  throw new Error(`Tool content is not JSON: ${sanitizeContentPrefix(trimmed)}`);
}
function extractFirstJsonValue(text) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const slice = sliceBalancedJson(text, i);
    if (slice === null) continue;
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      // False start (e.g. a lone `{` in the prose); try the next opener.
    }
  }
  return null;
}

function sliceBalancedJson(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}
function sanitizeContentPrefix(text) {
  return String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

if (typeof globalThis !== "undefined") {
  globalThis.parseToolContentText = parseToolContentText;
}
