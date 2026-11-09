/**
 * Social post links as one post, and the platform a link is on (0.23.0, docket#107). A leaf
 * module: `research-answer.ts` canonicalises every source through it when it parses an answer, so
 * a repost's `youtu.be` link and the watch page it points at are one source, and
 * `research-social.ts` builds the prompt rules and the belts on it. Only links on the four
 * phase-1 platforms are touched; any other URL is returned as it came, since its query may matter.
 */

/**
 * The platforms a `web` first pass may search for posts (docs/social-sources.md, decision 3:
 * YouTube, Bluesky, TikTok and Instagram; X skipped, Reddit blocked, Threads later).
 */
export const SOCIAL_PLATFORMS = ["youtube", "tiktok", "instagram", "bluesky"] as const

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value)
}

/** How a platform is named in a DM; an id not listed is shown as given. */
const NAMES: Readonly<Record<string, string>> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  bluesky: "Bluesky",
  reddit: "Reddit",
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
  pinterest: "Pinterest",
  mastodon: "Mastodon",
}

export function platformName(id: string): string {
  return NAMES[id.toLowerCase()] ?? id
}

const HOSTS: readonly { platform: SocialPlatform; host: RegExp }[] = [
  { platform: "youtube", host: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/ },
  { platform: "tiktok", host: /(^|\.)tiktok\.com$/ },
  { platform: "instagram", host: /(^|\.)(instagram\.com|instagr\.am)$/ },
  { platform: "bluesky", host: /(^|\.)(bsky\.app|bsky\.social)$/ },
]

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "")
}

/** The platform a link is a post, channel or profile on, by its host; null for any other page. */
export function platformOf(url: string): SocialPlatform | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = hostOf(u)
  return HOSTS.find((h) => h.host.test(host))?.platform ?? null
}

/** A YouTube video id: 11 URL-safe characters (the provider's own pattern). */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * Query parameters that track a link's sharing, not the post it points at: YouTube's `si`, `t`,
 * `feature` and `pp`, Instagram's `igsh`, TikTok's share fields, Meta's and Google's click ids,
 * and every `utm_*`.
 */
const TRACKING =
  /^(utm_.*|si|t|feature|pp|ab_channel|igsh|igshid|img_index|fbclid|gclid|ref|ref_src|_r|_t|is_from_webapp|sender_device|sender_web_id|web_id|lang|is_copy_url|checksum|sec_uid|share_app_id|share_link_id|source|u_code|timestamp|user_id|tt_from)$/i

/**
 * `u` without its hash or credentials, on `host`, its path without an end slash; with `query`,
 * its tracking parameters dropped and the rest kept, otherwise no query at all.
 */
function stripped(u: URL, host: string, query: boolean): string {
  const out = new URL(u.toString())
  out.hostname = host
  out.hash = ""
  out.username = ""
  out.password = ""
  if (query) {
    for (const key of [...out.searchParams.keys()]) {
      if (TRACKING.test(key)) out.searchParams.delete(key)
    }
  } else {
    out.search = ""
  }
  out.pathname = out.pathname.replace(/\/+$/, "") || "/"
  return out.toString()
}

/**
 * A social post link as one post (docket#107: a repost or a copied link counts once). YouTube:
 * `youtu.be/<id>`, `/shorts/<id>`, `/live/<id>`, `/embed/<id>`, `/v/<id>` and `/watch?v=<id>` on
 * any YouTube host are `https://www.youtube.com/watch?v=<id>`. Instagram: `/p/`, `/reel/`,
 * `/reels/` and `/tv/` share one shortcode space, so a post is
 * `https://www.instagram.com/p/<code>/`. TikTok: a `/@user/video/<id>` (or `/photo/`) page on
 * `www.tiktok.com` without its query; a short `vm.tiktok.com` link cannot be resolved here and is
 * kept without its query. Bluesky: the post page without its hash or query. Any other link on
 * these hosts loses its hash and tracking parameters only; a link anywhere else is returned
 * unchanged, since its query may be part of the page.
 */
export function canonicalSocialUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const platform = platformOf(url)
  if (!platform) return url
  const host = hostOf(u)
  const path = u.pathname
  if (platform === "youtube") {
    let id: string | null = null
    if (/(^|\.)youtu\.be$/.test(host)) id = path.split("/")[1] ?? null
    else if (path === "/watch") id = u.searchParams.get("v")
    else id = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(path)?.[1] ?? null
    if (id && VIDEO_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`
    return stripped(u, host, true)
  }
  if (platform === "instagram") {
    const code = /^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(path)?.[1]
    if (code) return `https://www.instagram.com/p/${code}/`
    return stripped(u, host, false)
  }
  if (platform === "tiktok") {
    const post = /^\/(@[^/]+)\/(video|photo)\/(\d+)/.exec(path)
    if (post) return `https://www.tiktok.com/${post[1]}/${post[2]}/${post[3]}`
    return stripped(u, host, false)
  }
  return stripped(u, host, false)
}
