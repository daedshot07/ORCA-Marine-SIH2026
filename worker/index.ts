/**
 * The Worker. It handles /api/* and hands everything else to the assets.
 *
 * THE APP'S BEHAVIOUR IS UNCHANGED. wrangler.toml routes only /api/* through
 * here (run_worker_first); every other path is served by the static assets
 * binding exactly as the dashboard upload served it, service worker and
 * redirects included. If this Worker threw on every request, the app would
 * still load -- because the app never asks it for anything unless the chat
 * flag is on.
 */

import { ALLOWED_ORIGINS, LIMITS, RATE } from "./config.ts";
import { handleChat } from "./chat.ts";
import type { Env } from "./tools.ts";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  // An origin we do not know gets NO cors headers at all, so the browser
  // refuses the response. Echoing an arbitrary Origin back is the same as
  // having no policy.
  if (origin !== null && ALLOWED_ORIGINS.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function json(body: unknown, status: number, origin: string | null): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

/**
 * Per-IP, in memory, per isolate.
 *
 * Worth being precise about what this is: Workers run many short-lived
 * isolates across many colos, so this bounds one client hitting one isolate.
 * It is a speed bump against a runaway loop or a single abusive script, not a
 * defence against a distributed flood. A real limiter needs a Durable Object
 * or Cloudflare's own rate limiting, and staging behind a flag does not earn
 * that complexity -- but pretending this is more than it is would be worse
 * than the gap.
 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE.windowMs);
  if (seen.length >= RATE.maxRequests) {
    hits.set(ip, seen);
    return true;
  }
  seen.push(now);
  hits.set(ip, seen);
  // The map would otherwise grow for the life of the isolate.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= RATE.windowMs)) hits.delete(k);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // Not ours: hand it straight to the assets, unchanged.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (origin !== null && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "origin not allowed" }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    if (rateLimited(ip, Date.now())) {
      const headers = corsHeaders(origin);
      headers.set("Retry-After", String(Math.ceil(RATE.windowMs / 1000)));
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(
        JSON.stringify({ error: "too many requests, slow down" }),
        { status: 429, headers },
      );
    }

    // Size limit before reading the body, and again after: a missing or lying
    // Content-Length must not become an unbounded read.
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > LIMITS.maxBodyBytes) {
      return json({ error: "request too large" }, 413, origin);
    }
    const raw = await request.text();
    if (raw.length > LIMITS.maxBodyBytes) {
      return json({ error: "request too large" }, 413, origin);
    }

    if (url.pathname !== "/api/chat") {
      return json({ error: "not found" }, 404, origin);
    }

    if (typeof env.SARVAM_API_KEY !== "string" || env.SARVAM_API_KEY === "") {
      // Says what is wrong without saying anything about the key itself.
      return json({ error: "chat is not configured on this deployment" }, 503, origin);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400, origin);
    }

    try {
      const answer = await handleChat(env, body);
      return json(answer, 200, origin);
    } catch (err) {
      // Never leak an upstream body or a key. A status code and a safe
      // sentence, and the detail goes to the Worker log only.
      console.error("[chat]", err instanceof Error ? err.message : String(err));
      return json({
        error: "chat_failed",
        answer: "The assistant could not answer just now. The offline safety " +
          "screens still work: check the verdict, ESCAPE and SEA MODE.",
        language: "en-IN",
        verdict: null,
        evidence: [],
      }, 502, origin);
    }
  },
};
