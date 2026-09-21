/** One scrape of one post. The grain is the post, never the group. */
export interface EngagementResult {
  captureId: string;
  platform: "facebook_group";
  sourceUrl: string;
  /** ISO-8601 with offset. */
  scrapedAt: string;

  /** `full` once comments were collected, `fast` when they were skipped. */
  phase?: "fast" | "full" | null;
  schemaVersion?: number | null;
  extractorVersion?: string | null;
  externalVideoId?: string | null;
  group?: {
    externalId: string;
    name?: string | null;
    url?: string | null;
  } | null;

  author?: {
    /** Vanity slug, or the numeric profile id when that is all the URL gives. */
    handle?: string | null;
    displayName?: string | null;
    profileUrl?: string | null;
    /** `true` on a badge, `null` when absent — absence is unknown, not false. */
    verified?: boolean | null;
  } | null;

  post?: {
    caption?: string | null;
    /** Without the leading `#`. */
    hashtags?: string[] | null;
    publishedAt?: string | null;
    hasVideo?: boolean | null;
    thumbnailUrl?: string | null;
    /** Reels and videos only, and only once playback has begun. */
    durationSeconds?: number | null;
    /** Reels only; group posts have no sound attribution to read. */
    soundName?: string | null;
  } | null;

  metrics?: {
    /** Total reactions, not just the "like" reaction. */
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    views?: number | null;
    /** Never exposed to a visitor on Facebook. */
    saves?: number | null;
  } | null;

  comments?: EngagementResultComment[];

  /** False whenever a cap or an unclicked "view more comments" cut the thread short. */
  commentsComplete?: boolean;
  /** `field:reason` codes for everything that fell back or failed. */
  warnings?: string[];
}

export interface EngagementResultComment {
  externalCommentId?: string | null;
  /** The commenter's display name; Facebook exposes no handle in a thread. */
  authorHandle?: string | null;
  text: string;
  likes?: number | null;
  /** ISO-8601 when the DOM gave an absolute date, otherwise the raw label. */
  publishedAt?: string | null;
}

/** The input `ingest_engagement` takes, and what the popup exports. */
export interface EngagementExport {
  captures: EngagementResult[];
}
