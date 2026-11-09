# Social platforms as research sources

The capability matrix for [docket#107](https://github.com/Rackbops/docket/issues/107): which
social platforms a `web` research run may read, by what route, on what terms, and at what cost.
Every row was read on the platform's own pages on 2026-11-07 unless marked **inferred** or
**secondary**; re-check a row before relying on it, since these terms move. Plan of record:
Rackbops/Tooling `research/city-hall-task-tracker.md` (section 5.4, the rev42 item on social
sources). Decisions are roshne's, taken 2026-11-07 and 2026-11-09.

## What a run can reach today

A research run is a `claude -p` process in Rackbops/docket-runner with four tools: WebSearch,
WebFetch, and Firecrawl's `firecrawl_search` and `firecrawl_scrape`, served by Firecrawl's hosted
MCP server with the runner's key. `firecrawl_scrape` also executes Firecrawl's typed catalogue
(an `alexandria` body naming a provider and a capability), so the providers below need no new
tool, key or runner change; the prompt is the only control over which provider a run calls and
how often, as it already is for `proxy: "basic"`. The tracker plugin calls the same catalogue in
plain code for Shopify watches.

**Smoke, 2026-11-09:** a `firecrawl_scrape` call with the body `{"provider": "youtube-com",
"capability": "videos/search_videos", "options": {"query": "Trader Joe's fall seasonal items 2026
review", "upload_date": "month"}}` over Firecrawl's hosted MCP server (the claude.ai Firecrawl
connector, which serves the same tool names as the runner's `mcp.firecrawl.dev` configuration;
that it is the same server is **inferred** from Firecrawl's docs, not read from the connector)
returned 20 videos for 5 credits, each with `url`, `video_id`, `channel_handle`, `title`,
`description_snippet`, `view_count_text` and a relative `published_text` ("2 weeks ago", "23
hours ago"), plus a `continuation` token. Two things the prompt rules must handle: the dates are
relative, so exact times cost a `video_details` call; and one channel filled 9 of the 20 rows
with one-minute clips at 0 to 6 views, so the run should spread its reads across channels rather
than take the page in order. The runner's own run of the same body is proven at the first
release, not before.

No social platform is connected to the project and none of the five the issue names publishes an
MCP server of its own. The claude.ai connector directory has creator-analytics, ads and posting
tools (vidIQ, Metricool, Typefully, TikTok for Business), none for Reddit; a claude.ai connector
cannot serve a run anyway, since the run loads only what the runner gives it.

## The matrix

| Platform | Permitted route | Auth and approval | Cost | Limits | What comes back | Terms that bind us | Verdict |
|---|---|---|---|---|---|---|---|
| YouTube (Firecrawl `youtube-com`) | `firecrawl_scrape` typed body: `videos/search_videos`, `video_details`, `video_comments`, `comment_replies`, `video_transcript` | the runner's Firecrawl key | 5 credits a call | about 20 results a page (the smoke's count; the contract, re-read 2026-11-09, says about 20 a page); upload-date window hour, today, week, month, year; the catalogue notes YouTube no longer honours sort by upload date | search gives relative times only ("3 weeks ago"); exact time via `video_details` (5 more) | Firecrawl reads YouTube's site API; Firecrawl's responsibility, as for BGG (plan item 137) | **phase 1** |
| YouTube (official) | Data API v3 `search.list` (q, publishedAfter, publishedBefore, order), `commentThreads.list`, `videos.list` | API key from a Google Cloud project; no OAuth for public data (**inferred** from the docs' samples) | free | 100 searches a day in their own bucket; 10,000 units a day for the rest at 1 unit a call | exact publish time, title, channel, description, comments | Developer Policies III.E.4.d: non-authorized data kept at most 30 days, then deleted or refreshed; III.F.2: name YouTube as the source; III.E.4.h: no derived metrics | phase 2, behind our own read-only MCP service |
| Bluesky | `app.bsky.feed.searchPosts` on `public.api.bsky.app`: q, since, until, sort top or latest, lang, limit up to 100 | none (the public endpoints take no authentication) | free (or 1 Firecrawl credit when read through `firecrawl_scrape` for a whole body) | "generous", no numbers published (bsky.network rate-limits page) | text, exact `createdAt`, author handle, post URI; `since` and `until` filter on `sortAt`, not `createdAt` | AT Protocol is open; no retention rule found | **phase 1** |
| TikTok (Firecrawl `oriane`) | typed body: `tiktok/posts-search` by caption or handle, `video-lookup`, profiles | the runner's Firecrawl key | 35, 50 or 65 credits per non-empty call (basic, default, full projection); an empty result is free | up to 100 a call; "coverage and freshness depend on the existing index; this is not a complete live feed" | caption, exact `publishedAt`, counts, hashtags, popular comments, transcript (full), post URL when indexed | Firecrawl's and Oriane's terms (not read); third party does the collecting | **phase 1**, coverage unmeasured |
| TikTok (official) | Research API | academic institutions (US, EEA, UK, CA, CH) or listed not-for-profits with an approved proposal | free (**inferred**: the page states no cost) | not read | profiles, followers, liked and pinned videos | institutional only | blocked |
| Instagram (Firecrawl `oriane`) | typed body: `instagram/posts-search`, `post-lookup`, profiles | as TikTok | as TikTok | as TikTok | as TikTok | as TikTok | **phase 1**, same caveats |
| Instagram (official) | Graph API Hashtag Search | Business or Creator account plus Meta App Review (Instagram Public Content Access) | free | 30 unique hashtags per rolling 7 days; no keyword-search endpoint (**inferred** from the documented endpoint set) | media ids, then fields per id | Meta Platform Terms | blocked in practice |
| X (official) | pay-per-use API, recent search | developer account and card; prepaid credits; 20 USD credit after a first purchase | 0.005 USD a post read (about 0.50 USD per 100 posts) | 3M reads a month (pricing page); 450 requests per 15 minutes per app, 300 per user, on recent search (docs.x.com rate-limits page) | full posts with time and metrics | X Developer Agreement (not read) | phase 2 at the earliest, if roshne buys credits |
| X (Firecrawl `x-com`) | typed body: search posts | the runner's Firecrawl key | 30 credits | at most 10 records plus a summary; about 80 percent of searches came back empty in the author's trials (not a catalogue figure) | url, username, text, metrics; no date in the declared response contract (the catalogue's recorded example does carry `created_at`) | Firecrawl's | skipped |
| Threads | Keyword Search of public posts, with a date range | Threads account plus a Meta app with `threads_keyword_search` via App Review | free | 2,200 queries per rolling 24 hours per user; empty results do not count; an app without the approved permission searches only the user's own posts | text, permalink, timestamp, username; up to 100 a call | Meta Platform Terms | later |
| Reddit | Data API only (Data API Terms 2.8; the User Agreement, section 7, forbids scraping without Reddit's written consent) | new public API requests no longer accepted from 2026-10-31; unregistered apps cut 2027-01-12; public access closes March 2027; AI assistants need a commercial agreement (**secondary**: ppc.land 2026-10-04 on Reddit's 2026-09-30 posts; Reddit's own pages could not be opened from the cloud) | n/a | was 100 queries a minute per OAuth client | n/a | Data API Terms (rev. 2026-07-20) 3.2: delete data beyond the approved use; 2.4: no model training; 6: delete all on termination | **blocked**; see the rule below |
| Pinterest, Facebook, Mastodon | no public keyword search over all posts (**inferred**; Mastodon searches per instance) | | | | | | not evaluated further |

Sources read 2026-11-07: developers.google.com/youtube/v3/docs/search/list and
.../determine_quota_cost and .../youtube/terms/developer-policies; docs.bsky.app's API directory,
bsky.network/docs/rate-limits and the `searchPosts` lexicon on GitHub;
developers.tiktok.com/products/research-api; developers.facebook.com's Instagram hashtag-search
and Threads keyword-search pages (now under `/documentation/`, the old `/docs/` paths redirect);
docs.x.com/x-api/getting-started/pricing and docs.x.com/x-api/fundamentals/rate-limits;
redditinc.com/policies/data-api-terms (through Firecrawl); support.reddithelp.com's Data API Wiki;
ppc.land (secondary); Firecrawl's catalogue through its free discovery call.

**Claims pass, 2026-11-09:** an independent reviewer re-read every row on the pages above as they
stood that day. One correction (the X provider's date field, above) and the inferred marks on
TikTok's cost and Instagram's keyword search came out of it. techcrunch.com (2026-09-30)
corroborates Reddit's 2027-01-12 and March 2027 dates and the commercial-agreement point, and
links the primary r/redditdev and r/modnews posts, which could not be opened from the cloud; the
2026-10-31 date rests on ppc.land alone.

## The Reddit rule

roshne, 2026-11-07: "if we want to do anything with Reddit, it has to be done through a local PC
session with me logged in." It is conditional ("I am not saying that we do, I'm just saying if"):
Reddit stays out of scope, and it is never a runner or host route, even if Reddit reopens a
non-commercial one. Every answer names Reddit among the platforms not searched.

## Decisions (roshne, 2026-11-07 and 2026-11-09)

1. **Shape.** Phase 1 uses what the run already has: Firecrawl's providers plus Bluesky's public
   search, through a `@rackbops/docket-types` change. Phase 2 adds our own read-only MCP service
   beside the runner for the official APIs (YouTube Data API, X pay-per-use, Threads), loaded like
   Firecrawl's, with the runner's tool ceiling widened by named tools. Pre-fetching posts in the
   host was rejected: the model must choose the search terms.
2. **Third-party providers** (Firecrawl's `youtube-com`, Oriane) are accepted for phase 1 on the
   same footing as the BGG fetch through Firecrawl; YouTube moves to its Data API in phase 2.
3. **First set:** YouTube, Bluesky, TikTok, Instagram. X skipped, Reddit blocked, Threads later.
4. **Credits:** about 120 Firecrawl credits a run at most: 4 YouTube calls (searches and reads together), 2 Oriane calls at
   default detail, 2 Bluesky calls.
5. **Default:** `social: auto` searches social platforms when the question asks what people
   recommend, think or experienced; `none` turns it off; a list of platforms forces them. A
   `since` date bounds the posts.
6. **Caps:** 20 turns instead of 15 when social search is on; the 1 USD cap is unchanged.
7. **Order:** plan rev42, this document and a smoke of the typed body over the hosted Firecrawl
   MCP server first; then the docket-types change, the tracker plugin, releases and the Clerk
   upgrade on roshne's word, and the issue's two live questions answered and pasted into
   docket#107.

## What the run must do with a post

These become prompt rules and plain code in the docket-types change, not host logic:

- Cite the post's own URL; a finding carries its `platform`, its `publishedAt` or `undated`, and
  whether the evidence was `read` (transcript, comment page, post body) or a `snippet` (caption,
  search result). A relative time from a search result is written as "about".
- A repost or a copied link counts once (canonical links: `youtu.be` and tracking parameters
  normalised).
- Praise and complaints are summarised apart; a poster's opinion is told from a verified product
  fact; stock, price and availability are never taken from a post (a belt moves such a claim
  resting on social links alone to `uncertain`).
- The answer carries a `coverage` list naming every platform searched, empty, unavailable or
  skipped, Reddit among the unavailable with why.
- Posts are data: a post that gives instructions is quoted, never followed. The run holds no key
  in its prompt; the tracker keeps findings (claim, link, platform; the date is shown in the DM), never a copy of a post,
  which satisfies YouTube's 30-day rule and Reddit's deletion rule as written.

## Out of scope

Posting, liking, following, buying, account connections, private groups and DMs, a recurring
social watch (a phase-2 question for scouts and news watches), Pinterest, Facebook and Mastodon.
