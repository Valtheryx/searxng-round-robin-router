// searx-router — tiny round-robin dispatcher in front of a SearXNG instance.
//
// SearXNG queries ALL active engines of a category on every search; there is no
// built-in rotation. This router rotates each incoming search through a list of
// engine "groups" and prepends the matching bangs (e.g. "!ddg !yh !mwm"), so
// each group only serves every N-th query and upstream rate limits/CAPTCHAs
// get more room to cool down.
//
// Env:
//   SEARXNG_URL  base URL of the SearXNG instance (default http://127.0.0.1:8080)
//   ROUTER_PORT  listen port (default 8080)
//   GROUPS       optional JSON array of engine-shortcut arrays; defaults below

const http = require("http");

const SEARX = process.env.SEARXNG_URL || "http://127.0.0.1:8080";
const PORT = parseInt(process.env.ROUTER_PORT || "8080", 10);

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

let rota = 0;
function pickGroup() {
  const g = groups[rota % groups.length];
  rota += 1;
  return g;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/health") {
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({ok: true, groups, next: groups[rota % groups.length]}));
    return;
  }
  if (u.pathname !== "/search" && u.pathname !== "/") {
    res.writeHead(404, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: "use /search?q=<term>"}));
    return;
  }
  const term = (u.searchParams.get("q") || "").trim();
  const fmt = u.searchParams.get("format") || "html";
  if (!term) {
    res.writeHead(400, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: "use /search?q=<term>"}));
    return;
  }
  const bangs = pickGroup();
  const fullQ = bangs.map(b => "!" + b).join(" ") + " " + term;
  const target = SEARX + "/search?" + new URLSearchParams({q: fullQ, format: fmt});
  const upstream = http.get(target, {timeout: 60000}, (resp) => {
    const chunks = [];
    resp.on("data", c => chunks.push(c));
    resp.on("end", () => {
      res.writeHead(resp.statusCode, {
        "Content-Type": resp.headers["content-type"] || "application/json",
        "X-Router-Engines": bangs.join(" "),
      });
      res.end(Buffer.concat(chunks));
    });
  });
  upstream.on("error", (e) => {
    res.writeHead(502, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: String(e), engines: bangs}));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`searx-router listening on :${PORT} -> ${SEARX}`);
  console.log("groups:", groups.map(g => g.join(" ")).join(" | "));
});