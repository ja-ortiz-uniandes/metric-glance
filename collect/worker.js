/**
 * Metric Glance collection Worker.
 *
 * Accepts batched training records from the extension and:
 *   1. Verifies an HMAC-SHA256 over (timestamp "." rawBody) using a shared
 *      secret. The secret ships in the extension and is extractable, so this
 *      is NOT proof of a legitimate install. It filters unsigned drive-by
 *      traffic and naive replay (timestamp window), nothing more.
 *   2. Validates every record server-side against a strict shape and value
 *      rules. This is the real defence against junk/poisoning: an attacker now
 *      has to send well-formed, plausible records, not garbage.
 *   3. Throttles per install_id per 24h.
 *   4. Inserts into D1 with a UNIQUE dedup_key (INSERT OR IGNORE), so client
 *      retries never duplicate rows.
 *
 * Nothing here is trusted on its own. The point is to keep the dataset clean
 * enough that dedup + a human review before training is cheap.
 *
 * Bindings:
 *   env.DB              D1 database (see wrangler.toml)
 *   env.MG_HMAC_SECRET  shared signing secret (wrangler secret put MG_HMAC_SECRET)
 */

const MAX_BODY_BYTES = 256 * 1024; // reject larger bodies outright
const MAX_RECORDS = 100;           // per POST
const SIG_WINDOW_S = 300;          // accept timestamps within +/- 5 minutes
const DAILY_CAP = 2000;            // max accepted rows per install per 24h

const ALLOWED_TIERS = new Set(["corrected", "seen", "auto"]);
const LABEL_RE = /^(unit|price|not_a_conversion|interpretation:[\w.-]{1,40}|convert-as:[\w.-]{1,40}|auto:[\w.-]{1,40}|seen:[\w.-]{1,40})$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63})(\.[a-z0-9-]{1,63})*$/i; // bare hostname, no slashes
const INSTALL_RE = /^[0-9a-f-]{8,64}$/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-MG-Ts, X-MG-Sig",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(msg) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Length-independent compare for two hex strings (avoids early-exit timing leak).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Field helpers: return cleaned value, or null to signal "reject this record".
function str(v, max) {
  if (v == null) return "";
  if (typeof v !== "string") return null;
  return v.length <= max ? v : null;
}
function intOrNull(v) {
  if (v == null) return null;
  return Number.isInteger(v) ? v : null;
}
function numOrNull(v) {
  if (v == null) return null;
  return typeof v === "number" && isFinite(v) ? v : null;
}

// Strict record validator. Returns a normalized row, or null if malformed.
function validateRecord(r) {
  if (!r || typeof r !== "object") return null;

  if (typeof r.label !== "string" || !LABEL_RE.test(r.label)) return null;
  if (!ALLOWED_TIERS.has(r.tier)) return null;

  const span = str(r.span, 200);
  if (span === null || span === "") return null;

  const before = str(r.before, 400);
  const after = str(r.after, 200);
  const sentence = str(r.sentence, 300);
  const unit = str(r.unit, 40);
  const heading = str(r.heading, 120);
  const tag = str(r.tag, 32);
  const lang = str(r.lang, 16);
  const title = str(r.title, 120);
  const locale = str(r.locale, 16);
  if ([before, after, sentence, unit, heading, tag, lang, title, locale].some((x) => x === null)) return null;

  let unit_id = null;
  if (r.unit_id != null) {
    unit_id = str(r.unit_id, 40);
    if (unit_id === null) return null;
  }

  // url must be a bare hostname. The client only ever sends location.hostname;
  // reject anything that looks like a full URL or path so we never store one.
  let url = "";
  if (r.url != null) {
    if (typeof r.url !== "string") return null;
    if (r.url !== "" && !HOST_RE.test(r.url)) return null;
    url = r.url;
  }

  let page_units = [];
  if (r.page_units != null) {
    if (!Array.isArray(r.page_units) || r.page_units.length > 40) return null;
    for (const u of r.page_units) if (typeof u !== "string" || u.length > 40) return null;
    page_units = r.page_units;
  }

  const client_ts = intOrNull(r.ts);
  if (client_ts === null) return null;

  return {
    label: r.label, tier: r.tier, span,
    num: numOrNull(r.num), unit, unit_id,
    before, after, sentence,
    heading, tag, page_units: JSON.stringify(page_units),
    span_start: intOrNull(r.span_start), span_end: intOrNull(r.span_end),
    interacted: r.interacted ? 1 : 0,
    seen: r.seen ? 1 : 0,
    url, lang, title, locale,
    client_ts,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
    if (!env.MG_HMAC_SECRET) return json({ ok: false, error: "server_misconfigured" }, 500);

    const declaredLen = Number(request.headers.get("content-length") || "0");
    if (declaredLen > MAX_BODY_BYTES) return json({ ok: false, error: "too_large" }, 413);

    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return json({ ok: false, error: "too_large" }, 413);

    // --- HMAC gate (timestamp-bound) ---
    const ts = Number(request.headers.get("x-mg-ts") || "");
    const sig = (request.headers.get("x-mg-sig") || "").toLowerCase();
    if (!Number.isFinite(ts)) return json({ ok: false, error: "bad_ts" }, 401);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > SIG_WINDOW_S) return json({ ok: false, error: "stale" }, 401);
    const expected = await hmacHex(env.MG_HMAC_SECRET, ts + "." + body);
    if (!safeEqual(expected, sig)) return json({ ok: false, error: "bad_sig" }, 401);

    // --- parse + envelope shape ---
    let payload;
    try { payload = JSON.parse(body); } catch { return json({ ok: false, error: "bad_json" }, 400); }
    const installId = payload && payload.install_id;
    if (typeof installId !== "string" || !INSTALL_RE.test(installId)) {
      return json({ ok: false, error: "bad_install" }, 400);
    }
    const records = payload && payload.records;
    if (!Array.isArray(records) || records.length < 1 || records.length > MAX_RECORDS) {
      return json({ ok: false, error: "bad_batch" }, 400);
    }

    // --- per-install daily cap ---
    let used = 0;
    try {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM submissions WHERE install_id = ? AND received_at > ?"
      ).bind(installId, now - 86400).first();
      used = (row && row.n) || 0;
    } catch {
      return json({ ok: false, error: "db" }, 500);
    }
    if (used >= DAILY_CAP) return json({ ok: false, error: "rate_limited", inserted: 0 }, 429);
    const room = DAILY_CAP - used;

    // --- validate, build statements ---
    const insert = env.DB.prepare(
      `INSERT OR IGNORE INTO submissions
        (dedup_key, install_id, label, tier, span, num, unit, unit_id,
         before_ctx, after_ctx, sentence, heading, tag, page_units,
         span_start, span_end, interacted, seen, url, lang, title, locale,
         client_ts, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const stmts = [];
    let skipped = 0;
    for (const raw of records) {
      if (stmts.length >= room) break;
      const v = validateRecord(raw);
      if (!v) { skipped++; continue; }
      const dedup = await sha256Hex(
        [installId, v.client_ts, v.label, v.span, v.span_start, v.span_end].join("|")
      );
      stmts.push(insert.bind(
        dedup, installId, v.label, v.tier, v.span, v.num, v.unit, v.unit_id,
        v.before, v.after, v.sentence, v.heading, v.tag, v.page_units,
        v.span_start, v.span_end, v.interacted, v.seen, v.url, v.lang, v.title, v.locale,
        v.client_ts, now
      ));
    }

    let inserted = 0;
    if (stmts.length) {
      try {
        const results = await env.DB.batch(stmts);
        for (const r of results) inserted += (r.meta && r.meta.changes) || 0; // 0 when ignored as dup
      } catch {
        return json({ ok: false, error: "db_write" }, 500);
      }
    }
    return json({ ok: true, inserted, skipped });
  },
};
