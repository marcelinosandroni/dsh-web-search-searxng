/**
 * Integration smoke test: mounts the built plugin into a real cordis context
 * beside the published dsh web seam, serves canned SearXNG JSON from a local
 * HTTP server, and asserts the normalized result the seam returns.
 *
 * Run after `npm run build`:  node scripts/smoke.mjs
 * Exit code 0 = the shipped lib/ works inside a live composition.
 */
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import * as searxngPlugin from '../lib/index.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const canned = {
  query: 'deepseek',
  number_of_results: 99,
  results: [
    { url: 'https://example.com/one', title: 'One', content: 'first snippet', publishedDate: '2024-05-01T00:00:00Z' },
    { url: '', title: 'dropped (no url)' },
    { url: 'https://example.com/two', title: 'Two', content: 'second snippet' },
    { url: 'https://example.com/three', title: 'Three' },
  ],
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  assert.equal(url.pathname, '/search', 'plugin must query /search')
  assert.equal(url.searchParams.get('format'), 'json', 'plugin must request JSON format')
  assert.ok(url.searchParams.get('q'), 'plugin must carry the query')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(canned))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const baseURL = `http://127.0.0.1:${port}`

// 1. Auto-selection: the single usable search provider answers.
const ctx = new Context()
await ctx.plugin(WebRuntime)
await ctx.plugin(searxngPlugin, { baseURL, categories: 'general', timeoutMs: 5000 })
const result = await ctx.web.search({ query: 'deepseek', maxResults: 2 })
assert.equal(result.truncated, true, 'seam must flag truncation from 3 to 2')
assert.equal(result.sources.length, 2)
assert.deepEqual(result.sources[0], {
  url: 'https://example.com/one',
  title: 'One',
  snippet: 'first snippet',
  publishedAt: '2024-05-01T00:00:00Z',
})
assert.equal(result.sources[1].url, 'https://example.com/two')
assert.equal(result.sources[1].snippet, 'second snippet')

// 2. Explicit pinning by config selects the provider.
const ctx2 = new Context()
await ctx2.plugin(WebRuntime, { searchProvider: 'searxng' })
await ctx2.plugin(searxngPlugin, { baseURL })
const pinned = await ctx2.web.search({ query: 'deepseek' })
assert.equal(pinned.sources.length, 3, 'url-less entry dropped, three citeable sources remain')

// 3. Disposal (HMR-safety): removing the plugin fiber unregisters the provider.
const fiber = await ctx2.plugin(searxngPlugin, { baseURL: 'http://127.0.0.1:1' })
await fiber.dispose()
// The original mount's provider stays; search still answers through it.
const afterDispose = await ctx2.web.search({ query: 'deepseek' })
assert.equal(afterDispose.sources.length, 3)

console.log('SMOKE OK: built lib/ mounts into cordis, auto-selects, truncates, pins, and survives dispose')

server.close()
process.exit(0)
