/**
 * lib/categories.ts
 *
 * The 13 hardcoded Polymarket categories Kreopoly exposes as turnkey filters.
 *
 * Source: Polymarket's public Gamma API /markets endpoint exposes a `category`
 * field per market. These 13 are the highest-volume categories that Kreopoly
 * enables as toggleable filters in their bot UI.
 *
 * Slugs match Polymarket's public category strings exactly.
 */

export interface Category {
  /** Polymarket's category slug (used in API filters) */
  slug: string;
  /** Human-readable label */
  label: string;
}

export const POLYMARKET_CATEGORIES: readonly Category[] = [
  { slug: "politics", label: "Politics" },
  { slug: "crypto", label: "Crypto" },
  { slug: "sports", label: "Sports" },
  { slug: "pop-culture", label: "Pop Culture" },
  { slug: "business", label: "Business" },
  { slug: "economics", label: "Economics" },
  { slug: "geopolitics", label: "Geopolitics" },
  { slug: "science", label: "Science" },
  { slug: "tech", label: "Technology" },
  { slug: "ai", label: "AI" },
  { slug: "climate", label: "Climate" },
  { slug: "entertainment", label: "Entertainment" },
  { slug: "legal", label: "Legal" },
] as const;

export const CATEGORY_SLUGS: readonly string[] = POLYMARKET_CATEGORIES.map(
  (c) => c.slug
);

export function isValidCategory(slug: string): boolean {
  return CATEGORY_SLUGS.includes(slug);
}
