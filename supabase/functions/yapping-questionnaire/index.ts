// deno-lint-ignore-file no-explicit-any
/**
 * yapping-questionnaire
 *
 * Receives the Yapping questionnaire (onboarding.the-marketingverse.com/yapping) and:
 *   1. Saves it to yapping_submissions (linked to the client by email when possible)
 *   2. Posts a summary to the internal fulfillment channel, with the full answers in the thread
 *   3. Starts yapping-scripts, which writes the "<Client> - Yapping Scripts" Google Doc
 *
 * Deploy with:
 *   supabase functions deploy yapping-questionnaire --no-verify-jwt
 *
 * Secrets: SLACK_BOT_TOKEN, SLACK_FULFILLMENT_CHANNEL_ID (+ built-in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SLACK_API = "https://slack.com/api";
const AGENCY_ID = "a20503b5-ea8a-4f8e-aa03-8e3030ab22bb";
const SLACK_MAX_CHARS = 38000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

async function slackPost(channel: string, text: string, token: string, threadTs?: string): Promise<string | null> {
  const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, mrkdwn: true, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const data = await resp.json();
  if (!data.ok) {
    console.error(`[Slack] chat.postMessage error: ${data.error}`);
    return null;
  }
  return data.ts as string;
}

function sectionText(section: any): string {
  const lines = [`*${section.title}*`, ""];
  for (const a of section.answers ?? []) {
    lines.push(`*${a.n}. ${a.question}*`);
    lines.push(a.answer ? String(a.answer) : "_Skipped_");
    lines.push("");
  }
  return lines.join("\n").slice(0, SLACK_MAX_CHARS);
}

async function notifySlack(payload: any, clientId: string | null, slackChannelId: string | null): Promise<string | null> {
  const token = Deno.env.get("SLACK_BOT_TOKEN") ?? "";
  const channel = Deno.env.get("SLACK_FULFILLMENT_CHANNEL_ID") ?? "";
  if (!token || !channel) {
    console.warn("[Slack] SLACK_BOT_TOKEN or SLACK_FULFILLMENT_CHANNEL_ID not set — skipping");
    return null;
  }
  const sections: any[] = payload.sections ?? [];
  const answered = sections.reduce((n, s) => n + (s.answers ?? []).filter((a: any) => a.answer).length, 0);
  const total = sections.reduce((n, s) => n + (s.answers ?? []).length, 0);
  const summary = [
    `*🎙️ Yapping questionnaire received: ${payload.clientName}*`,
    `• Email: ${payload.clientEmail}`,
    `• Answered: ${answered} of ${total} questions`,
    slackChannelId ? `• Client channel: <#${slackChannelId}>` : clientId ? null : "• ⚠️ No client in Supabase matches this email",
    "",
    "Full answers in the thread 👇 Scripts doc link will follow there.",
  ].filter((l) => l !== null).join("\n");

  const ts = await slackPost(channel, summary, token);
  if (!ts) return null;
  for (const s of sections) await slackPost(channel, sectionText(s), token, ts);
  return ts;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const clientName = String(payload.clientName ?? "").trim();
  const clientEmail = String(payload.clientEmail ?? "").trim().toLowerCase();
  if (!clientName || !clientEmail || !Array.isArray(payload.sections)) return json({ error: "Missing fields" }, 400);
  payload.clientName = clientName;
  payload.clientEmail = clientEmail;

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: client } = await supabase
    .from("clients")
    .select("id, slack_channel_id")
    .eq("email", clientEmail)
    .eq("agency_id", AGENCY_ID)
    .maybeSingle();

  const { data: saved, error } = await supabase.from("yapping_submissions").insert({
    client_id: client?.id ?? null,
    client_name: clientName,
    email: clientEmail,
    answers: payload.sections,
  }).select("id").single();
  if (error || !saved) {
    console.error("[Supabase] yapping_submissions insert error:", error);
    return json({ error: "Could not save answers" }, 500);
  }

  // Slack + script generation run after responding so the client isn't kept waiting
  const task = (async () => {
    // Start the scripts first: they take minutes, and yapping-scripts answers 202 right away
    try {
      const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/yapping-scripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submission_id: saved.id }),
      });
      if (!resp.ok) console.error("[Scripts] start failed:", resp.status, await resp.text());
    } catch (e) {
      console.error("[Scripts] start error:", e);
    }
    try {
      const ts = await notifySlack(payload, client?.id ?? null, client?.slack_channel_id ?? null);
      if (ts) await supabase.from("yapping_submissions").update({ slack_thread_ts: ts }).eq("id", saved.id);
    } catch (e) {
      console.error("[Slack] error:", e);
    }
  })();
  // @ts-ignore — EdgeRuntime is Supabase's Deno runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(task);

  return json({ ok: true });
});
