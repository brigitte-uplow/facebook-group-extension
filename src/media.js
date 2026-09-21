// The attachment on a post: its thumbnail, and whether it is a video.
//
// A feed unit is full of images that are not the post's — avatars, reaction
// icons, link previews in comments — so candidates are filtered by area and the
// largest one wins. Loaded after src/utils/links.js.
(() => {
  const { cleanUrl } = globalThis.__fbGroupText;
  const { VIDEO_HREF_PATTERN } = globalThis.__fbGroupPatterns;
  const { isForeignGroupUrl } = globalThis.__fbGroupLinks;

  const imageArea = (image) => {
    const width = Number(image.getAttribute("width")) || image.naturalWidth || 0;
    const height = Number(image.getAttribute("height")) || image.naturalHeight || 0;
    return width * height;
  };

  function getThumbnailUrl(scope) {
    const poster = scope.querySelector("video[poster]")?.getAttribute("poster");
    if (poster) return poster;
    const candidates = Array.from(scope.querySelectorAll("img[src]")).filter((image) => {
      if (image.closest('h2, h3, h4, [role="button"], [role="toolbar"]')) return false;
      if (/^data:/.test(image.getAttribute("src") || "")) return false;
      const area = imageArea(image);
      return area === 0 || area >= 100 * 100;
    });
    if (!candidates.length) return null;

    const largest = candidates.reduce((best, image) =>
      imageArea(image) > imageArea(best) ? image : best
    );
    return cleanUrl(largest.src);
  }

  function getDurationSeconds(element) {
    const duration = element.querySelector("video")?.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  function hasVideoAttachment(scope) {
    return Array.from(scope.querySelectorAll("a[href]")).some(
      (anchor) =>
        VIDEO_HREF_PATTERN.test(anchor.getAttribute("href") || "") &&
        !isForeignGroupUrl(anchor.href)
    );
  }

  globalThis.__fbGroupMedia = Object.freeze({
    getThumbnailUrl,
    getDurationSeconds,
    hasVideoAttachment,
  });
})();
