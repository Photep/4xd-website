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
// Optional screenshots and text logs. Contents are checked (image signatures;
// text must be valid UTF-8 without NUL bytes) instead of trusting names or types.
const ATTACHMENTS = { maxFiles: 3, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 };
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const TEXT_EXTENSIONS = new Set(["txt", "log", "ips", "crash", "json"]);
// Room for every text field at its limit in any script (up to 3 UTF-8 bytes per
// character), the Turnstile token, multipart overhead and the attachments.
const MAX_BODY_BYTES = 64 * 1024 + ATTACHMENTS.maxTotalBytes;
const MAX_TOKEN_LENGTH = 2048; // Turnstile's documented maximum
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
// Names and sizes only; the files themselves are stored in Google Drive by the Apps Script.
const ATTACHMENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS report_attachments (
  report_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0
)`;

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

  // Browsers always send Content-Length for a form; without it the size cap
  // could not be applied before the body is read.
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader === null) return json({ ok: false, error: "The report size is missing." }, 411);
  const length = Number(lengthHeader);
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return json({ ok: false, error: "The report is too large. Attachments can total up to 8 MB." }, 413);

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
  if (token.length > MAX_TOKEN_LENGTH) return json({ ok: false, error: "Verification failed. Please try again." }, 400);
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
    // Form submission turns each line break into CRLF, but the browser's
    // maxlength counted it as one character; count it the same way here.
    const value = String(form.get(name) || "").replace(/\r\n?/g, "\n").trim();
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

  const files = form.getAll("attachments").filter((f) => typeof f === "object" && (f.name || f.size));
  if (files.length > ATTACHMENTS.maxFiles) return json({ ok: false, error: `Attach up to ${ATTACHMENTS.maxFiles} files.` }, 400);
  if (files.reduce((sum, f) => sum + f.size, 0) > ATTACHMENTS.maxTotalBytes) return json({ ok: false, error: "The attachments are larger than 8 MB in total." }, 400);
  const attachments = [];
  for (const file of files) {
    const checked = await readAttachment(file);
    if (checked.error) return json({ ok: false, error: checked.error }, 400);
    attachments.push(checked.file);
  }

  const ipHash = await sha256(`${ip}|${env.TURNSTILE_SECRET_KEY}`);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  await env.DB.batch([env.DB.prepare(SCHEMA), env.DB.prepare(INDEX), env.DB.prepare(ATTACHMENTS_SCHEMA)]);
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

  const report = { id: inserted.meta.last_row_id, created_at: now.toISOString(), kind, ...values };
  if (attachments.length === 0) {
    // The report is already saved, so the visitor doesn't wait for Google and a
    // failure there loses nothing.
    ctx.waitUntil(forwardToSheet(report, env));
    return json({ ok: true, report: report.id });
  }
  // Files exist only once Drive has them, so wait and tell the visitor if that failed.
  await env.DB.batch(attachments.map((a) => env.DB.prepare(
    "INSERT INTO report_attachments (report_id, name, type, size, sha256) VALUES (?, ?, ?, ?, ?)",
  ).bind(report.id, a.name, a.type, a.size, a.sha256)));
  const reply = await forwardToSheet(report, env, attachments);
  const saved = reply.ok && reply.attachments === attachments.length;
  if (saved) await env.DB.prepare("UPDATE report_attachments SET saved = 1 WHERE report_id = ?").bind(report.id).run();
  else console.log("attachments not saved", report.id, reply.error || "");
  return json({ ok: true, report: report.id, attachments: attachments.length, attachmentsSaved: saved });
}

// Returns { file } for a supported screenshot or text log, or { error } to show the visitor.
async function readAttachment(file) {
  const original = String(file.name || "file");
  const shown = original.length > 40 ? original.slice(0, 37) + "…" : original;
  const ext = (original.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || "";
  if (file.size === 0) return { error: `“${shown}” is empty.` };
  if (file.size > ATTACHMENTS.maxFileBytes) return { error: `“${shown}” is larger than 4 MB.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let type = null;
  if (IMAGE_TYPES[ext]) {
    if (imageType(bytes) === IMAGE_TYPES[ext]) type = IMAGE_TYPES[ext];
  } else if (TEXT_EXTENSIONS.has(ext) && !bytes.includes(0)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); type = "text/plain"; } catch {}
  }
  if (!type) return { error: `“${shown}” isn’t a supported screenshot (PNG, JPEG, WebP) or text log.` };
  const base = original.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9 ._-]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "attachment";
  return { file: { name: `${base}.${ext}`, type, size: bytes.length, sha256: await sha256Bytes(bytes), bytes } };
}

function imageType(b) {
  const at = (offset, ...values) => values.every((v, i) => b[offset + i] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

function base64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Sends the report (and any attachments) to the Google Apps Script web app
// (apps-script/Code.gs), which saves files to Drive, adds a Sheet row and emails
// it. Does nothing until both secrets are set. Returns the script's reply.
async function forwardToSheet(report, env, attachments = []) {
  if (!env.SHEETS_WEBHOOK_URL || !env.SHEETS_WEBHOOK_TOKEN) return { ok: false, error: "not configured" };
  try {
    const files = attachments.map((a) => ({ name: a.name, type: a.type, size: a.size, data: base64(a.bytes) }));
    const res = await fetch(env.SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: env.SHEETS_WEBHOOK_TOKEN, report, attachments: files }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!reply.ok) console.log("sheet forward rejected", report.id, res.status, reply.error || "");
    return reply;
  } catch (err) {
    console.log("sheet forward failed", report.id, String(err));
    return { ok: false, error: String(err) };
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

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
