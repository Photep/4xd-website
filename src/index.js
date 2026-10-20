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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") return handleFeedback(request, env, url);
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function handleFeedback(request, env, url) {
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
  if (!(await verifyTurnstile(token, ip, env))) {
    return json({ ok: false, error: "Verification failed. Please try again." }, 403);
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

  await env.DB.prepare(
    `INSERT INTO reports (created_at, kind, version, os, daw, processor, sample_rate, buffer_size,
       preset, description, steps, email, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    now.toISOString(), kind, values.version, values.os, values.daw, values.processor,
    values.sample_rate, values.buffer_size, values.preset, values.description, values.steps,
    values.email, ipHash,
  ).run();

  return json({ ok: true });
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET_KEY) return false;
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
    return outcome.success === true;
  } catch {
    return false;
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
