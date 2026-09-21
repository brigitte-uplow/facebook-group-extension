// The only script a group tab gets on load. Isolated world, document_idle,
// and it does not touch Facebook's page. The old content_scripts list — a
// MAIN-world tagger at document_start plus the whole collector — ran in every
// group tab that remounted. Reloading one tab remounted its siblings, each
// sibling then remounted the rest, and with three other groups open that was
// the "reloads 3 times" cascade. Collection is injected into this tab only,
// and only after a trusted wheel / touch / key from the person looking at it
// — or after a remount while comments are still draining, so the worker's
// answers have somewhere to land.
(() => {
  if (globalThis.__fbGroupBoot) return;
  globalThis.__fbGroupBoot = true;

  const USER_SCROLL_KEYS = new Set(["PageDown", "PageUp", "ArrowDown", "ArrowUp", " ", "Home", "End"]);
  let asked = false;

  function askToLoad(drain = false) {
    if (asked) return;
    asked = true;
    try {
      chrome.runtime.sendMessage({ type: "loadCollector", drain }, () => {
        if (chrome.runtime.lastError) asked = false;
      });
    } catch {
      asked = false;
    }
  }

  const groupKey = (location.pathname || "").match(/\/groups\/([^/]+)/)?.[1];
  if (groupKey) {
    try {
      chrome.storage.local.get([`commentDrain:${groupKey}`], (saved) => {
        if (saved?.[`commentDrain:${groupKey}`]?.draining) askToLoad(true);
      });
    } catch {
      // Extension gone.
    }
  }

  window.addEventListener(
    "wheel",
    (event) => {
      if (event.isTrusted) askToLoad();
    },
    { passive: true }
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      if (event.isTrusted) askToLoad();
    },
    { passive: true }
  );
  window.addEventListener("keydown", (event) => {
    if (event.isTrusted && USER_SCROLL_KEYS.has(event.key)) askToLoad();
  });
})();
