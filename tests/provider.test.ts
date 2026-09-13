/**
 * Behavior tests for the SearXNG search provider. The mapping and availability
 * checks are pure (no network). The `search()` path runs against a throwaway
 * local HTTP server that returns canned SearXNG JSON, so the suite stays
 * hermetic and keyless.
 *
 * Run with: `pnpm test` or `npm test` (uses node:test + tsx).
 * @module tests/provider.test
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { SEARXNG_PROVIDER_ID, SearxngSearchProvider, mapSearxngResponse, mapSearxngResult } from '../src/provider.ts'
import type { SearxngResult, SearxngSearchResponse } from '../src/types.ts'

describe('mapSearxngResult', () => {
  it('maps url, title, content, and publishedDate', () => {
    const result: SearxngResult = {
      url: 'https://example.com/a',
      title: 'Alpha',
      content: 'A snippet about alpha.',
      publishedDate: '2024-01-02T03:04:05Z',
      engine: 'google',
      category: 'general',
      score: 1.0,
    }
    assert.deepEqual(mapSearxngResult(result), {
      url: 'https://example.com/a',
      title: 'Alpha',
      snippet: 'A snippet about alpha.',
      publishedAt: '2024-01-02T03:04:05Z',
    })
  })

  it('drops entries with no url', () => {
    assert.equal(mapSearxngResult({ url: '', title: 'x' }), undefined)
    assert.equal(mapSearxngResult({ title: 'x' }), undefined)
  })

  it('omits empty title/content/publishedDate rather than inventing them', () => {
    assert.deepEqual(mapSearxngResult({ url: 'https://example.com/b', title: '', content: null, publishedDate: undefined }), {
      url: 'https://example.com/b',
    })
  })
})

describe('mapSearxngResponse', () => {
  it('keeps citeable sources and drops url-less ones', () => {
    const response: SearxngSearchResponse = {
      results: [
        { url: 'https://example.com/1', title: 'One', content: 'first' },
        { url: '', title: 'dropped' },
        { url: 'https://example.com/2', title: 'Two', content: 'second', publishedDate: '2024-02-01T00:00:00Z' },
      ],
      number_of_results: 2,
    }
    const mapped = mapSearxngResponse(response)
    assert.equal(mapped.sources.length, 2)
    assert.equal(mapped.truncated, false)
    assert.equal(mapped.content, undefined)
    assert.equal(mapped.sources[0].url, 'https://example.com/1')
    assert.equal(mapped.sources[1].snippet, 'second')
  })

  it('returns no sources when the instance returns none', () => {
    assert.deepEqual(mapSearxngResponse({ results: [] }), { sources: [], truncated: false })
    assert.deepEqual(mapSearxngResponse({}), { sources: [], truncated: false })
  })
})

describe('SearxngSearchProvider.available', () => {
  it('is available with a valid base URL and no key', () => {
    assert.equal(new SearxngSearchProvider({ baseURL: 'http://localhost:8080' }).available(), true)
  })

  it('rejects an unparseable base URL', () => {
    assert.equal(new SearxngSearchProvider({ baseURL: 'not a url' }).available(), false)
    assert.equal(new SearxngSearchProvider({ baseURL: '' }).available(), false)
  })

  it('rejects invalid timeout / pageno / safesearch', () => {
    assert.equal(new SearxngSearchProvider({ baseURL: 'http://x', timeoutMs: 0 }).available(), false)
    assert.equal(new SearxngSearchProvider({ baseURL: 'http://x', pageno: 0 }).available(), false)
    assert.equal(new SearxngSearchProvider({ baseURL: 'http://x', safesearch: 3 as 0 }).available(), false)
  })

  it('id is stable', () => {
    assert.equal(new SearxngSearchProvider({ baseURL: 'http://x' }).id, SEARXNG_PROVIDER_ID)
  })
})

describe('SearxngSearchProvider.search (mocked HTTP)', () => {
  let server: Server
  let baseURL: string
  let lastUrl: string | undefined

  before(async () => {
    server = createServer((req, res) => {
      lastUrl = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        query: 'deepseek',
        number_of_results: 1,
        results: [
          { url: 'https://example.com/deepseek', title: 'DeepSeek', content: 'DeepSeek is an AI lab.', publishedDate: '2024-03-01T00:00:00Z' },
        ],
      } satisfies SearxngSearchResponse))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const port = typeof address === 'object' ? address.port : 0
    baseURL = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('sends format=json and returns normalized sources', async () => {
    const provider = new SearxngSearchProvider({ baseURL, categories: 'general', language: 'en' })
    const result = await provider.search({ query: 'deepseek', maxResults: 5 })
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].url, 'https://example.com/deepseek')
    assert.equal(result.sources[0].title, 'DeepSeek')
    assert.equal(result.sources[0].snippet, 'DeepSeek is an AI lab.')
    assert.ok(lastUrl !== undefined && lastUrl.includes('format=json'), 'must request JSON format')
    assert.ok(lastUrl !== undefined && lastUrl.includes('q=deepseek'), 'must carry the query')
    assert.ok(lastUrl !== undefined && lastUrl.includes('categories=general'), 'must carry categories')
    assert.ok(lastUrl !== undefined && lastUrl.includes('language=en'), 'must carry language')
  })

  it('throws WEB_PROVIDER_ERROR on a non-2xx response', async () => {
    const failing = createServer((req, res) => { res.writeHead(503); res.end('upstream down') })
    await new Promise<void>(resolve => failing.listen(0, '127.0.0.1', resolve))
    const address = failing.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const provider = new SearxngSearchProvider({ baseURL: `http://127.0.0.1:${port}` })
    await assert.rejects(() => provider.search({ query: 'x' }), (err: unknown) => {
      const code = (err as { code?: string }).code
      assert.equal(code, 'WEB_PROVIDER_ERROR')
      return true
    })
    await new Promise<void>(resolve => failing.close(() => resolve()))
  })

  it('honors a caller abort as WEB_ABORTED', async () => {
    const slow = createServer((_req, res) => { setTimeout(() => res.end('{}'), 5000) })
    await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve))
    const address = slow.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const provider = new SearxngSearchProvider({ baseURL: `http://127.0.0.1:${port}` })
    const controller = new AbortController()
    const promise = provider.search({ query: 'x' }, controller.signal)
    controller.abort()
    await assert.rejects(promise, (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'WEB_ABORTED')
      return true
    })
    await new Promise<void>(resolve => slow.close(() => resolve()))
  })

  it('rejects redirects when an apiKey is configured', async () => {
    const redirecting = createServer((req, res) => {
      if (req.url !== undefined && req.url.includes('format=json')) {
        res.writeHead(302, { location: '/elsewhere?format=json' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [] } satisfies SearxngSearchResponse))
    })
    await new Promise<void>(resolve => redirecting.listen(0, '127.0.0.1', resolve))
    const address = redirecting.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const provider = new SearxngSearchProvider({ baseURL: `http://127.0.0.1:${port}`, apiKey: 'secret' })
    await assert.rejects(() => provider.search({ query: 'x' }), (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'WEB_PROVIDER_ERROR')
      return true
    })
    await new Promise<void>(resolve => redirecting.close(() => resolve()))
  })
})
