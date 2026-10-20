// Worker for the 4xD site. Static files in public/ are served directly; only
// /api/* reaches this script (see run_worker_first in wrangler.jsonc).

const TEXT_FIELDS = {
  version: { max: 80, required: true },
  os: { max: 120, required: true },
  daw: { max: 120, required: true },
  processor: { max: 120 },
  sample_rate: { max: 120 },
  buffer_size: { max: 120 },
  preset: { max: 120 },
  description: { max: 5000, required: true },
  steps: { max: 5000 },
  email: { max: 254 },
};
const KINDS = new Set(["bug", "feedback"]);
const MAX_BODY_BYTES = 32 * 1024;
const PER_IP_PER_HOUR = 5;

const SCHEMA = `CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  daw TEXT NOT NULL,
  processor TEXT,
  sample_rate TEXT,
  buffer_size TEXT,
  preset TEXT,
  description TEXT NOT NULL,
  steps TEXT,
  email TEXT,
  ip_hash TEXT NOT NULL
)`;
const INDEX = "CREATE INDEX IF NOT EXISTS reports_ip_time ON reports (ip_hash, created_at)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") return handleFeedback(request, env, ctx, url);
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Not found." }, 404);
    if (url.pathname.startsWith("/downloads/")) return handleDownload(request, env, ctx, url);
    return env.ASSETS.fetch(request);
  },
};

// Installer downloads are served from public/ as before; the Worker only counts them.
// One row per day, file and visitor (IP hashed with a salt that changes daily), so
// COUNT(*) gives unique downloads and SUM(hits) gives every counted request.
const DOWNLOADS_SCHEMA = `CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,
  file TEXT NOT NULL,
  visitor TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, file, visitor)
)`;
const BOT_AGENTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|vkshare|skypeuripreview/i;

async function handleDownload(request, env, ctx, url) {
  const response = await env.ASSETS.fetch(request);
  if (isCountable(request, response)) {
    ctx.waitUntil(recordDownload(request, env, decodeURIComponent(url.pathname.slice("/downloads/".length))));
  }
  return response;
}

function isCountable(request, response) {
  if (request.method !== "GET") return false;
  if (BOT_AGENTS.test(request.headers.get("User-Agent") || "")) return false;
  // Resumed downloads and download managers fetch later byte ranges separately;
  // only the request that starts at the beginning of the file counts.
  const range = request.headers.get("Range");
  if (range && !/^bytes=0-/.test(range.trim())) return false;
  return response.status === 200 || response.status === 206;
}

async function recordDownload(request, env, file) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const visitor = (await sha256(`${day}|${ip}|${env.TURNSTILE_SECRET_KEY}`)).slice(0, 32);
    await env.DB.batch([
      env.DB.prepare(DOWNLOADS_SCHEMA),
      env.DB.prepare(
        `INSERT INTO downloads (day, file, visitor) VALUES (?, ?, ?)
         ON CONFLICT (day, file, visitor) DO UPDATE SET hits = hits + 1`,
      ).bind(day, file, visitor),
    ]);
  } catch (err) {
    console.log("download count failed", file, String(err));
  }
}

async function handleFeedback(request, env, ctx, url) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Use POST." }, 405, { Allow: "POST" });
  }

  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== url.host) {
    return json({ ok: false, error: "Cross-site submissions are not accepted." }, 403);
  }

  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return json({ ok: false, error: "The report is too large." }, 413);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "The form data could not be read." }, 400);
  }

  // Honeypot: people never see this field, so anything in it came from a bot.
  // Reply as if it worked so the bot gets no signal.
  if (String(form.get("website") || "").trim() !== "") return json({ ok: true });

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const token = String(form.get("cf-turnstile-response") || "");
  if (!token) return json({ ok: false, error: "Please complete the verification check." }, 400);
  const check = await verifyTurnstile(token, ip, env);
  if (!check.ok) {
    console.log("turnstile rejected", check.code);
    return json({ ok: false, error: "Verification failed. Please try again.", code: check.code }, 403);
  }

  const kind = String(form.get("kind") || "");
  if (!KINDS.has(kind)) return json({ ok: false, error: "Choose a report type." }, 400);

  const values = {};
  for (const [name, rule] of Object.entries(TEXT_FIELDS)) {
    const value = String(form.get(name) || "").trim();
    if (value.length > rule.max) {
      return json({ ok: false, error: `Please shorten ${label(name)}.` }, 400);
    }
    const required = rule.required || (name === "steps" && kind === "bug");
    if (required && !value) return json({ ok: false, error: `Please fill in ${label(name)}.` }, 400);
    values[name] = value || null;
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return json({ ok: false, error: "Please check the email address." }, 400);
  }

  const ipHash = await sha256(`${ip}|${env.TURNSTILE_SECRET_KEY}`);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  await env.DB.batch([env.DB.prepare(SCHEMA), env.DB.prepare(INDEX)]);
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?",
  ).bind(ipHash, hourAgo).first("n");
  if (recent >= PER_IP_PER_HOUR) {
    return json({ ok: false, error: "Too many reports from this connection. Please try again later." }, 429);
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO reports (created_at, kind, version, os, daw, processor, sample_rate, buffer_size,
       preset, description, steps, email, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    now.toISOString(), kind, values.version, values.os, values.daw, values.processor,
    values.sample_rate, values.buffer_size, values.preset, values.description, values.steps,
    values.email, ipHash,
  ).run();

  // The report is already saved, so the visitor doesn't wait for Google and a
  // failure there loses nothing.
  const report = { id: inserted.meta.last_row_id, created_at: now.toISOString(), kind, ...values };
  ctx.waitUntil(forwardToSheet(report, env));

  return json({ ok: true });
}

// Sends the report to the Google Apps Script web app (apps-script/Code.gs), which
// adds a Sheet row and emails it. Does nothing until both secrets are set.
async function forwardToSheet(report, env) {
  if (!env.SHEETS_WEBHOOK_URL || !env.SHEETS_WEBHOOK_TOKEN) return;
  try {
    const res = await fetch(env.SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: env.SHEETS_WEBHOOK_TOKEN, report }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!reply.ok) console.log("sheet forward rejected", report.id, res.status, reply.error || "");
  } catch (err) {
    console.log("sheet forward failed", report.id, String(err));
  }
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, code: "missing-secret" };
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const outcome = await res.json();
    if (outcome.success === true) return { ok: true };
    return { ok: false, code: (outcome["error-codes"] || []).join(",") || "rejected" };
  } catch {
    return { ok: false, code: "siteverify-unreachable" };
  }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function label(name) {
  return {
    version: "the 4xD version",
    os: "the operating system",
    daw: "the DAW and version",
    description: "the description",
    steps: "the steps to reproduce",
  }[name] || `the ${name.replace("_", " ")}`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
