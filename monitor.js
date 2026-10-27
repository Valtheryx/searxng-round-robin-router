// searx-engine-monitor — watches blocked search engines and re-adds them to
// the searx-router rotation once they answer cleanly again.
//
// Runs inside the "searx" compose project (next to searxng and searx-router).
// Every MONITOR_INTERVAL_H hours it probes each candidate engine with exactly
// ONE gentle query per instance (no bursts), directly against the SearXNG
// instances via engine bangs. Two clean runs in a row (NEED_PASSES) promote
// the engine: its bang is appended as {b:[bang], i:"<instance>"} to a group in
// GROUPS_FILE; the router picks the file up within 5 s — no restart anywhere.
//
// State lives in MONITOR_STATE_FILE (shared volume, served by the router at
// GET /monitor so external relays can report promotions to the user).
//
// Env:
//   GROUPS_FILE          path to the live groups JSON (read + written)
//   MONITOR_STATE_FILE   path to the state JSON (read + written)
//   SEARXNG_URL          base URL of the default instance (probe fallback)
//   MONITOR_INSTANCES    optional JSON map instanceKey -> base URL to probe
//   MONITOR_INTERVAL_H   hours between runs (default 72)
//   ROUTER_HEALTH_URL    optional; after a promotion the monitor checks /health

const fs = require("fs");
const http = require("http");

const VERSION = "1.3.1";
const GROUPS_FILE = process.env.GROUPS_FILE || "/app/groups.json";
const STATE_FILE = process.env.MONITOR_STATE_FILE || "/app/monitor-state.json";
const INTERVAL_H = parseFloat(process.env.MONITOR_INTERVAL_H || "72");
const ROUTER_HEALTH_URL = process.env.ROUTER_HEALTH_URL || "";
const NEED_PASSES = 2;
const PROBE_SLEEP_S = 5;
const PROBE_TIMEOUT_MS = 35000;

const SEARXNG_URL = process.env.SEARXNG_URL || "http://searxng:8080";
let INSTANCES = { searxng: SEARXNG_URL };
try {
  const raw = (process.env.MONITOR_INSTANCES || "").trim();
  if (raw) INSTANCES = JSON.parse(raw);
} catch (e) {
  console.error("invalid MONITOR_INSTANCES JSON, using default:", e.message);
}

// Engines currently out of the rotation because of upstream blocks (stand
// 2026-10-27, details in the tims-netzwerk skill). qwant/fastbot stay listed:
// qwant also refuses the Fuchsbau IP, fastbot returns empty — the monitor
// keeps checking both cheaply in case they change their minds.
const CANDIDATES = {
  ddg: "duckduckgo",
  gmx: "gmx",
  bi: "bing",
  qw: "qwant",
  yep: "yep",
  pw: "privacywall",
  fa: "fastbot",
  fire: "fireball",
};

const TERMS = [
  "berlin wetter", "linux kernel", "home assistant", "openstreetmap",
  "golang timeout", "python asyncio", "photovoltaik heimverbrauch",
  "rezepte kartoffeln", "electric car battery", "zigbee2mqtt",
  "wireguard dns", "docker compose networks", "postgres index types",
  "rust borrow checker", "kubernetes cni",
];

function fetchJson(base, searchParams, timeoutMs) {
  return new Promise((resolve) => {
    const target = base + "/search?" + new URLSearchParams(searchParams).toString();
    const req = http.get(target, { timeout: timeoutMs }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        try {
          resolve({ data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (e) {
          resolve({ error: "invalid json" });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: String(e.message || e) }));
  });
}

async function probe(bang, term, base) {
  const r = await fetchJson(base, { q: "!" + bang + " " + term, format: "json" }, PROBE_TIMEOUT_MS);
  if (r.error) return { ok: false, reason: r.error };
  const d = r.data;
  if (Array.isArray(d.results) && d.results.length > 0) return { ok: true, reason: "" };
  const unres = d.unresponsive_engines || [];
  if (unres.length > 0) {
    const u = unres[0];
    return { ok: false, reason: Array.isArray(u) ? String(u[1]) : String(u) };
  }
  return { ok: false, reason: "leise leer" };
}

function loadJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    return null;
  }
}

function saveJsonAtomic(path, obj) {
  const tmp = path + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, path);
}

function loadGroups() {
  const f = loadJson(GROUPS_FILE);
  if (Array.isArray(f) && f.length && f.every(Array.isArray)) return f;
  // seed from GROUPS env / defaults on first run
  let seed = null;
  try {
    seed = JSON.parse(process.env.GROUPS || "null");
  } catch (e) {
    /* ignore */
  }
  if (!Array.isArray(seed)) {
    seed = [
      ["goc", "yd", "szn"],
      ["br", "yh", "mwm"],
      ["ddgw", "sch", "nvr"],
      ["rel", "yd", "mwm"],
    ];
  }
  saveJsonAtomic(GROUPS_FILE, seed);
  console.log("groups seeded into", GROUPS_FILE);
  return seed;
}

function isInRotation(bang, instance) {
  const groups = loadGroups();
  for (const g of groups) {
    for (const item of g) {
      if (typeof item === "string") {
        if (instance === "searxng" && item === bang) return true;
      } else if (item && Array.isArray(item.b) && item.i === instance && item.b.includes(bang)) {
        return true;
      }
    }
  }
  return false;
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(null));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function promote(state, bang, name, instance) {
  const groups = loadGroups();
  const idx = (state.promo_counter || 0) % groups.length;
  groups[idx].push({ b: [bang], i: instance });
  saveJsonAtomic(GROUPS_FILE, groups);
  state.promo_counter = (state.promo_counter || 0) + 1;
  let verified = false;
  if (ROUTER_HEALTH_URL) {
    await sleep(6000); // router polls the file every 5 s
    const h = await httpGetJson(ROUTER_HEALTH_URL, 15000);
    verified = !!(h && Array.isArray(h.groups) && h.groups.some((g) => g.some((it) =>
      (typeof it === "string" && instance === "searxng" && it === bang) ||
      (it && Array.isArray(it.b) && it.b.includes(bang) && it.i === instance)
    )));
  }
  state.promotions = state.promotions || [];
  state.promotions.push({
    ts: new Date().toISOString(),
    engine: name,
    bang,
    instance,
    group: idx + 1,
    verified,
  });
  console.log(
    `PROMOTED ${name} (!${bang}) on ${instance} -> group ${idx + 1} (verified: ${verified})`
  );
}

async function run() {
  const state = loadJson(STATE_FILE) || { engines: {}, promo_counter: 0, promotions: [] };
  state.engines = state.engines || {};
  state.promotions = state.promotions || [];
  state.last_run = new Date().toISOString();
  const term = TERMS[Math.floor(Date.now() / 86400000) % TERMS.length];
  const lines = [];

  for (const [bang, name] of Object.entries(CANDIDATES)) {
    const e = (state.engines[bang] = state.engines[bang] || { name, instances: {} });
    for (const [inst, base] of Object.entries(INSTANCES)) {
      const slot = (e.instances = e.instances || {})[inst] =
        e.instances[inst] || { passes: 0, history: [] };
      const r = await probe(bang, term, base);
      slot.history.push({ ts: new Date().toISOString().slice(0, 19), ok: r.ok, reason: r.reason });
      slot.history = slot.history.slice(-40);
      if (r.ok) {
        if (isInRotation(bang, inst)) {
          // already serving in a group — nothing to promote, keep state clean
          slot.passes = 0;
        } else {
          slot.passes = (slot.passes || 0) + 1;
          if (slot.passes >= NEED_PASSES) {
            await promote(state, bang, name, inst);
            lines.push(`PROMOTED ${name} (!${bang}) on ${inst}`);
            slot.passes = 0;
          }
        }
      } else {
        slot.passes = 0;
      }
      saveJsonAtomic(STATE_FILE, state); // keep state fresh even if we die mid-run
      await sleep(PROBE_SLEEP_S * 1000);
    }
  }
  state.finished_run = new Date().toISOString();
  saveJsonAtomic(STATE_FILE, state);
  console.log(
    `run done (${Object.keys(CANDIDATES).length} engines x ${Object.keys(INSTANCES).length} instances)`
  );
}

async function main() {
  console.log(`searx-engine-monitor v${VERSION} starting; interval=${INTERVAL_H}h`);
  await run();
  setInterval(run, Math.max(1, INTERVAL_H) * 3600 * 1000);
}

main().catch((e) => {
  console.error("monitor crashed:", e);
  process.exit(1);
});
