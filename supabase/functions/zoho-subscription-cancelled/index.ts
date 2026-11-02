// deno-lint-ignore-file no-explicit-any
/**
 * zoho-subscription-cancelled
 *
 * Zoho Billing webhook for the "Subscription Cancelled" event (owner 2026-11-03). For the cancelled client:
 *   1. GHL: every opportunity of the contact moves to the "Cancelled" stage of its pipeline (stage found by name);
 *      tag "cancelled" added, tag "mverse - client" removed.
 *   2. Calendar app: clients.status = 'cancelled' (matched by email, then by name) — monthly reports/notes skip them.
 *   3. Slack #mv-main (C03B8R3NZJ4): "<client> cancelled" + what was updated + reminder to remove them from the
 *      clients' WhatsApp group.
 *
 * Plans in app_settings.zoho_cancel_ignore_plans (JSON array of plan codes: add-ons, one-time projects, the Slack seat)
 * never count as a client leaving (owner 2026-11-03) → 200 { ignored }.
 * Only reacts to cancellations (event_type subscription_cancelled, or a subscription whose status is cancelled);
 * anything else gets 200 { ignored }. Kept separate from zoho-subscription-onboarding, which onboards on ANY event.
 * Auth: ?key= must equal app_settings.zoho_cancel_key (verify_jwt off — Zoho can't send a Supabase JWT).
 * ?dry=1 → finds everything and reports what it WOULD do, changes nothing and posts nothing.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AGENCY_ID = "a20503b5-ea8a-4f8e-aa03-8e3030ab22bb";
const GHL = "https://services.leadconnectorhq.com";
const CLIENT_TAG = "mverse - client";
const CANCELLED_TAG = "cancelled";
const SLACK_CHANNEL = "C03B8R3NZJ4"; // #mv-main
const SLACK_API = "https://slack.com/api";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Environment variable "${k}" is not set`);
  return v;
};
const db = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function extract(body: Record<string, any>) {
  const sub: Record<string, any> = body.subscription ?? body.data?.subscription ?? {};
  const customer: Record<string, any> = sub.customer ?? {};
  return {
    eventType: String(body.event_type ?? body.data?.event_type ?? "").toLowerCase(),
    status: String(sub.status ?? "").toLowerCase(),
    name: (customer.display_name || sub.customer_name || body.customer_name || "").trim() || null,
    email: (customer.email || sub.customer_email || sub.email || body.customer_email || "").trim().toLowerCase() || null,
    plan: (sub.plan?.name || sub.plan_name || sub.plan?.plan_code || sub.plan_code || "").trim() || null,
    planCode: String(sub.plan?.plan_code || sub.plan_code || "").trim().toLowerCase(),
    cancelledOn: sub.cancelled_date || sub.cancelled_at || sub.expires_at || null,
    reason: (sub.cancel_reason || sub.cancellation_reason || "").trim() || null,
  };
}

// ── GHL ──────────────────────────────────────────────────────────────────────────────────────
async function ghl(path: string, init: RequestInit = {}) {
  const res = await fetch(`${GHL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env("GHL_API_KEY")}`, "Content-Type": "application/json", Version: "2021-07-28", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`GHL ${init.method || "GET"} ${path.split("?")[0]} → ${res.status}: ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function updateGhl(email: string, dry: boolean) {
  const locationId = env("GHL_LOCATION_ID");
  const found = await ghl(`/contacts/?${new URLSearchParams({ locationId, query: email, limit: "5" })}`);
  const contacts: any[] = found?.contacts ?? [];
  const contact = contacts.find((c) => String(c.email || "").toLowerCase() === email) ?? null;
  if (!contact) return { contact: null, note: "No GHL contact with this email" };

  const out: Record<string, any> = { contact: contact.id, tagsBefore: contact.tags ?? [], opportunities: [] };
  // Opportunities → "Cancelled" stage of their own pipeline.
  const [opps, pipes] = await Promise.all([
    ghl(`/opportunities/search?${new URLSearchParams({ location_id: locationId, contact_id: contact.id, limit: "20" })}`),
    ghl(`/opportunities/pipelines?${new URLSearchParams({ locationId })}`),
  ]);
  const pipelines: any[] = pipes?.pipelines ?? [];
  for (const o of opps?.opportunities ?? []) {
    const pipe = pipelines.find((p) => p.id === o.pipelineId);
    const stage = (pipe?.stages ?? []).find((s: any) => /^cancel/i.test(String(s.name).trim()));
    const entry: Record<string, any> = { id: o.id, name: o.name, pipeline: pipe?.name ?? o.pipelineId, from: (pipe?.stages ?? []).find((s: any) => s.id === o.pipelineStageId)?.name ?? null };
    if (!stage) entry.skipped = "pipeline has no Cancelled stage";
    else if (stage.id === o.pipelineStageId) entry.skipped = "already Cancelled";
    else {
      entry.to = stage.name;
      if (!dry) await ghl(`/opportunities/${o.id}`, { method: "PUT", body: JSON.stringify({ pipelineId: o.pipelineId, pipelineStageId: stage.id }) });
    }
    out.opportunities.push(entry);
  }
  if (!dry) {
    await ghl(`/contacts/${contact.id}/tags`, { method: "POST", body: JSON.stringify({ tags: [CANCELLED_TAG] }) });
    await ghl(`/contacts/${contact.id}/tags`, { method: "DELETE", body: JSON.stringify({ tags: [CLIENT_TAG] }) });
  }
  out.tags = { added: CANCELLED_TAG, removed: CLIENT_TAG };
  return out;
}

// ── Calendar app ───────────────────────────────────────────────────────────────────────────
async function updateCalendar(email: string | null, name: string | null, dry: boolean) {
  const sb = db();
  let row: any = null;
  if (email) row = (await sb.from("clients").select("id, name, status").eq("agency_id", AGENCY_ID).ilike("email", email).limit(1).maybeSingle()).data;
  if (!row && name) {
    const { data } = await sb.from("clients").select("id, name, status").eq("agency_id", AGENCY_ID).ilike("name", name).limit(2);
    if (data?.length === 1) row = data[0];   // only an unambiguous name match
  }
  if (!row) return { client: null, note: "No calendar client with this email or name" };
  if (row.status === "cancelled") return { client: row.id, name: row.name, note: "already cancelled" };
  if (!dry) {
    const { error } = await sb.from("clients").update({ status: "cancelled" }).eq("id", row.id);
    if (error) throw new Error(`clients update: ${error.message}`);
  }
  return { client: row.id, name: row.name, from: row.status, to: "cancelled" };
}

// ── Slack ──────────────────────────────────────────────────────────────────────────────────
async function slackPost(text: string) {
  const call = (method: string, body: unknown) => fetch(`${SLACK_API}/${method}`, {
    method: "POST", headers: { Authorization: `Bearer ${env("SLACK_BOT_TOKEN")}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
  }).then((r) => r.json());
  let r = await call("chat.postMessage", { channel: SLACK_CHANNEL, text, unfurl_links: false });
  if (!r.ok && r.error === "not_in_channel") {
    await call("conversations.join", { channel: SLACK_CHANNEL });
    r = await call("chat.postMessage", { channel: SLACK_CHANNEL, text, unfurl_links: false });
  }
  if (!r.ok) throw new Error(`Slack: ${r.error}`);
  return r.ts;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { data: keyRow } = await db().from("app_settings").select("value").eq("key", "zoho_cancel_key").maybeSingle();
  if (!keyRow?.value || url.searchParams.get("key") !== keyRow.value) return json({ error: "Unauthorized" }, 401);
  const dry = url.searchParams.get("dry") === "1";

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  console.log("[zoho-cancelled] payload:", JSON.stringify(body).slice(0, 4000));

  const c = extract(body);
  const isCancel = c.eventType === "subscription_cancelled" || (!c.eventType.includes("scheduled") && c.status === "cancelled");
  if (!isCancel) return json({ ok: true, ignored: `not a cancellation (event_type="${c.eventType}", status="${c.status}")` });
  const { data: ign } = await db().from("app_settings").select("value").eq("key", "zoho_cancel_ignore_plans").maybeSingle();
  let ignorePlans: string[] = [];
  try { ignorePlans = JSON.parse(ign?.value || "[]").map((x: string) => String(x).toLowerCase()); } catch { /* none */ }
  if (c.planCode && ignorePlans.includes(c.planCode)) return json({ ok: true, ignored: `plan "${c.planCode}" is an add-on / one-time plan, not a client leaving` });
  if (!c.email && !c.name) return json({ error: "No customer email or name in the payload", keys: Object.keys(body) }, 400);

  const result: Record<string, any> = { ok: true, dry, client: { name: c.name, email: c.email, plan: c.plan } };
  try { result.ghl = c.email ? await updateGhl(c.email, dry) : { note: "no email in payload" }; }
  catch (e) { result.ok = false; result.ghl = { error: (e as Error).message }; }
  try { result.calendar = await updateCalendar(c.email, c.name, dry); }
  catch (e) { result.ok = false; result.calendar = { error: (e as Error).message }; }

  const g = result.ghl, cal = result.calendar;
  const moved = (g?.opportunities ?? []).filter((o: any) => o.to).length;
  const lines = [
    `🚫 *${c.name || c.email} has cancelled their subscription*${c.plan ? ` (${c.plan})` : ""}.`,
    c.reason ? `Reason: ${c.reason}` : null,
    `• GHL: ${g?.error ? `⚠️ ${g.error}` : g?.contact ? `tagged "cancelled", "mverse - client" removed${moved ? `, ${moved} opportunit${moved === 1 ? "y" : "ies"} moved to Cancelled` : " (no opportunity moved — check the pipeline)"}` : "⚠️ contact not found — update it by hand"}`,
    `• Calendar: ${cal?.error ? `⚠️ ${cal.error}` : cal?.client ? `status set to cancelled${cal.note ? ` (${cal.note})` : ""}` : "⚠️ client not found — set the status by hand"}`,
    `👉 *Reminder:* remove them from the clients' WhatsApp group.`,
  ].filter(Boolean);
  result.slack_text = lines.join("\n");
  if (!dry) {
    try { result.slack = await slackPost(result.slack_text); }
    catch (e) { result.ok = false; result.slack = { error: (e as Error).message }; }
  }
  console.log("[zoho-cancelled] result:", JSON.stringify(result));
  return json(result);
});
