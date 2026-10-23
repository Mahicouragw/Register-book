// GENERATED FILE — do not edit by hand.
// Source: supabase/functions/src/rb-delete-account.ts
// Rebuild with:  npm run build:functions

// rb-delete-account — really deletes the signed-in account.
//
// The browser must never hold the service_role key, so this is the only place
// that can call Supabase's admin deleteUser API. Every rb_ table has
// `on delete cascade` from auth.users, so removing the auth user removes the
// profile, the books, the lines, the shares, the group memberships, the
// messages, the push subscriptions and the notifications with it.
//
// Secrets: none — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the
// platform. No service_role key is ever in Git or in browser code.
//
// If anything goes wrong it returns ok:false with a reason, so the app can say
// honestly "your request is recorded, awaiting processing" instead of pretending.

import { createClient } from "jsr:@supabase/supabase-js@2";

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
  if (req.method !== "POST") return fail(405, "Use POST.");

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

  // ---- explicit confirmation ----------------------------------------------
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { /* empty body is fine */ }
  if (String(body.confirm || "").trim().toUpperCase() !== "DELETE") {
    return fail(400, 'Send { "confirm": "DELETE" } to go ahead.');
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // ---- record the request first, so it is never lost ----------------------
  await admin.from("rb_account_deletions").insert({
    user_id: uid,
    email: user.email || null,
    reason: "self-service deletion",
    status: "processing"
  }).then(() => undefined, () => undefined);

  // ---- count what is about to go (for the honest summary) -----------------
  const counts: Record<string, number> = {};
  async function count(label: string, table: string, column: string) {
    const { count: n } = await admin.from(table).select("id", { count: "exact", head: true }).eq(column, uid);
    counts[label] = n || 0;
  }
  const { data: myRegs } = await admin.from("rb_registers").select("id").eq("owner_id", uid);
  const regIds = (myRegs || []).map(r => r.id);
  let lineCount = 0;
  let shareCount = 0;
  if (regIds.length) {
    const { count: lc } = await admin.from("rb_entries").select("id", { count: "exact", head: true }).in("register_id", regIds);
    lineCount = lc || 0;
    const { count: sc } = await admin.from("rb_shares").select("id", { count: "exact", head: true }).in("register_id", regIds);
    shareCount = sc || 0;
  }
  counts.registers = regIds.length;
  counts.lines = lineCount;
  counts.shares = shareCount;
  await count("groupsCreated", "rb_groups", "created_by");
  const { count: mem } = await admin.from("rb_group_members").select("user_id", { count: "exact", head: true }).eq("user_id", uid);
  counts.memberships = mem || 0;
  const { count: sent } = await admin.from("rb_direct_messages").select("id", { count: "exact", head: true }).eq("sender_id", uid);
  const { count: recv } = await admin.from("rb_direct_messages").select("id", { count: "exact", head: true }).eq("receiver_id", uid);
  counts.messages = (sent || 0) + (recv || 0);

  // ---- the real deletion ---------------------------------------------------
  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) {
    await admin.from("rb_account_deletions")
      .update({ status: "failed", note: delErr.message })
      .eq("user_id", uid)
      .then(() => undefined, () => undefined);
    return fail(500, delErr.message || "Supabase refused to delete the user.");
  }

  // rb_account_deletions.user_id has no foreign key on purpose, so this audit
  // row survives and proves the deletion happened.
  await admin.from("rb_account_deletions")
    .update({ status: "done", note: JSON.stringify(counts) })
    .eq("user_id", uid)
    .then(() => undefined, () => undefined);

  return json({
    ok: true,
    deletedUserId: uid,
    summary: counts,
    message: "Account, books, lines, shares, memberships and messages deleted."
  });
});
