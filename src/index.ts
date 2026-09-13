/**
 * SearXNG-backed `WebSearchProvider` plugin. It registers a provider into the
 * `ctx.web` registry (the web capability seam) without owning the service.
 * SearXNG is a free, privacy-respecting metasearch engine you self-host (or
 * use a public instance of); the JSON search endpoint needs no API key for a
 * self-hosted instance with `formats: [html, json]` and the limiter off.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 * @see {@link https://docs.searxng.org/ | SearXNG documentation}
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_CATEGORIES,
  SEARXNG_DEFAULT_LANGUAGE,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SearxngSearchProvider,
} from './provider.ts'
import type { SearxngSearchProviderOptions, SearxngTimeRange } from './provider.ts'

export {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_DEFAULT_CATEGORIES,
  SEARXNG_DEFAULT_LANGUAGE,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type { SearxngSearchProviderOptions, SearxngTimeRange } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Environment variable naming this provider's SearXNG instance base URL. */
export const SEARXNG_BASE_URL_ENV = 'SEARXNG_BASE_URL'
/** Environment variable naming an optional bearer token (authed instances). */
export const SEARXNG_API_KEY_ENV = 'SEARXNG_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /**
   * SearXNG instance base URL (the `/search` path is appended). Falls back to
   * `$SEARXNG_BASE_URL`, then the local default. Required at runtime.
   */
  baseURL?: string
  /** Comma-separated result categories. Defaults to `general`. */
  categories?: string
  /** Language code (`en`, `de`, `all`, …). Defaults to `all`. */
  language?: string
  /** Safe-search level: 0 None, 1 Moderate, 2 Strict. */
  safesearch?: 0 | 1 | 2
  /** Restrict to a time range. */
  timeRange?: SearxngTimeRange
  /** Page number (1-based). */
  pageno?: number
  /**
   * Optional bearer token for instances behind an authenticated reverse proxy.
   * Empty/absent → unauthenticated; redirects are then followed.
   */
  apiKey?: string
  /** Per-request timeout in milliseconds. Defaults to 15000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  categories: z.string(),
  language: z.string(),
  safesearch: z.union([0, 1, 2] as const),
  timeRange: z.union(['day', 'week', 'month', 'year'] as const),
  pageno: z.number().step(1).min(1),
  apiKey: z.string().role('secret'),
  timeoutMs: z.number().step(1).min(1),
})

/**
 * Project the resolved config into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted. `launchEnvironmentOf`
 * honors the project/user `.env` planes in a full dsh boot and falls back to
 * `process.env` in a bare process.
 *
 * @param ctx - plugin context supplying the environment plane.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): SearxngSearchProviderOptions {
  const baseURL = config.baseURL ?? launchEnvironmentOf(ctx).get(SEARXNG_BASE_URL_ENV)?.value ?? SEARXNG_DEFAULT_BASE_URL
  const apiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : launchEnvironmentOf(ctx).get(SEARXNG_API_KEY_ENV)?.value
  return {
    baseURL,
    categories: config.categories !== undefined && config.categories.length > 0 ? config.categories : SEARXNG_DEFAULT_CATEGORIES,
    language: config.language !== undefined && config.language.length > 0 ? config.language : SEARXNG_DEFAULT_LANGUAGE,
    ...config.safesearch !== undefined ? { safesearch: config.safesearch } : {},
    ...config.timeRange !== undefined ? { timeRange: config.timeRange } : {},
    ...config.pageno !== undefined ? { pageno: config.pageno } : {},
    ...apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {},
    timeoutMs: config.timeoutMs ?? SEARXNG_DEFAULT_TIMEOUT_MS,
  }
}

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider(resolveOptions(ctx, config)))
}
