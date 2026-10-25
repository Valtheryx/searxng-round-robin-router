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

The response is passed through unchanged and carries an extra
`X-Router-Engines` header naming the group that served the request.

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

Health check: `GET /health` shows the configured groups and the next group in
rotation.

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

Engine shortcuts are listed per instance at `GET /config` (fields `shortcut`
and `enabled`). Example override:

```yaml
environment:
  GROUPS: '[["ddg","yh"],["goc","szn","yd"],["br","mwm"]]'
```

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