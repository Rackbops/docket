import { BGG_ATTRIBUTION } from "./want-bgg.js"
import { EBAY_ATTRIBUTION } from "./want-ebay.js"
import { SHOPIFY_ATTRIBUTION } from "./want-shopify.js"
import type { SourceId } from "./want-sources.js"

/**
 * What a want-list watch says about its source, one row per source (docket#68), so a new source
 * is one row here rather than four ternaries across the want types.
 */
export interface SourceText {
  /** Shown after each listing line, as the source's terms ask; none for a page or the inbox. */
  attribution: string | null
  /** Where nothing could be read, in the warning; null for a page, which names its address. */
  where: string | null
  /** What this bot lacks when the host configured no such source. */
  missing: string
  /** Where the listings came from, as the judge is told. */
  judgeWhere: string
}

export const SOURCE_TEXT: Readonly<Record<SourceId, SourceText>> = {
  page: {
    attribution: null,
    where: null,
    missing: "such source",
    judgeWhere: "a shop page they gave",
  },
  bgg: {
    attribution: BGG_ATTRIBUTION,
    where: "BoardGameGeek",
    missing: "BoardGameGeek access",
    judgeWhere: "BoardGameGeek's marketplace",
  },
  inbox: {
    attribution: null,
    where: "what was sent in",
    missing: "such source",
    judgeWhere: "alert emails and searches sent in for them (from eBay, BoardGameGeek or a shop)",
  },
  shopify: {
    attribution: SHOPIFY_ATTRIBUTION,
    where: "Shopify's store search",
    missing: "Shopify search (no Firecrawl key)",
    judgeWhere: "a search of Shopify stores' catalogs (new copies in stock)",
  },
  ebay: {
    attribution: EBAY_ATTRIBUTION,
    where: "eBay's search",
    missing: "eBay search (no eBay keys)",
    judgeWhere: "a search of eBay's listings, through eBay's own API",
  },
}

/** The row for `source`; a page's for a source this release does not know (a stored watch). */
export function sourceText(source: string): SourceText {
  return SOURCE_TEXT[source as SourceId] ?? SOURCE_TEXT.page
}
