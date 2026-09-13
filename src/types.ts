/**
 * Wire types for the SearXNG search endpoint (`GET {baseURL}/search?format=json`).
 * Types only — no runtime code. SearXNG returns a flat `results[]`; each entry
 * carries a `url`, an optional `title`, an optional `content` (the snippet),
 * an optional `publishedDate`, and the engine(s) that produced it.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 * @see {@link https://docs.searxng.org/admin/settings/settings_search.html | SearXNG search settings}
 */

/** One entry of SearXNG's flat `results[]` (JSON output format). */
export interface SearxngResult {
  /** Absolute URL of the result document. */
  url: string
  /** Result title as returned by the source engine(s). */
  title?: string | null
  /** Short text snippet / extracted description. */
  content?: string | null
  /** Publication timestamp as the engine reported it (often ISO-8601). */
  publishedDate?: string | null
  /** Internal engine id(s) that produced this result. */
  engine?: string | string[]
  /** SearXNG result category (`general`, `it`, `images`, …). */
  category?: string
  /** SearXNG relevance score. */
  score?: number
  /** Pretty-printed URL for display. */
  pretty_url?: string
}

/** SearXNG's search response envelope (`format=json`). */
export interface SearxngSearchResponse {
  /** The submitted query string. */
  query?: string
  /** SearXNG's flat result list. */
  results?: SearxngResult[]
  /** SearXNG's estimate of total matching results across engines. */
  number_of_results?: number
  /** Autocomplete suggestions. */
  suggestions?: string[]
  /** Engines that failed to respond in time. */
  unresponsive_engines?: Array<[string, string]>
}

/** SearXNG's error response (best-effort; fields vary by failure). */
export interface SearxngError {
  error?: string
  message?: string
}
