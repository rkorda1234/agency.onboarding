// deno-lint-ignore-file no-explicit-any
/**
 * yapping-scripts
 *
 * Turns a Yapping questionnaire submission into talking-to-camera scripts and saves them
 * as the Google Doc "<Client Name> - Yapping Scripts" in the client's Drive folder, then
 * posts the link in the submission's Slack thread (fulfillment channel).
 *
 * Called by yapping-questionnaire with { submission_id }. Responds 202 immediately and does
 * the work in the background. Only submissions whose scripts_status is 'pending' or 'failed'
 * are processed, so a repeat call can't regenerate (or bill) twice; set the status back to
 * 'failed' to retry one.
 *
 * Deploy with:
 *   supabase functions deploy yapping-scripts --no-verify-jwt
 *
 * Secrets: ANTHROPIC_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_DRIVE_CLIENTS_FOLDER_ID,
 *          SLACK_BOT_TOKEN, SLACK_FULFILLMENT_CHANNEL_ID
 */

import Anthropic from "npm:@anthropic-ai/sdk@1.1.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SLACK_API = "https://slack.com/api";
const MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You are the head of content at Marketingverse, a social media agency. You write "Yapping" videos: one person talking straight to camera, sharing a perspective. No skits, little B-roll, low production. It works because people don't follow creators for information, they follow them for perspective.

The goal of every video: the viewer starts guarded and skeptical, and by the end their guard is down, they feel understood, and they want to hear more from this person.

THE FOUR LENSES (every script uses at least one, ideally two)
1. Association: only talk about topics the creator wants to be known for (their pillars). An off-pillar viral video builds the wrong audience.
2. Perspective (the hot take): something the creator disagrees with that most people in their niche repeat. If a competitor could say the hook word for word, it is not a hot take. Structure: state the take plainly, explain the reasoning, reframe what the audience should believe instead.
3. Experience: why they think this way. A real story turns an opinion into earned wisdom: what happened, advice that failed them, what they used to believe, wins, and especially failures (vulnerability builds trust faster than wins).
4. Inner monologue: say what the ideal client thinks but would be embarrassed to say out loud, so viewers see themselves in the video.

SCRIPT STRUCTURE
1. Hook (first 1-3 seconds, one or two sentences): lead with the hot take or the inner-monologue line. Never "Hi guys" or context first.
2. The why: reasoning plus a personal story or proof.
3. The reframe: what to believe or do instead. One idea, not five.
4. Close: a short line that restates the take, plus a soft CTA (follow for more, or a question that invites comments, or the creator's free giveaway in exchange for a comment if they have one). No hard pitch.
Length: 30-75 seconds spoken, roughly 80-200 words.

WRITE FOR THE MOUTH, NOT THE PAGE
Short sentences. Contractions. The words the audience uses every day. One idea per sentence, sayable in one breath. No jargon, no corporate phrasing, no lists read aloud. Use the creator's own phrases, catchphrase and sign-off from their answers.

MARKETINGVERSE METHOD
The hot take is the Tema (emotional entry point); the reframe is the Moral. "Conflicto -> Forma incorrecta -> Forma correcta" fits hot-take videos; "Identificacion -> Historia -> Contenido" fits story-led ones. Close by planting one seed (Lider, Movimiento or Producto), never a pitch. Yapping maps to the Lo-Fi and Trivial formats (talking during an everyday task), so set delivery in the places the creator said they would film.

HARD RULES
- Use only facts, stories, numbers and results the creator gave. Never invent a personal story, client result, number or failure. When a script needs a story they did not give, write a clearly marked placeholder like [STORY: the time a buyer almost lost a house over the inspection] and list what the creator needs to tell you.
- Respect every topic they said they do NOT want to talk about.
- Write in the language the creator answered in. If they answered in Spanish, write natural spoken Spanish, not translated English.
- Never mention AI, automation, or how these scripts were made.
- Quality check each script: would a competitor post this hook word for word? Is there a real opinion, not just information? Is there a reason they believe it? Would the ideal viewer see themselves in it? Is it on one of their pillars? Cut any sentence that is hard to say out loud.

OUTPUT (Markdown, nothing before or after)
# {Client name} - Yapping Scripts
One short paragraph: who these videos are for and the angle that runs through them.

## Overview
A table with columns: #, Concept, Lenses, Pillar.

## Scripts
Write 8 scripts, spreading the lenses across the batch. For each:
### {n}. {Concept title}
**Lenses:** ... | **Pillar:** ...
**Hook options:**
- A) ...
- B) ...
- C) ...
**Script (word for word):**
(the spoken script, in short paragraphs)
**On-screen text:** 3-8 words
**Delivery notes:** energy, where to pause, setting
**Caption:** 2-4 lines ending with a comment-driving question
**Needs from creator:** placeholders to fill, or "None"

## More hooks to film
10 extra one-line hooks drawn from their answers, each tagged with its lens.

## Questions for the creator
The few follow-up questions that would unlock better scripts (only if their answers left real gaps).`;

function answersText(sections: any[]): string {
  return sections.map((s) => {
    const qa = (s.answers ?? []).map((a: any) => `${a.n}. ${a.question}\n${a.answer ? a.answer : "(skipped)"}`).join("\n\n");
    return `## ${s.title}\n\n${qa}`;
  }).join("\n\n");
}

async function generateScripts(clientName: string, client: any, sections: any[]): Promise<string> {
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const brand = client
    ? [
      client.industry ? `Industry: ${client.industry}` : null,
      client.handle ? `Instagram: ${client.handle}` : null,
      client.bio ? `Brand overview: ${client.bio}` : null,
      client.content_guidelines ? `Brand voice and guidelines:\n${client.content_guidelines}` : null,
    ].filter(Boolean).join("\n")
    : "";

  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Client name: ${clientName}\n\n${brand ? `What we already know about their brand:\n${brand}\n\n` : ""}Their questionnaire answers:\n\n${answersText(sections)}`,
    }],
  } as any);
  const message: any = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("Model declined the request");
  const text = (message.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
  if (!text) throw new Error(`Empty response (stop_reason=${message.stop_reason})`);
  return text;
}

// ─── Google Drive ──────────────────────────────────────────────────────────────
async function getGoogleAccessToken(): Promise<string> {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })}`;
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----\n?/, "")
    .replace(/\n?-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

// The client's folder is the one creative-brief-onboarding created under the clients folder,
// named after the client. Fall back to creating it if no folder with any of the names exists.
async function findOrCreateClientFolder(names: string[], parentId: string, token: string): Promise<string> {
  for (const name of names) {
    const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false and name='${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const resp = await fetch(
      "https://www.googleapis.com/drive/v3/files?" +
        new URLSearchParams({ q, fields: "files(id,name)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" }),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await resp.json();
    if (data.files?.length) return data.files[0].id as string;
  }
  const resp = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: names[0], mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const data = await resp.json();
  if (!data.id) throw new Error(`Drive folder creation failed: ${JSON.stringify(data)}`);
  return data.id as string;
}

async function uploadDoc(name: string, content: string, folderId: string, token: string, contentType: string): Promise<any> {
  const boundary = "mv_multipart_boundary";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name, mimeType: "application/vnd.google-apps.document", parents: [folderId] }),
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");
  const resp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body },
  );
  return resp.json();
}

async function saveScriptsDoc(docName: string, folderNames: string[], markdown: string): Promise<string> {
  const parentId = Deno.env.get("GOOGLE_DRIVE_CLIENTS_FOLDER_ID");
  if (!parentId) throw new Error("GOOGLE_DRIVE_CLIENTS_FOLDER_ID not set");
  const token = await getGoogleAccessToken();
  const folderId = await findOrCreateClientFolder(folderNames, parentId, token);
  // Markdown import keeps headings, bold and tables; plain text is the fallback.
  let data = await uploadDoc(docName, markdown, folderId, token, "text/markdown");
  if (!data.id) {
    console.warn("[Drive] Markdown import failed, retrying as plain text:", JSON.stringify(data));
    data = await uploadDoc(docName, markdown, folderId, token, "text/plain");
  }
  if (!data.id) throw new Error(`Drive upload failed: ${JSON.stringify(data)}`);
  return data.webViewLink ?? `https://docs.google.com/document/d/${data.id}/edit`;
}

// ─── Slack ─────────────────────────────────────────────────────────────────────
async function slackPost(text: string, threadTs: string | null): Promise<void> {
  const token = Deno.env.get("SLACK_BOT_TOKEN") ?? "";
  const channel = Deno.env.get("SLACK_FULFILLMENT_CHANNEL_ID") ?? "";
  if (!token || !channel) return;
  const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, mrkdwn: true, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const data = await resp.json();
  if (!data.ok) console.error(`[Slack] chat.postMessage error: ${data.error}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function process(submission: any, supabase: any): Promise<void> {
  try {
    let client: any = null;
    if (submission.client_id) {
      const { data } = await supabase
        .from("clients")
        .select("name, brand_name, industry, handle, bio, content_guidelines")
        .eq("id", submission.client_id)
        .maybeSingle();
      client = data;
    }
    const clientName = client?.name || submission.client_name;
    const markdown = await generateScripts(clientName, client, submission.answers ?? []);
    const folderNames = [...new Set([client?.name, client?.brand_name, submission.client_name].filter(Boolean))] as string[];
    const docUrl = await saveScriptsDoc(`${clientName} - Yapping Scripts`, folderNames, markdown);

    await supabase.from("yapping_submissions")
      .update({ scripts_status: "done", scripts_doc_url: docUrl, scripts_error: null })
      .eq("id", submission.id);
    const { data: latest } = await supabase.from("yapping_submissions").select("slack_thread_ts").eq("id", submission.id).maybeSingle();
    await slackPost(`📝 Yapping scripts ready for *${clientName}*: <${docUrl}|${clientName} - Yapping Scripts>`, latest?.slack_thread_ts ?? null);
    console.log(`[yapping-scripts] Done for ${clientName}: ${docUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[yapping-scripts] Failed:", msg);
    await supabase.from("yapping_submissions").update({ scripts_status: "failed", scripts_error: msg.slice(0, 1000) }).eq("id", submission.id);
    const { data: latest } = await supabase.from("yapping_submissions").select("slack_thread_ts").eq("id", submission.id).maybeSingle();
    await slackPost(`⚠️ Couldn't create the Yapping scripts for *${submission.client_name}* automatically. Error: ${msg.slice(0, 300)}`, latest?.slack_thread_ts ?? null);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = String(body?.submission_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "submission_id required" }, { status: 400 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Claim the submission so it is processed exactly once.
  const { data: claimed, error } = await supabase
    .from("yapping_submissions")
    .update({ scripts_status: "generating" })
    .eq("id", id)
    .in("scripts_status", ["pending", "failed"])
    .select("id, client_id, client_name, answers")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!claimed) return Response.json({ error: "Not found or already processed" }, { status: 409 });

  const task = process(claimed, supabase);
  // @ts-ignore — EdgeRuntime is Supabase's Deno runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(task);
  return Response.json({ ok: true, status: "generating" }, { status: 202 });
});
