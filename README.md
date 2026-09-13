# dsh-web-search-searxng

A [SearXNG](https://docs.searxng.org/) web-search provider plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).
It registers a `searxng` search provider into the harness web capability seam
(`ctx.web`), so the model-facing `web_search` tool runs through your
self-hosted SearXNG metasearch instance — no commercial search API key needed.

- **Privacy-first**: results come from your own SearXNG instance, which fans out
  to dozens of engines (Google, DuckDuckGo, Wikipedia, arXiv, …) without
  tracking.
- **Free**: SearXNG is open source; the JSON search endpoint needs no API key.
- **Drop-in**: implements the same `WebSearchProvider` contract as the built-in
  Exa / DeepSeek / Perplexity providers.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Step-by-step: prepare SearXNG](#2-step-by-step-prepare-searxng)
3. [Step-by-step: install the plugin](#3-step-by-step-install-the-plugin)
4. [Step-by-step: wire it into dsh](#4-step-by-step-wire-it-into-dsh)
5. [Step-by-step: verify it works](#5-step-by-step-verify-it-works)
6. [Configuration reference](#configuration-reference)
7. [Behavior and error codes](#behavior-and-error-codes)
8. [Development](#development)
9. [Publishing to your git account](#publishing-to-your-git-account)

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20.3 | The plugin is ESM-only and uses `AbortSignal.any`/`timeout` |
| A running SearXNG instance | Installed from source, Docker, or a public instance you trust |
| dsh with the web seam | Any dsh profile that mounts `@deepseek-ai/dsh-web` + `@deepseek-ai/dsh-tool-web` (the shipped profiles do) |
| SearXNG **JSON format enabled** | Off by default — see step 2 below |

## 2. Step-by-step: prepare SearXNG

This plugin talks to SearXNG's HTTP JSON API:
`GET {baseURL}/search?q=…&format=json`. Two things must be true on the
instance side. (A full guide for a from-source Linux/WSL install lives in
[docs/SEARXNG-SETUP.md](docs/SEARXNG-SETUP.md).)

### 2.1 Enable the JSON output format

SearXNG only answers `format=json` when `json` is listed in
`search.formats`. Edit the instance settings (path varies by install:
`/etc/searxng/settings.yml` for the `searxng.sh` installer, or
`searxng/settings.yml` in a Docker volume):

```yaml
search:
  formats:
    - html
    - json          # <-- add this line

server:
  limiter: false    # recommended for local/API use (see note below)
```

> **About `limiter`**: SearXNG's rate limiter defends public instances from
> bots, but it also blocks non-browser API clients with HTTP 429. For a local
> instance used by dsh, set `server.limiter: false`. Keep it `true` only on
> internet-exposed instances.

Then restart SearXNG:

```bash
# searxng.sh installer (systemd-managed uwsgi)
sudo systemctl restart uwsgi        # or: sudo systemctl restart searxng

# Docker
docker restart <searxng-container>
```

### 2.2 Expose an HTTP endpoint

Some installs (notably the `searxng.sh` script on Debian/Ubuntu) run uwsgi on a
**Unix socket only** (`/usr/local/searxng/run/socket`) and leave the HTTP site
uninstalled — the installer literally prints
`INFO: Don't forget to install HTTP site.` The plugin needs a plain
`http(s)://` URL. Pick one:

**Option A — let the installer set up nginx/Apache (recommended for servers):**

```bash
sudo -H /usr/local/searxng/searxng-src/utils/searxng.sh install nginx
sudo systemctl reload nginx
# instance now answers on http://<host>/searxng (path per installer defaults)
```

**Option B — run uwsgi with its own HTTP socket (quick local dev):**

Add to the uwsgi ini (e.g. `/etc/uwsgi/apps-enabled/searxng.ini`), next to the
existing `socket = …` line:

```ini
http-socket = 127.0.0.1:8080
```

```bash
sudo systemctl restart uwsgi
curl 'http://127.0.0.1:8080/search?q=hello&format=json' | head -c 200
```

**Option C — Docker with a published port:**

```bash
docker run -d --name searxng \
  -p 8080:8080 \
  -v /etc/searxng:/etc/searxng \
  -e SEARXNG_BASE_URL=http://localhost:8080/ \
  searxng/searxng
```

### 2.3 Smoke-test the endpoint

```bash
curl -s 'http://localhost:8080/search?q=deepseek+ai&format=json' | python3 -m json.tool | head -30
```

You should see a `"results": [ … ]` array. A 403 means the JSON format is
still off or the limiter is blocking you; a connection refusal means no HTTP
endpoint is listening yet.

## 3. Step-by-step: install the plugin

From npm (after you publish it — see [Publishing](#publishing-to-your-git-account)):

```bash
npm install dsh-web-search-searxng
```

Directly from your GitHub repo (works before any npm publish):

```bash
npm install github:<your-user>/dsh-web-search-searxng
# or with git:
npm install git+https://github.com/<your-user>/dsh-web-search-searxng.git
```

Or from a local clone (e.g. while developing against a dsh source checkout):

```bash
git clone https://github.com/<your-user>/dsh-web-search-searxng.git
cd dsh-web-search-searxng
npm install
npm run build
npm link            # optional: make it globally resolvable
```

The dsh packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-web`,
`@deepseek-ai/dsh-launch-environment`) are **peer dependencies**: when the
plugin runs inside a dsh installation they are already present. If you install
the plugin standalone, npm resolves them from the registry automatically
(they are published under the `next` dist-tag).

## 4. Step-by-step: wire it into dsh

Mount the plugin in your cordis composition and (when other search providers
are also mounted) pin the web seam to it. A ready-made overlay is at
[examples/cordis.yml](examples/cordis.yml):

```yaml
plugins:
  - name: dsh-web-search-searxng
    setup: dsh-web-search-searxng
    config:
      baseURL: 'http://localhost:8080'   # your instance; or rely on $SEARXNG_BASE_URL

  - name: web
    setup: '@deepseek-ai/dsh-web'
    config:
      searchProvider: 'searxng'          # pin the winner; omit if this is the only search provider
```

Instead of hardcoding the URL you can export it once:

```bash
export SEARXNG_BASE_URL='http://localhost:8080'
```

or put it in your project `.env` (dsh's launch environment reads
`SEARXNG_BASE_URL` and the optional `SEARXNG_API_KEY`).

**Selection semantics** (owned by `@deepseek-ai/dsh-web`): with exactly one
usable search provider mounted, it auto-selects — no `searchProvider` needed.
With several usable providers (e.g. DeepSeek's built-in search plus this one),
the seam refuses to guess: set `searchProvider: 'searxng'` (config), or
`$DSH_WEB_SEARCH_PROVIDER=searxng` (environment).

## 5. Step-by-step: verify it works

Run one task through any dsh profile and ask something that needs the web:

```bash
pnpm dsh --profile headless "search the web for the latest DeepSeek model release and cite sources"
```

The `web_search` tool call should return SearXNG results (URLs, titles,
snippets). To confirm the provider is the one answering, watch your SearXNG
instance logs while the query runs, or hit the JSON endpoint manually with the
same query.

---

## Configuration reference

All fields are optional. `baseURL` falls back to `$SEARXNG_BASE_URL`, then
`http://localhost:8080`. `apiKey` falls back to `$SEARXNG_API_KEY`.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL` → `http://localhost:8080` | SearXNG instance base; `/search` is appended. An unparseable value makes the provider unavailable |
| `categories` | `general` | Comma-separated SearXNG categories: `general`, `it`, `science`, `images`, `videos`, `news`, `files`, `music`, `social media` |
| `language` | `all` | Language code (`en`, `de`, `pt-BR`, …) or `all` |
| `safesearch` | (unset → instance default) | `0` None, `1` Moderate, `2` Strict |
| `timeRange` | (unset) | `day`, `week`, `month`, or `year` |
| `pageno` | (unset → `1`) | Result page, 1-based |
| `apiKey` | `$SEARXNG_API_KEY` | Optional bearer token sent as `Authorization` for instances behind an authenticated proxy. When set, HTTP redirects are **rejected** so the credential cannot auto-forward |
| `timeoutMs` | `15000` | Per-request timeout (SearXNG fans out to many engines and can be slow) |

Request-level `maxResults` (set by the `web_search` tool) is enforced by the
web seam, which truncates `sources[]` and flags `truncated: true`. SearXNG has
no server-side result-count control, so the provider cannot pre-limit.

## Behavior and error codes

Each SearXNG result maps to the seam's portable `WebSearchSource`:

| SearXNG field | `WebSearchSource` field |
|---|---|
| `url` | `url` (entries without a URL are dropped) |
| `title` | `title` (omitted when blank) |
| `content` | `snippet` (omitted when blank) |
| `publishedDate` | `publishedAt` (omitted when absent) |

SearXNG returns no generated answer, so the result carries no `content` —
only citeable sources, exactly like the Exa provider.

Failures surface as `WebError` with machine-routable codes:

| Code | When |
|---|---|
| `WEB_PROVIDER_ERROR` | HTTP non-2xx, network failure, redirect rejected on a credentialed request, unparseable JSON body |
| `WEB_ABORTED` | Caller cancelled, or the per-request timeout fired |
| `WEB_PROVIDER_CONFIGURED_MISSING` / `…UNAVAILABLE` / `WEB_PROVIDER_AMBIGUOUS` / `WEB_PROVIDER_UNAVAILABLE` | Raised by the web seam during provider selection, not by this plugin |

## Development

```bash
git clone https://github.com/<your-user>/dsh-web-search-searxng.git
cd dsh-web-search-searxng
npm install
npm run build      # tsc → lib/
npm test           # node:test + tsx; hermetic (mocked HTTP server, no network)
npm run typecheck
```

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: `name`, `inject`, `Config` schema, env fallbacks, provider registration |
| `src/provider.ts` | `SearxngSearchProvider`: URL building, request dispatch, abort/timeout classification, result mapping |
| `src/types.ts` | SearXNG JSON wire types |
| `tests/provider.test.ts` | Behavior tests: mapping, availability, search against a local mock server |

## Publishing to your git account

1. Update `package.json`: set `repository.url`, `homepage`, and `bugs.url`
   to your GitHub repo, and `author` to your name/handle.
2. Create the GitHub repository, then:

   ```bash
   git remote set-url origin git@github.com:<your-user>/dsh-web-search-searxng.git
   git push -u origin master
   ```

3. (Optional) Publish to npm so `npm install dsh-web-search-searxng` works:

   ```bash
   npm login
   npm publish          # add --access public if you scope the package
   ```

   `prepublishOnly` runs a clean build automatically.

## License

MIT — see [LICENSE](LICENSE).

SearXNG itself is AGPL-3.0; this plugin only speaks its public HTTP JSON API
and bundles no SearXNG code.
