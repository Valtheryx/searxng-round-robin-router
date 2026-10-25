// searx-router — tiny round-robin dispatcher with fallback, in front of a
// SearXNG instance.
//
// SearXNG queries ALL active engines of a category on every search; there is no
// built-in rotation. This router rotates each incoming search through a list of
// engine "groups" and prepends the matching bangs (e.g. "!ddg !yh !mwm"), so
// each group only serves every N-th query and upstream rate limits/CAPTCHAs
// get more room to cool down.
//
// Since v1.2.0 the router also falls back: if the selected group fails (network
// error, non-2xx, or a JSON response with zero results while engines were
// unresponsive/suspended), the same query is retried against the next group in
// the rotation until the attempt budget is exhausted. A genuinely empty result
// set (all engines answered, nothing found) is passed through without retry —
// gibberish queries must not amplify upstream load.
//
// Env:
//   SEARXNG_URL         base URL of the SearXNG instance (default http://127.0.0.1:8080)
//   ROUTER_PORT         listen port (default 8080)
//   GROUPS              optional JSON array of engine-shortcut arrays
//   FALLBACK_ATTEMPTS   max groups tried per request (default: number of groups)
//   FALLBACK_ON_EMPTY   "0" disables the zero-results retry (default on)
//   UPSTREAM_TIMEOUT_MS per-attempt upstream timeout (default 20000)

const http = require("http");

const VERSION = "1.2.0";
const SEARX = process.env.SEARXNG_URL || "http://127.0.0.1:8080";
const PORT = parseInt(process.env.ROUTER_PORT || "8080", 10);
const TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "20000", 10);
const FALLBACK_ON_EMPTY = process.env.FALLBACK_ON_EMPTY !== "0";

const DEFAULT_GROUPS = [
  ["ddg", "yh", "mwm"],
  ["goc", "szn", "yd"],
  ["br", "gmx", "sch", "nvr"],
];

let groups = DEFAULT_GROUPS;
if (process.env.GROUPS) {
  try {
    const parsed = JSON.parse(process.env.GROUPS);
    if (Array.isArray(parsed) && parsed.every(Array.isArray)) groups = parsed;
  } catch (e) {
    console.error("invalid GROUPS JSON, using defaults:", e.message);
  }
}

// Max groups tried per request; retries continue the shared rotation, so a
// fallbacked request simply pushes the rotation forward like any other query.
const parsedAttempts = parseInt(process.env.FALLBACK_ATTEMPTS || "", 10);
const MAX_ATTEMPTS = Math.min(
  Number.isFinite(parsedAttempts) && parsedAttempts >= 1 ? parsedAttempts : groups.length,
  groups.length
);

let rota = 0;
function nextGroup() {
  const g = groups[rota % groups.length];
  rota += 1;
  return g;
}

function fetchOnce(target) {
  return new Promise((resolve) => {
    const upstream = http.get(target, { timeout: TIMEOUT_MS }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () =>
        resolve({
          status: resp.statusCode,
          headers: resp.headers,
          body: Buffer.concat(chunks),
        })
      );
    });
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", (e) => resolve({ error: e }));
  });
}

// Decide whether a 2xx response warrants a retry with the next group.
// JSON only: zero results AND the engines were unresponsive/suspended is a
// group failure; zero results with healthy engines is a genuine empty result.
function shouldRetry(status, headers, body) {
  if (status >= 300) return "non-2xx";
  if (!FALLBACK_ON_EMPTY) return null;
  const ct = headers["content-type"] || "";
  if (!ct.includes("json")) return null;
  try {
    const data = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(data.results)) return null;
    if (data.results.length > 0) return null;
    const unres = data.unresponsive_engines || data.unresponsiveEngines || [];
    if (Array.isArray(unres) && unres.length > 0) return "zero results, engines unresponsive";
  } catch (e) {
    // not valid JSON — pass it through, do not retry on parse failures
  }
  return null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        groups,
        next: groups[rota % groups.length],
        fallback: {
          attempts: MAX_ATTEMPTS,
          onEmpty: FALLBACK_ON_EMPTY,
          timeoutMs: TIMEOUT_MS,
        },
      })
    );
    return;
  }
  if (u.pathname !== "/search" && u.pathname !== "/") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "use /search?q=<term>" }));
    return;
  }

  const term = (u.searchParams.get("q") || "").trim();
  const fmt = u.searchParams.get("format") || "html";
  if (!term) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "use /search?q=<term>" }));
    return;
  }

  // Explicit bangs from the caller are honored as-is — no rotation, no fallback.
  if (term.startsWith("!")) {
    const target = SEARX + "/search?" + new URLSearchParams({ q: term, format: fmt });
    fetchOnce(target).then((r) => {
      if (r.error) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(r.error) }));
        return;
      }
      res.writeHead(r.status, {
        "Content-Type": r.headers["content-type"] || "text/html",
        "X-Router-Engines": "(passthrough)",
      });
      res.end(r.body);
    });
    return;
  }

  (async () => {
    const tried = [];
    let last = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const bangs = nextGroup();
      tried.push(bangs);
      const fullQ = bangs.map((b) => "!" + b).join(" ") + " " + term;
      const target = SEARX + "/search?" + new URLSearchParams({ q: fullQ, format: fmt });
      last = await fetchOnce(target);
      if (last.error) {
        console.error(
          `attempt ${i + 1}/${MAX_ATTEMPTS} group [${bangs.join(" ")}] failed: ${last.error}`
        );
        continue;
      }
      const reason = shouldRetry(last.status, last.headers, last.body);
      if (!reason) {
        res.writeHead(last.status, {
          "Content-Type": last.headers["content-type"] || "text/html",
          "X-Router-Engines": bangs.join(" "),
          "X-Router-Fallback": String(tried.length - 1),
          "X-Router-Tried": tried.map((g) => g.join(" ")).join(" -> "),
        });
        res.end(last.body);
        return;
      }
      console.error(
        `attempt ${i + 1}/${MAX_ATTEMPTS} group [${bangs.join(" ")}] retry: ${reason}`
      );
    }

    // Attempt budget exhausted: return the last response (or a 502 if all
    // attempts failed on the transport level).
    if (last && !last.error) {
      res.writeHead(last.status, {
        "Content-Type": last.headers["content-type"] || "text/html",
        "X-Router-Engines": tried[tried.length - 1].join(" "),
        "X-Router-Fallback": String(tried.length - 1),
        "X-Router-Tried": tried.map((g) => g.join(" ")).join(" -> "),
      });
      res.end(last.body);
    } else {
      const err = last && last.error ? String(last.error) : "all attempts failed";
      res.writeHead(502, {
        "Content-Type": "application/json",
        "X-Router-Tried": tried.map((g) => g.join(" ")).join(" -> "),
      });
      res.end(JSON.stringify({ error: err, engines: tried[tried.length - 1] }));
    }
  })().catch((e) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`searx-router v${VERSION} listening on :${PORT} -> ${SEARX}`);
  console.log("groups:", groups.map((g) => g.join(" ")).join(" | "));
  console.log(
    `fallback: attempts=${MAX_ATTEMPTS} onEmpty=${FALLBACK_ON_EMPTY} timeoutMs=${TIMEOUT_MS}`
  );
});
