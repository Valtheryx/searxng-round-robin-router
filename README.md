# searx-router

A tiny Node.js round-robin dispatcher that sits **in front of a self-hosted
[SearXNG](https://docs.searxng.org/) instance** and spreads search queries more
evenly across search engines to reduce upstream rate limits and CAPTCHAs.

## The problem

SearXNG queries **all active engines** of a category on every search — there is
no built-in rotation. Enabling more engines increases the per-query fan-out
against every provider instead of spreading load. Once DuckDuckGo starts
serving CAPTCHAs or Brave answers 429, every search degrades at once.

## The idea

Prepend a rotating set of engine *bangs* to each query. SearXNG's search syntax
allows selecting engines explicitly with `!<shortcut>` (chainable:

```
!ddg !yh !mwm my search term
```

queries only DuckDuckGo, Yahoo and Mwmbl). The router rotates each incoming
search through a list of engine groups, so every group only serves every N-th
query:

```
search #1 → group A: !ddg !yh !mwm
search #2 → group B: !goc !szn !yd
search #3 → group C: !br !gmx !sch !nvr
search #4 → group A: ...
```

The response is passed through unchanged and carries extra headers naming the
group that served the request (`X-Router-Engines`), how many groups were tried
before it (`X-Router-Fallback`), and the full trail of tried groups
(`X-Router-Tried`).

## What it is NOT

- **Not a SearXNG fork or modification** — SearXNG runs untouched.
- **Not a caching layer** — results are streamed through as-is.
- **Not a per-engine round robin** — each request still queries all engines of
  the *selected group* simultaneously; only the *group* rotates.

## Quick start

Place `router.js` and `docker-compose.yml` in the same directory. Set the SearXNG URL to an address reachable from the router container, then deploy:

```bash
SEARXNG_URL=http://searxng:8080 docker compose up -d
```

For separate Compose projects, make sure the router can reach SearXNG over a shared Docker network or use its reachable host URL. Set `ROUTER_CONFIG_DIR` if the files are in a different host directory.

Then point clients at the router instead of SearXNG. Browser searches default to HTML; API callers can request JSON explicitly:

```text
http://localhost:8096/search?q=<term>
http://localhost:8096/search?q=<term>&format=json
```

## Fallback behavior

Since v1.2.0 a failed group does not fail the search. If the selected group
answers with a network error, a non-2xx status, or a JSON response with zero
results **while engines were unresponsive or suspended** (CAPTCHA, rate limit),
the same query is retried against the next group in the rotation — up to
`FALLBACK_ATTEMPTS` groups per request. The rotation pointer keeps moving, so a
fallbacked request simply advances the shared rotation.

A genuinely empty result set (all engines answered, nothing found for the
query) is passed through without retry: gibberish queries must not amplify
upstream load. HTML responses cannot be inspected for "empty", so fallback on
non-2xx only applies there. Queries that already start with a bang are passed
through untouched (explicit engine selection wins over rotation and fallback).

| Variable              | Default             | Meaning                                          |
|-----------------------|---------------------|--------------------------------------------------|
| `FALLBACK_ATTEMPTS`   | number of groups    | Max groups tried per request (cap: group count)  |
| `FALLBACK_ON_EMPTY`   | `1`                 | Set `0` to disable the zero-results retry        |
| `UPSTREAM_TIMEOUT_MS` | `20000`             | Per-attempt upstream timeout (serial fallback multiplies) |

Health check: `GET /health` shows the configured groups, the next group in
rotation, and the effective fallback settings.

## Configuration

All via environment variables (see `docker-compose.yml`):

| Variable             | Default                 | Meaning                                          |
|----------------------|-------------------------|--------------------------------------------------|
| `SEARXNG_URL`        | required                | Reachable base URL of your SearXNG instance      |
| `ROUTER_PORT`        | `8080`                  | Listen port inside the container                |
| `ROUTER_HOST_PORT`   | `8096`                  | Host port published for clients                 |
| `ROUTER_HOST_IP`     | `0.0.0.0`               | Host interface to bind; set a private IP to limit exposure |
| `ROUTER_CONFIG_DIR`  | `.`                     | Host directory containing `router.js`           |
| `GROUPS`             | built-in defaults       | JSON array of arrays with SearXNG shortcuts     |
| `GROUPS_FILE`        | unset                   | JSON file with the groups, polled every 5 s (hot reload) |
| `INSTANCES`          | `{"searxng":SEARXNG_URL}` | JSON map instance key → SearXNG base URL       |
| `MONITOR_STATE_FILE` | unset                   | Path to the monitor state file, served at `/monitor` |

Engine shortcuts are listed per instance at `GET /config` (fields `shortcut`
and `enabled`). Example override:

```yaml
environment:
  GROUPS: '[["ddg","yh"],["goc","szn","yd"],["br","mwm"]]'
```

## Groups file & hot reload (v1.3.0+)

Instead of the static `GROUPS` env, point `GROUPS_FILE` at a JSON file (a
writable directory shared with the monitor below). The router polls it every
5 s and reloads the rotation on change — no restart needed. A group item is an
engine-bang string for the default instance, or a `{"b": ["bang"], "i":
"instanceKey"}` object for another instance:

```json
[
  ["goc", "yd", "szn"],
  ["br", "yh", "mwm"],
  [{"b": ["ddg", "gmx"], "i": "searx-home"}]
]
```

Set `INSTANCES` to a JSON map of instance key → base URL, e.g.
`'{"searxng":"http://searxng:8080","searx-home":"http://10.0.0.5:8888"}'`
(key `searxng` always maps to `SEARXNG_URL`). This lets you spread queries
across two SearXNG instances — and therefore two source IPs — which often
unblocks engines that refuse your datacenter IP.

A group spanning several instances is answered with parallel sub-requests, one
per involved instance; JSON results are merged (results concatenated,
unresponsive engines combined, `number_of_results` summed). For `format=html`
the first successful response is passed through unchanged.

## Engine status endpoint (v1.3.2)

`GET /engine-status` — designed for dashboard widgets (Homepage customapi etc.).
The router runs ONE gentle category probe search per instance (cached, default
10 minutes via `ENGINE_STATUS_CACHE_MS`) and reports which general engines
answered, which are blocked (CAPTCHA, 429, 403, timeout) and the disabled
engines with their last monitor verdict:

```text
/engine-status                 -> { "<instance>": {...}, ... }
/engine-status?instance=searxng -> { "active": "8/10", "blocked": "brave (429)", "disabled": "..." }
```

## Engine monitor (v1.3.0+)

`monitor.js` is a cron-style companion container. Every `MONITOR_INTERVAL_H`
hours (default 72) it probes each candidate engine with exactly **one** gentle
query per instance — never bursts. Two clean runs in a row promote the engine:
its bang is appended to a group in `GROUPS_FILE` as an
`{"b": [...], "i": "..."}` entry, the router reloads within 5 s, and the
promotion is verified against the router `/health` endpoint. Engines already
present in the rotation are never promoted twice (v1.3.1).

State lives in `MONITOR_STATE_FILE` and is served by the router at
`GET /monitor` (together with the active groups), so an external relay — a
cron job, a bot, anything that can read a URL — can report promotions without
holding any credentials of its own. Configure the watched engines in the
`CANDIDATES` object at the top of `monitor.js`.

## Picking engines for the groups

Use engines that (a) actually work from your network and (b) are currently
*not* rate-limited. Useful checks:

```bash
# single-engine bang query via the JSON API
curl 'http://searx:8080/search?q=!yh+test&format=json' | jq '.results | length'
curl 'http://searx:8080/search?q=!yh+test&format=json' | jq '.unresponsive_engines'
```

The built-in example groups are deliberately generic. Replace them with
shortcuts that are enabled and work on your SearXNG instance; avoid putting
provider-specific or private infrastructure details in the repository.

## SearXNG side notes

- Trim the `general` category in `settings.yml` to real web-search engines;
  SearXNG's default `general` also carries utility engines (Wikipedia,
  currency, translate) that fire on every search.
- Engines that silently return no results (e.g. `bing` in some setups) or
  always fail (`access denied`, SSL errors) are better left disabled — they
  just add noise and load.

## Image & resource footprint

The router runs on `node:22-alpine` (~55 MB compressed, ~170 MB on disk) —
deliberately not a fat multi-service base image. Runtime footprint is a single
Node process, typically well under 100 MB RSS.

## Versioning

Releases are tagged in git and tracked in the `VERSION` file:

```bash
git tag -a vX.Y.Z -m "release vX.Y.Z"
git push origin main vX.Y.Z
```

Current version: see [VERSION](VERSION).

## License

MIT