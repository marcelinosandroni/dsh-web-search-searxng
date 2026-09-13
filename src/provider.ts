/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a self-hosted (or
 * remote) SearXNG instance's JSON search endpoint (`GET {baseURL}/search?format=json`).
 * It maps each SearXNG result to the seam's portable `WebSearchSource`: `url`
 * → `url`, `title` → `title`, `content` → `snippet`, `publishedDate` →
 * `publishedAt`, and drops entries with no usable URL. SearXNG returns no
 * generated answer, so `content` (the answer text) is omitted.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  SearxngError,
  SearxngResult,
  SearxngSearchResponse,
} from './types.ts'

/** Stable id this provider registers under (the web seam's search capability). */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Default SearXNG endpoint base. The `/search` path is appended. This is a
 * convenience default for a local install; production deployments should set
 * `baseURL` explicitly (config or `$SEARXNG_BASE_URL`).
 */
export const SEARXNG_DEFAULT_BASE_URL = 'http://localhost:8080'

/** SearXNG category queried when none is configured. */
export const SEARXNG_DEFAULT_CATEGORIES = 'general'

/** SearXNG language queried when none is configured (`all` = no language filter). */
export const SEARXNG_DEFAULT_LANGUAGE = 'all'

/** Default request timeout in milliseconds (SearXNG fans out to many engines). */
export const SEARXNG_DEFAULT_TIMEOUT_MS = 15_000

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness-dsh-web-search-searxng/0.1.0'

/** SearXNG `time_range` values. */
export type SearxngTimeRange = 'day' | 'week' | 'month' | 'year'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface SearxngSearchProviderOptions {
  /** SearXNG instance base URL; `/search` is appended. Required. */
  baseURL: string
  /** Comma-separated result categories (`general`, `it`, `images`, `news`, …). */
  categories?: string
  /** Language code (`en`, `de`, `all`, …). */
  language?: string
  /** Safe-search level: 0 None, 1 Moderate, 2 Strict. */
  safesearch?: 0 | 1 | 2
  /** Restrict to a time range. */
  timeRange?: SearxngTimeRange
  /** Page number (1-based). */
  pageno?: number
  /**
   * Optional bearer token for instances behind an authenticated reverse proxy.
   * When set, redirects are rejected (credentials must not auto-forward).
   */
  apiKey?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it has
 * no usable URL (an entry without a URL cannot be cited, and the seam has no
 * other field to derive one from).
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (result.url === undefined || result.url.length === 0) return undefined
  return {
    url: result.url,
    ...isNonEmpty(result.title) ? { title: result.title } : {},
    ...isNonEmpty(result.content) ? { snippet: result.content } : {},
    ...isNonEmpty(result.publishedDate) ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result. Drops URL-less
 * entries ({@link mapSearxngResult}). SearXNG returns no generated answer, so
 * `content` is omitted. The web service owns the final `maxResults`
 * truncation, so this provider reports `truncated: false`.
 *
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result with citeable sources.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: false }
}

/**
 * The SearXNG-backed search provider. Credentialed requests (when `apiKey` is
 * set) reject redirects so credentials cannot auto-forward to another origin;
 * unauthenticated requests follow redirects so a self-hosted instance's benign
 * `/ → /search` or `http → https` redirects keep working.
 */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.baseURL)
      && (this.options.categories === undefined || this.options.categories.length > 0)
      && (this.options.timeoutMs === undefined || isPositiveInteger(this.options.timeoutMs))
      && (this.options.pageno === undefined || (isPositiveInteger(this.options.pageno)))
      && (this.options.safesearch === undefined || [0, 1, 2].includes(this.options.safesearch))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const url = this.buildSearchUrl(request)
    const controller = combineSignals(this.options.timeoutMs, signal)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: this.options.apiKey !== undefined && this.options.apiKey.length > 0 ? 'error' : 'follow',
        headers: {
          ...this.options.apiKey !== undefined && this.options.apiKey.length > 0
            ? { 'authorization': `Bearer ${this.options.apiKey}` }
            : {},
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...controller.signal !== undefined ? { signal: controller.signal } : {},
      })
    } catch (error: unknown) {
      controller.dispose()
      if (isAbortError(error) || signal?.aborted === true) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    controller.dispose()

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG API error (HTTP ${status})`
      try {
        const parsed = await response.json() as SearxngError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error) || signal?.aborted === true) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body can only cost a richer provider message.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error) || signal?.aborted === true) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Build the SearXNG `GET /search` URL for one request.
   * @param request - the query and optional result limit (used only as a hint; SearXNG has no server-side result count, the seam enforces the bound on return).
   * @returns the absolute search URL.
   */
  private buildSearchUrl(request: WebSearchRequest): string {
    const params = new URLSearchParams()
    params.set('q', request.query)
    params.set('format', 'json')
    if (this.options.categories !== undefined && this.options.categories.length > 0) {
      params.set('categories', this.options.categories)
    }
    if (this.options.language !== undefined && this.options.language.length > 0) {
      params.set('language', this.options.language)
    }
    if (this.options.safesearch !== undefined) {
      params.set('safesearch', String(this.options.safesearch))
    }
    if (this.options.timeRange !== undefined) {
      params.set('time_range', this.options.timeRange)
    }
    if (this.options.pageno !== undefined) {
      params.set('pageno', String(this.options.pageno))
    }
    return `${this.options.baseURL.replace(/\/$/, '')}/search?${params.toString()}`
  }
}

/** True for a non-empty trimmed string or non-null value. */
function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** True for a positive whole number. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Combined timeout + caller abort signal with explicit disposal. */
interface CombinedSignal {
  readonly signal: AbortSignal | undefined
  dispose(): void
}

/**
 * Combine a per-request timeout with the caller's abort signal. Uses
 * `AbortSignal.any`/`AbortSignal.timeout` when available (Node ≥ 20.3);
 * otherwise falls back to a manual controller. The returned `dispose()`
 * must be called once the request settles so a pending timeout cannot fire
 * after the operation completes.
 *
 * @param timeoutMs - optional timeout in milliseconds.
 * @param callerSignal - optional caller abort signal.
 * @returns the combined signal and disposer.
 */
function combineSignals(timeoutMs: number | undefined, callerSignal?: AbortSignal): CombinedSignal {
  if (timeoutMs === undefined && callerSignal === undefined) {
    return { signal: undefined, dispose() {} }
  }
  const signals: AbortSignal[] = []
  if (callerSignal !== undefined) signals.push(callerSignal)
  let timeoutController: AbortController | undefined
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController?.abort(new DOMException('SearXNG search timed out', 'TimeoutError')), timeoutMs)
    // Allow the Node process to exit even if the timer is pending.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref()
    }
    signals.push(timeoutController.signal)
  }
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  const signal = signals.length === 0
    ? undefined
    : signals.length === 1
      ? signals[0]
      : typeof anyFn === 'function'
        ? anyFn(signals)
        : manualAny(signals)
  return {
    signal,
    dispose() {
      if (timeoutController !== undefined && !timeoutController.signal.aborted) {
        timeoutController.abort(new DOMException('SearXNG search settled', 'AbortError'))
      }
    },
  }
}

/** Manual fallback for `AbortSignal.any` on runtimes that lack it. */
function manualAny(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}
