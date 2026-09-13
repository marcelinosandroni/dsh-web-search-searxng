# SearXNG setup guide (from-source install on Linux/WSL)

Step-by-step preparation of a SearXNG instance for use with
`dsh-web-search-searxng`. Written for the `searxng.sh` installer layout
(git clone under `/opt/searxng`, app under `/usr/local/searxng`, settings at
`/etc/searxng/settings.yml`, uwsgi-managed service), which is what the
official [SearXNG install docs](https://docs.searxng.org/admin/installation-searxng.html)
produce on Debian/Ubuntu and WSL.

The plugin needs exactly two things from the instance:

1. **JSON output enabled** — `search.formats` must include `json`.
2. **An HTTP endpoint** — a plain `http://host:port` URL, not just a Unix socket.

---

## 0. Verify the current state

```bash
# Is the service running?
systemctl status uwsgi          # searxng.sh installs SearXNG as a uwsgi app
ps aux | grep -i searx

# Is anything listening on HTTP?
ss -tlnp | grep -E ':(8080|8888|4000)\b'

# Where is the socket?
ls -la /usr/local/searxng/run/socket
```

If `ss` shows no HTTP port but the socket file exists, you are in the
"socket-only" state the installer warns about:

```text
HTTP Server
===========
INFO:  Don't forget to install HTTP site.
```

Continue with step 1, then step 2.

## 1. Enable the JSON format (and relax the limiter)

Edit `/etc/searxng/settings.yml` with root privileges:

```bash
sudoedit /etc/searxng/settings.yml
```

Change the `search.formats` list from:

```yaml
search:
  safe_search: 2
  autocomplete: 'duckduckgo'
  formats:
    - html
```

to:

```yaml
search:
  safe_search: 2
  autocomplete: 'duckduckgo'
  formats:
    - html
    - json
```

And under `server:`, for a **local** instance set:

```yaml
server:
  limiter: false
```

Why: the limiter's bot detection rejects non-browser clients (like this
plugin's `fetch`) with HTTP 429 even from localhost. On an internet-exposed
instance keep `limiter: true` and instead put the plugin behind a reverse
proxy that supplies the expected headers — or accept that API use may be
rate-limited.

Save, then restart:

```bash
sudo systemctl restart uwsgi
```

### Sanity-check the settings were parsed

The installer's own checker re-reads settings:

```bash
sudo -H -u searxng /usr/local/searxng/searxng-src/utils/searxng.sh instance check
```

Expect the `SearXNG checks` block to end with a connected Valkey line and no
config errors.

## 2. Expose an HTTP endpoint

Pick **one** option.

### Option A — uwsgi HTTP socket (simplest, no new packages)

The SearXNG uwsgi app already loads the `http` plugin
(`plugin = python3,http` in `/etc/uwsgi/apps-enabled/searxng.ini`). Give it
an HTTP socket in addition to the Unix socket:

```bash
sudoedit /etc/uwsgi/apps-enabled/searxng.ini
```

Append at the end of the `[uwsgi]` section:

```ini
# Local HTTP endpoint for API clients (dsh-web-search-searxng)
http-socket = 127.0.0.1:8080
```

```bash
sudo systemctl restart uwsgi
ss -tlnp | grep 8080        # must now show a listener
```

Bind to `127.0.0.1` unless you deliberately want the instance reachable from
the LAN.

### Option B — nginx reverse proxy (the installer's "HTTP site")

```bash
sudo apt install nginx
sudo -H /usr/local/searxng/searxng-src/utils/searxng.sh install nginx
sudo systemctl reload nginx
```

The site answers at `http://<hostname>/searxng` by default. Point the plugin's
`baseURL` at exactly that prefix (it appends `/search` itself):

```yaml
config:
  baseURL: 'http://localhost/searxng'
```

### Option C — Docker instead of the source install

If you prefer containers over the source install:

```bash
mkdir -p ~/searxng-config
docker run -d --name searxng \
  -p 8080:8080 \
  -v ~/searxng-config:/etc/searxng \
  -e SEARXNG_BASE_URL=http://localhost:8080/ \
  searxng/searxng
# first run creates ~/searxng-config/settings.yml — edit it per step 1
# (add json to search.formats, limiter: false), then:
docker restart searxng
```

## 3. Smoke-test the JSON API

```bash
curl -s 'http://127.0.0.1:8080/search?q=hello+world&format=json' | head -c 400
```

| Result | Meaning | Fix |
|---|---|---|
| JSON with `"results": [...]` | Ready | — |
| `403` / "Forbidden" | JSON format not enabled | Step 1 (`formats: [html, json]`) + restart |
| `429` | Limiter blocking the request | `server.limiter: false` + restart |
| Connection refused | No HTTP listener | Step 2 |
| Empty `results` but valid JSON | Engines unreachable (egress/VPN/DNS) | Check outbound network from the WSL instance |

## 4. Point the plugin at the instance

Either environment:

```bash
export SEARXNG_BASE_URL='http://127.0.0.1:8080'
```

or plugin config (`cordis.yml`):

```yaml
plugins:
  - name: dsh-web-search-searxng
    setup: dsh-web-search-searxng
    config:
      baseURL: 'http://127.0.0.1:8080'
```

Then run a dsh task that calls `web_search` and confirm results come back.

## 5. WSL notes

- **Service autostart**: WSL does not start systemd services unless
  `/etc/wsl.conf` has `[boot] systemd=true`. Check with
  `systemctl is-system-running`; after a WSL restart, SearXNG only comes back
  if systemd is enabled (or start it manually: `sudo service uwsgi start`).
- **localhost forwarding**: `http://localhost:8080` inside WSL reaches the
  WSL listener directly. From the Windows host, WSL2's localhost forwarding
  usually exposes it too; if not, use the WSL IP (`hostname -I`).
- **Outbound DNS/engines**: SearXNG aggregates remote engines, so the WSL
  instance needs working outbound HTTPS. If every query returns
  `unresponsive_engines`, check `/etc/resolv.conf` and any VPN/proxy.

## 6. Optional: authenticated public instance

If your instance sits behind an authenticating reverse proxy (basic auth
terminated into a bearer token, an OAuth proxy, etc.), set:

```bash
export SEARXNG_API_KEY='<token>'
```

The plugin sends it as `Authorization: Bearer <token>` and **rejects HTTP
redirects** on such requests, so the credential can never auto-forward to a
redirect target.
