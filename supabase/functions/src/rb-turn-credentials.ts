// rb-turn-credentials — hands a signed-in phone a short-lived TURN credential.
//
// Two phones on different networks almost always need a relay: mobile carriers
// and Wi-Fi routers use NAT, so WebRTC cannot connect them directly. Without a
// relay, calls simply fail on real phones.
//
// The long-lived TURN secret must never be in browser code, so:
//   • TURN_URLS        lives in a Supabase secret
//   • TURN_AUTH_SECRET lives in a Supabase secret
//   • this function verifies the caller's JWT and returns a credential that
//     expires in a few hours (coturn's static-auth-secret scheme)
//
// If the secrets are not set, it answers { configured: false } so the app can
// say honestly "your network needs a relay" instead of pretending.
//
// See README.md → "Calling" for how to set up the TURN server.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseTurnUrls, turnUsername, turnCredential } from "../_shared/turn.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function fail(status: number, message: string) {
  return json({ ok: false, error: message }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
      }
    });
  }
  if (req.method !== "POST" && req.method !== "GET") return fail(405, "Use GET or POST.");

  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!url || !serviceKey) return fail(500, "The function is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");

  // ---- who is calling? (from the JWT, never from the body) -----------------
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return fail(401, "Sign in first, then try again.");

  const userClient = createClient(url, anonKey || serviceKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData && userData.user;
  if (userErr || !user) return fail(401, "That sign-in has expired. Sign in again and try.");
  const uid = user.id;

  // ---- is a relay configured at all? ---------------------------------------
  const turnUrls = parseTurnUrls(Deno.env.get("TURN_URLS") || "");
  const authSecret = Deno.env.get("TURN_AUTH_SECRET") || "";

  if (!turnUrls.length || !authSecret) {
    return json({
      ok: true,
      configured: false,
      iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
      message: "No TURN relay is configured yet. Calls will only work between phones on the same Wi-Fi."
    });
  }

  // ---- mint a credential that expires on its own ---------------------------
  const ttl = Number(Deno.env.get("TURN_TTL_SECONDS") || "") || 6 * 60 * 60;
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = turnUsername(uid, expiry);
  const credential = await turnCredential(authSecret, username);

  return json({
    ok: true,
    configured: true,
    username,
    credential,
    expiresAt: expiry,
    ttl,
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      { urls: turnUrls, username, credential }
    ]
  });
});
