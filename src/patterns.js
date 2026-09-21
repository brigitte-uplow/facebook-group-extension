// The shapes Facebook's markup is recognised by: URL patterns, control labels,
// and the version stamps a capture carries.
//
// Nothing here touches the DOM. It is the one place a selector or a wording is
// written down, so the modules that walk the page can be read without a regex
// in the way. Loaded before every other scraper half.
(() => {
  const VERSION = "0.18.1";
  const PLATFORM = "facebook_group";
  const SCHEMA_VERSION = 2;
  const EXTRACTOR_VERSION = `fb-group-scraper@${VERSION}`;

  // Group URLs carry numeric ids or opaque `pfbid...` ones.
  const POST_ID = "(?:\\d+|pfbid[A-Za-z0-9]+)";
  const GROUP_POST_PATTERN = new RegExp(`/groups/[^/]+/(?:posts|permalink)/${POST_ID}`);
  const POST_ID_PATTERNS = [
    new RegExp(`/groups/[^/]+/(?:posts|permalink)/(${POST_ID})`),
    new RegExp(`multi_permalinks=(${POST_ID})`),
    new RegExp(`story_fbid=(${POST_ID})`),
    new RegExp(`[?&]set=gm\\.(\\d+)`),
    new RegExp(`/(?:videos|reel)/(${POST_ID})`),
    new RegExp(`[?&]v=(${POST_ID})`),
    new RegExp(`[?&]fbid=(${POST_ID})`),
  ];
  const ATTACHMENT_ID_FROM = 4;
  const VIDEO_HREF_PATTERN = new RegExp(`/(?:videos|reel)/${POST_ID}|[?&]v=${POST_ID}`);
  const BARE_POST_ID_PATTERN = new RegExp(`^${POST_ID}$`);
  const OWN_ID_FROM = ATTACHMENT_ID_FROM;
  const PAGE_ID_EVENT = "fbgs:tag-posts";
  const UNIT_ATTRIBUTE = "data-fbgs-unit";
  const POST_URL_PATTERN =
    /\/(?:groups\/[^/]+\/(?:posts|permalink)\/|permalink\.php|story\.php|photo(?:\.php)?\/|watch\/?\?v=|videos\/|reel\/)/;
  const PROFILE_URL_PATTERN = /facebook\.com\/(?:profile\.php\?id=\d+|groups\/[^/]+\/user\/\d+|[A-Za-z0-9.\-]+\/?(?:\?|$))/;
  const COMMENT_HREF_PATTERN = /comment_id=|\/comment\//;
  const COMMENT_ID_PATTERN = /comment_id=(\d+)/g;
  const MORE_COMMENTS_PATTERN =
    /(view|see)\s+(all|more|previous|[\d.,]+[km]?)\s*(more\s+)?comments?|more comments|previous comments/i;
  // "View 1 reply", "View all 4 replies", "3 previous replies", "View more replies".
  const MORE_REPLIES_PATTERN =
    /(view|see)\s+(all\s+)?([\d.,]+[km]?\s+)?(more\s+|previous\s+)?repl(y|ies)|[\d.,]+[km]?\s+(more\s+|previous\s+)?repl(y|ies)/i;
  const HIDDEN_COMMENTS_PATTERN =
    /(view|see|show)\s+(all\s+)?([\d.,]+[km]?\s+)?hidden\s+(comments?|repl(y|ies))|[\d.,]+[km]?\s+hidden\s+(comments?|repl(y|ies))/i;
  const COMMENT_ORDER_TRIGGER_PATTERN =
    /^(most relevant|top comments|all comments|newest|most recent|sorted by)\b/i;
  const COMMENT_ORDER_LABEL_PATTERN = /sort(ed)? by|comment (filter|order|sort)|sort comments/i;
  // Aria names often prefix the same words ("Selected: Most relevant").
  const COMMENT_ORDER_ARIA_PATTERN =
    /\b(most relevant|top comments|all comments|newest|most recent|sorted by)\b/i;
  const COMMENT_ORDER_CHOICES = {
    newest: [/^newest\b/i, /^most recent\b/i, /^all comments\b/i],
    all: [/^all comments\b/i, /^newest\b/i],
    relevant: [/^most relevant\b/i, /^top comments\b/i],
  };
  const FEED_ORDER_TRIGGER_PATTERN = /^(most relevant|recent activity|new activity|new posts|top listings|recent listing activity|new listings|nearby listings)$/i;
  const FEED_ORDER_LABEL_PATTERN = /^sort(\s|$)|sort group posts|sort group listings/i;
  const FEED_ORDER_CHOICES = {
    new: [/^new posts$/i, /^new listings$/i],
    activity: [/^recent activity$/i, /^new activity$/i, /^recent listing activity$/i],
    relevant: [/^most relevant$/i, /^top listings$/i],
  };
  // One reaction's own tally on the pile, e.g. "Like: 1 person", "Love: 12 people".
  const REACTION_TALLY_PATTERN =
    /^(?:like|love|care|haha|wow|sad|angry):\s*([\d.,]+\s*[KkMm]?)\s*(?:person|people)\b/i;
  const COMMENT_COUNT_PATTERN = /([\d.,]+\s*[KkMm]?)\s*comments?\b/i;
  const COUNT_BUTTON_LABELS = [
    ["likes", /reaction|^like:|^like$/i],
    ["comments", /^(?:leave a )?comments?$/i],
    ["shares", /^(?:share|send this to friends)/i],
    ["views", /\bviews?\b/i],
  ];
  const TOMBSTONE_PATTERN =
    /this content isn.t available right now|when this happens, it.s usually because the owner/i;
  // The control Facebook renders where it has truncated a post or a comment.
  const SEE_MORE_PATTERN = /^see more$/i;
  const CLICKABLE_SELECTOR =
    '[role="button"], [role="link"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"], [aria-haspopup], [tabindex]';
  const MENU_SELECTOR =
    '[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"], [role="option"]';
  // First path segment of a facebook.com URL that is a feature, not a username.
  const RESERVED_PATH_SEGMENTS = new Set([
    "groups",
    "profile.php",
    "permalink.php",
    "story.php",
    "photo",
    "photo.php",
    "watch",
    "reel",
    "videos",
    "hashtag",
    "events",
    "marketplace",
    "pages",
    "people",
    "search",
  ]);

  globalThis.__fbGroupPatterns = Object.freeze({
    VERSION,
    PLATFORM,
    SCHEMA_VERSION,
    EXTRACTOR_VERSION,
    POST_ID,
    GROUP_POST_PATTERN,
    POST_ID_PATTERNS,
    ATTACHMENT_ID_FROM,
    VIDEO_HREF_PATTERN,
    BARE_POST_ID_PATTERN,
    OWN_ID_FROM,
    PAGE_ID_EVENT,
    UNIT_ATTRIBUTE,
    POST_URL_PATTERN,
    PROFILE_URL_PATTERN,
    COMMENT_HREF_PATTERN,
    COMMENT_ID_PATTERN,
    MORE_COMMENTS_PATTERN,
    MORE_REPLIES_PATTERN,
    HIDDEN_COMMENTS_PATTERN,
    COMMENT_ORDER_TRIGGER_PATTERN,
    COMMENT_ORDER_LABEL_PATTERN,
    COMMENT_ORDER_ARIA_PATTERN,
    COMMENT_ORDER_CHOICES,
    FEED_ORDER_TRIGGER_PATTERN,
    FEED_ORDER_LABEL_PATTERN,
    FEED_ORDER_CHOICES,
    REACTION_TALLY_PATTERN,
    COMMENT_COUNT_PATTERN,
    COUNT_BUTTON_LABELS,
    TOMBSTONE_PATTERN,
    SEE_MORE_PATTERN,
    CLICKABLE_SELECTOR,
    MENU_SELECTOR,
    RESERVED_PATH_SEGMENTS,
  });
})();
