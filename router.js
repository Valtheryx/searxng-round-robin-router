// searx-router — round-robin dispatcher with fallback, in front of one or
// more SearXNG instances.
//
// SearXNG queries ALL active engines of a category on every search; there is no
// built-in rotation. This router rotates each incoming search through a list of
// engine "groups" and prepends the matching bangs (e.g. "!ddg !yh !mwm"), so
// each group only serves every N-th query and upstream rate limits/CAPTCHAs
// get more room to cool down.
//
// v1.2.0: fallback — if the selected group fails (network error, non-2xx, or a
// JSON response with zero results while engines were unresponsive/suspended),
// the same query is retried against the next group in the rotation until the
// attempt budget is exhausted. A genuinely empty result set (all engines
// answered, nothing found) is passed through without retry. Explicit bangs
// from the caller bypass rotation and fallback.
//
// v1.3.0:
//   - GROUPS_FILE: optional JSON file with the groups; polled every 5 s so the
//     rotation can change at runtime without a restart (the engine-monitor
//     writes promotions here). GROUPS env (or DEFAULT_GROUPS) is the seed used
//     only while the file is missing/invalid.
//   - Multi-instance groups: a group item is either a string (engine bang for
//     the default instance SEARXNG_URL) or { b: [bangs], i: "<instance key>" }.
//     Instance keys are defined in INSTANCES (JSON env). A group whose items
//     span several instances is answered by parallel sub-requests, one per
//     involved instance; JSON results are merged (results, unresponsive
//     engines, number_of_results summed). For format=html the first successful
//     response is passed through unchanged.
//   - /monitor: returns the active groups plus the engine-monitor state file
//     (monitor-state.json) so an external relay can report promotions.//
// v1.3.1: no router code changes — pairs with monitor.js 1.3.1 (the monitor
// skips promotion for engines that are already part of the rotation).
// v1.3.2: /engine-status — dashboard endpoint. Runs ONE gentle category probe
// search per instance (cached, default 10 min) and reports which general
// engines answered vs. which are blocked (CAPTCHA, 429, 403, timeout), plus
// the disabled engines with their last monitor verdict.
//
// Env:
//   SEARXNG_URL          base URL of the default SearXNG instance
//   INSTANCES            optional JSON map instanceKey -> base URL
//                        (key "searxng" defaults to SEARXNG_URL)
//   ROUTER_PORT          listen port (default 8080)
//   GROUPS               optional JSON array of engine-shortcut arrays (seed)
//   GROUPS_FILE          optional path to the live groups JSON (polled)
//   MONITOR_STATE_FILE   optional path served under /monitor
//   FALLBACK_ATTEMPTS    max groups tried per request (default: number of groups)
//   FALLBACK_ON_EMPTY    "0" disables the zero-results retry (default on)
//   UPSTREAM_TIMEOUT_MS  per-attempt upstream timeout (default 20000)

const http = require("http");
const fs = require("fs");

const VERSION = "1.3.2";
const SEARX = process.env.SEARXNG_URL || "http://127.0.0.1:8080";
const PORT = parseInt(process.env.ROUTER_PORT || "8080", 10);
const TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "20000", 10);
const FALLBACK_ON_EMPTY = process.env.FALLBACK_ON_EMPTY !== "0";
const GROUPS_FILE = process.env.GROUPS_FILE || "";
const MONITOR_STATE_FILE = process.env.MONITOR_STATE_FILE || "";

const DEFAULT_GROUPS = [
  ["goc", "yd", "szn"],
  ["br", "yh", "mwm"],
  ["ddgw", "sch", "nvr"],
  [{ b: ["ddg", "gmx", "bi"], i: "fuchsbau" }],
  [{ b: ["yep", "pw", "fire"], i: "fuchsbau" }],
  ["rel", "yd", "mwm"],
];

let groups = DEFAULT_GROUPS;
let groupsSource = "default";
if (process.env.GROUPS) {
  try {
    const parsed = JSON.parse(process.env.GROUPS);
    if (Array.isArray(parsed) && parsed.every(Array.isArray)) {
      groups = parsed;
      groupsSource = "env";
    }
  } catch (e) {
    console.error("invalid GROUPS JSON, using defaults:", e.message);
  }
}

// Instances: "searxng" always maps to SEARXNG_URL, others come from INSTANCES.
let INSTANCES = { searxng: SEARX };
if (process.env.INSTANCES) {
  try {
    const parsed = JSON.parse(process.env.INSTANCES);
    for (const [k, v] of Object.entries(parsed)) INSTANCES[k] = v;
  } catch (e) {
    console.error("invalid INSTANCES JSON, keeping default:", e.message);
  }
}
INSTANCES.searxng = SEARX;

function loadGroupsFile() {
  if (!GROUPS_FILE) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(GROUPS_FILE, "utf8"));
    if (Array.isArray(parsed) && parsed.length && parsed.every(Array.isArray)) {
      if (JSON.stringify(parsed) !== JSON.stringify(groups)) {
        console.log("groups reloaded from", GROUPS_FILE, "-", parsed.length, "groups");
      }
      groups = parsed;
      groupsSource = GROUPS_FILE;
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("GROUPS_FILE unreadable, keeping current groups:", e.message);
    }
  }
}
loadGroupsFile();
setInterval(loadGroupsFile, 5000);

// Max groups tried per request; retries continue the shared rotation.
const parsedAttempts = parseInt(process.env.FALLBACK_ATTEMPTS || "", 10);
const MAX_ATTEMPTS = Math.min(
  Number.isFinite(parsedAttempts) && parsedAttempts >= 1 ? parsedAttempts : groups.length,
  groups.length
);
// recompute attempts after a group reload
function attemptsBudget() {
  const n = groups.length;
  return Math.min(Number.isFinite(parsedAttempts) && parsedAttempts >= 1 ? parsedAttempts : n, n);
}

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

// A group becomes one sub-request per involved instance. Plain string items
// (and {b,i:"searxng"} objects) batch into the default-instance request, like
// v1.2. Every other instance gets its own request.
function groupSubrequests(group) {
  const subs = [];
  let defaultBangs = [];
  for (const item of group) {
    if (typeof item === "string") {
      defaultBangs.push(item);
      continue;
    }
    if (!item || !Array.isArray(item.b)) {
      console.error("invalid group item, skipping:", JSON.stringify(item));
      continue;
    }
    const key = item.i || "searxng";
    const base = INSTANCES[key];
    if (!base) {
      console.error("unknown instance:", key, "- skipping item");
      continue;
    }
    if (key === "searxng") defaultBangs.push(...item.b);
    else subs.push({ instance: key, bangs: item.b.slice(), base });
  }
  if (defaultBangs.length) {
    subs.unshift({ instance: "searxng", bangs: defaultBangs, base: SEARX });
  }
  return subs;
}

function mergeResponses(subs) {
  const ok = subs.filter((s) => s.resp && !s.resp.error);
  if (!ok.length) return null; // every sub-request failed on transport level
  const bodies = ok.map((s) => ({
    ct: (s.resp.headers["content-type"] || "").toLowerCase(),
    body: s.resp.body,
    status: s.resp.status,
    headers: s.resp.headers,
  }));
  const jsons = [];
  for (const b of bodies) {
    if (!b.ct.includes("json")) continue;
    try {
      jsons.push(JSON.parse(b.body.toString("utf8")));
    } catch (e) {
      /* not valid json */
    }
  }
  if (jsons.length === ok.length && ok.length > 0) {
    const merged = { results: [], unresponsive_engines: [] };
    let num = 0;
    for (const j of jsons) {
      if (Array.isArray(j.results)) merged.results.push(...j.results);
      if (Array.isArray(j.unresponsive_engines)) {
        merged.unresponsive_engines.push(...j.unresponsive_engines);
      }
      if (typeof j.number_of_results === "number") num += j.number_of_results;
    }
    merged.number_of_results = num;
    for (const k of ["query", "answers", "infoboxes", "suggestions"]) {
      const v = jsons
        .map((j) => j[k])
        .find((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
      if (v !== undefined) merged[k] = v;
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(merged)),
    };
  }
  // non-JSON (HTML) or unparseable: first successful response wins
  return { status: ok[0].status, headers: ok[0].headers, body: ok[0].body };
}

// Decide whether a 2xx response warrants a retry with the next group.
// JSON only: zero results AND unresponsive engines is a group failure; zero
// results with healthy engines is a genuine empty result.
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

function readJsonFile(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    return null;
  }
}

// --- engine status for dashboards (GET /engine-status) ---
const STATUS_QUERY = process.env.ENGINE_STATUS_QUERY || "wetter deutschland";
const STATUS_CACHE_MS = parseInt(process.env.ENGINE_STATUS_CACHE_MS || "600000", 10);
const statusCache = {}; // instanceKey -> {at, ...}
let statusBusy = false;

function fetchOnceJson(target) {
  return fetchOnce(target).then((r) => {
    if (r.error) return { error: String(r.error) };
    try {
      return { data: JSON.parse(r.body.toString("utf8")) };
    } catch (e) {
      return { error: "invalid json" };
    }
  });
}

function shortReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("econnrefused") || r.includes("ehostunreach") || r.includes("etimedout")) return "offline";
  if (r.includes("captcha")) return "captcha";
  if (r.includes("too many requests")) return "429";
  if (r.includes("access denied")) return "403";
  if (r.includes("timeout")) return "timeout";
  if (r.includes("leise leer") || r.includes("empty")) return "leer";
  return String(reason || "").slice(0, 30);
}

async function refreshEngineStatus() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    for (const [key, base] of Object.entries(INSTANCES)) {
      const entry = { url: base, at: Date.now() };
      const [cfg, search] = await Promise.all([
        fetchOnceJson(base + "/config"),
        fetchOnceJson(
          base + "/search?" +
            new URLSearchParams({ q: STATUS_QUERY, categories: "general", format: "json" })
        ),
      ]);
      if (cfg.data && Array.isArray(cfg.data.engines)) {
        entry.enabledGeneral = [];
        entry.disabled = [];
        for (const e of cfg.data.engines) {
          if (!(e.categories || []).includes("general")) continue;
          (e.enabled ? entry.enabledGeneral : entry.disabled).push(e.name);
        }
      }
      if (search.data) {
        const answered = {};
        for (const r of search.data.results || []) answered[r.engine] = true;
        const unres = (search.data.unresponsive_engines || []).map((u) =>
          Array.isArray(u) ? { engine: u[0], reason: u[1] } : { engine: String(u), reason: "" }
        );
        entry.active = (entry.enabledGeneral || []).filter((n) => answered[n]);
        entry.blocked = unres;
        entry.silent = (entry.enabledGeneral || [])
          .filter((n) => !answered[n] && !unres.some((b) => b.engine === n))
          .map((n) => ({ engine: n, reason: "keine Treffer" }));
      }
      entry.ok = !!(Array.isArray(entry.enabledGeneral) && Array.isArray(entry.active));
      statusCache[key] = entry;
    }
  } catch (e) {
    console.error("engine status refresh failed:", e.message);
  } finally {
    statusBusy = false;
  }
}

setInterval(refreshEngineStatus, STATUS_CACHE_MS);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        groups,
        groupsSource,
        instances: INSTANCES,
        next: groups[rota % groups.length],
        fallback: {
          attempts: attemptsBudget(),
          onEmpty: FALLBACK_ON_EMPTY,
          timeoutMs: TIMEOUT_MS,
        },
      })
    );
    return;
  }
  if (u.pathname === "/monitor") {
    const out = {
      ok: true,
      version: VERSION,
      groups,
      groupsSource,
      instances: INSTANCES,
      monitor_state: MONITOR_STATE_FILE ? readJsonFile(MONITOR_STATE_FILE) : null,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }
  if (u.pathname === "/engine-status") {
    const want = u.searchParams.get("instance");
    const keys = want && INSTANCES[want] ? [want] : Object.keys(INSTANCES);
    const missing = keys.filter((k) => !statusCache[k]);
    if (missing.length && !statusBusy) {
      await refreshEngineStatus();
    }
    const ms = MONITOR_STATE_FILE ? readJsonFile(MONITOR_STATE_FILE) : null;
    const monByName = {};
    if (ms && ms.engines) {
      for (const [bang, e] of Object.entries(ms.engines)) {
        monByName[e.name] = e;
      }
    }
    const fmt = (key) => {
      const st = statusCache[key];
      if (!st) return { ok: false, error: "no status yet" };
      const blockedAll = [...(st.blocked || []), ...(st.silent || [])];
      const disabled = (st.disabled || []).map((name) => {
        const e = monByName[name];
        const inst = e && e.instances && e.instances[key];
        const last = inst && inst.history && inst.history[inst.history.length - 1];
        return `${name} (${last ? (last.ok ? "wieder ok" : shortReason(last.reason)) : "nicht überwacht"})`;
      });
      return {
        ok: true,
        url: st.url,
        fetchedAt: st.at ? new Date(st.at).toISOString() : null,
        active: `${st.active.length}/${st.enabledGeneral.length}`,
        blocked:
          blockedAll.map((b) => `${b.engine} (${shortReason(b.reason)})`).join(", ") || "-",
        disabled: disabled.join(", ") || "-",
      };
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    if (want && INSTANCES[want]) {
      res.end(JSON.stringify(fmt(want)));
    } else {
      const out = {};
      for (const k of keys) out[k] = fmt(k);
      res.end(JSON.stringify(out));
    }
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
    for (let i = 0; i < attemptsBudget(); i++) {
      const group = nextGroup();
      tried.push(group);
      const subs = groupSubrequests(group);
      if (!subs.length) {
        console.error("group has no usable items, retrying:", JSON.stringify(group));
        continue;
      }
      const results = await Promise.all(
        subs.map(async (s) => {
          const fullQ = s.bangs.map((b) => "!" + b).join(" ") + " " + term;
          const target = s.base + "/search?" + new URLSearchParams({ q: fullQ, format: fmt });
          return { ...s, resp: await fetchOnce(target) };
        })
      );
      last = mergeResponses(results);
      const label = subs
        .map((s) => s.bangs.join(" ") + (s.instance === "searxng" ? "" : "@" + s.instance))
        .join(" | ");
      if (!last) {
        console.error(
          `attempt ${i + 1}/${attemptsBudget()} group [${label}] failed: all sub-requests errored`
        );
        continue;
      }
      const reason = shouldRetry(last.status, last.headers, last.body);
      if (!reason) {
        res.writeHead(last.status, {
          "Content-Type": last.headers["content-type"] || "text/html",
          "X-Router-Engines": label,
          "X-Router-Fallback": String(tried.length - 1),
          "X-Router-Tried": tried
            .map((g) =>
              groupSubrequests(g)
                .map((s) => s.bangs.join(" ") + (s.instance === "searxng" ? "" : "@" + s.instance))
                .join(" | ")
            )
            .join(" -> "),
        });
        res.end(last.body);
        return;
      }
      console.error(`attempt ${i + 1}/${attemptsBudget()} group [${label}] retry: ${reason}`);
    }

    // Attempt budget exhausted: return the last response (or a 502).
    if (last && !last.error) {
      const label = tried.length
        ? tried
            .map((g) =>
              groupSubrequests(g)
                .map((s) => s.bangs.join(" ") + (s.instance === "searxng" ? "" : "@" + s.instance))
                .join(" | ")
            )
            .join(" -> ")
        : "(none)";
      res.writeHead(last.status, {
        "Content-Type": last.headers["content-type"] || "text/html",
        "X-Router-Engines": label,
        "X-Router-Fallback": String(Math.max(tried.length - 1, 0)),
        "X-Router-Tried": label,
      });
      res.end(last.body);
    } else {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "X-Router-Tried": tried
          .map((g) =>
            groupSubrequests(g)
              .map((s) => s.bangs.join(" ") + (s.instance === "searxng" ? "" : "@" + s.instance))
              .join(" | ")
          )
          .join(" -> "),
      });
      res.end(JSON.stringify({ error: "all attempts failed" }));
    }
  })().catch((e) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  });
});

setTimeout(() => { refreshEngineStatus(); }, 3000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`searx-router v${VERSION} listening on :${PORT} -> ${SEARX}`);
  console.log(
    "instances:",
    Object.entries(INSTANCES)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
  );
  console.log(
    "groups:",
    groups
      .map((g) =>
        groupSubrequests(g)
          .map((s) => s.bangs.join(" ") + (s.instance === "searxng" ? "" : "@" + s.instance))
          .join(" | ")
      )
      .join(" || ")
  );
  console.log("groupsSource:", groupsSource);
  console.log(
    `fallback: onEmpty=${FALLBACK_ON_EMPTY} timeoutMs=${TIMEOUT_MS}`
  );
});
