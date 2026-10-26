// deno-lint-ignore-file no-explicit-any
/**
 * yapping-scripts
 *
 * Turns a Yapping questionnaire submission into talking-to-camera scripts and shares them as a
 * Slack canvas "<Client Name> - Yapping Scripts" in the client's Slack channel (the client sees
 * it), with a message in that channel and the link in the team's fulfillment thread. If the
 * client has no Slack channel on file, the canvas goes to the fulfillment channel instead.
 *
 * Called by yapping-questionnaire with { submission_id }. Responds 202 immediately and does
 * the work in the background. Only submissions whose scripts_status is 'pending' or 'failed'
 * are processed, so a repeat call can't regenerate (or bill) twice; set the status back to
 * 'failed' to retry one.
 *
 * Deploy with:
 *   supabase functions deploy yapping-scripts --no-verify-jwt
 *
 * Secrets: ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_FULFILLMENT_CHANNEL_ID
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
The client reads this document, so write it to them in plain language. Do not use internal terms like "lens", "Tema", "Moral", "Semilla" or "seed", and do not use tables.

# {Client name} - Yapping Scripts
One short paragraph to the client: what these videos are about and the angle that runs through them.

## Your videos at a glance
A numbered list: concept title, then the topic it belongs to.

## Scripts
Write 8 scripts with a mix of hot takes, personal stories and "what your client is thinking" videos. For each:
### {n}. {Concept title}
**Topic:** ...
**Hook options:**
- A) ...
- B) ...
- C) ...
**Script (word for word):**
(the spoken script, in short paragraphs)
**On-screen text:** 3-8 words
**How to film it:** energy, where to pause, setting
**Caption:** 2-4 lines ending with a question that invites comments
**What we need from you:** placeholders to fill, or "Nothing, ready to film"

## More hooks to film
10 extra one-line hooks drawn from their answers.

## A few questions for you
The few follow-up questions that would make the next scripts even better (only if their answers left real gaps).`;

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

// ─── Slack ─────────────────────────────────────────────────────────────────────
async function slack(method: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("SLACK_BOT_TOKEN") ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function slackPost(channel: string, text: string, threadTs: string | null = null): Promise<void> {
  const data = await slack("chat.postMessage", { channel, text, mrkdwn: true, ...(threadTs ? { thread_ts: threadTs } : {}) });
  if (!data.ok) console.error(`[Slack] chat.postMessage error: ${data.error}`);
}

// A channel's built-in canvas already holds the brand canvas, so the scripts get their own
// canvas created in (or shared to) the channel.
async function createChannelCanvas(channelId: string, title: string, markdown: string): Promise<string> {
  const document_content = { type: "markdown", markdown };
  let data = await slack("canvases.create", { title, document_content, channel_id: channelId });
  if (!data.ok) {
    console.warn(`[Slack] canvases.create with channel_id failed (${data.error}); creating standalone and sharing`);
    data = await slack("canvases.create", { title, document_content });
    if (!data.ok) throw new Error(`canvases.create failed: ${data.error}`);
    const shared = await slack("canvases.access.set", { canvas_id: data.canvas_id, access_level: "write", channel_ids: [channelId] });
    if (!shared.ok) throw new Error(`canvases.access.set failed: ${shared.error}`);
  }
  return data.canvas_id as string;
}

async function canvasUrl(canvasId: string): Promise<string> {
  const info = await slack("files.info", { file: canvasId });
  if (info.ok && info.file?.permalink) return info.file.permalink as string;
  const auth = await slack("auth.test", {});
  return `${auth.url}docs/${auth.team_id}/${canvasId}`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function process(submission: any, supabase: any): Promise<void> {
  const teamChannel = Deno.env.get("SLACK_FULFILLMENT_CHANNEL_ID") ?? "";
  const threadTs = async () =>
    (await supabase.from("yapping_submissions").select("slack_thread_ts").eq("id", submission.id).maybeSingle()).data?.slack_thread_ts ?? null;
  try {
    let client: any = null;
    if (submission.client_id) {
      const { data } = await supabase
        .from("clients")
        .select("name, brand_name, industry, handle, bio, content_guidelines, slack_channel_id")
        .eq("id", submission.client_id)
        .maybeSingle();
      client = data;
    }
    const clientName = client?.name || submission.client_name;
    const title = `${clientName} - Yapping Scripts`;
    const markdown = await generateScripts(clientName, client, submission.answers ?? []);

    const clientChannel: string | null = client?.slack_channel_id ?? null;
    const canvasId = await createChannelCanvas(clientChannel ?? teamChannel, title, markdown);
    const url = await canvasUrl(canvasId);

    if (clientChannel) {
      await slackPost(
        clientChannel,
        `📝 *Your Yapping scripts are ready!*\nWe turned your questionnaire answers into your first talking-to-camera videos. Open <${url}|${title}> to read them, and reply here with anything you'd like to change.`,
      );
    }
    await supabase.from("yapping_submissions")
      .update({ scripts_status: "done", scripts_doc_url: url, scripts_error: null })
      .eq("id", submission.id);
    await slackPost(
      teamChannel,
      clientChannel
        ? `📝 Yapping scripts shared in <#${clientChannel}>: <${url}|${title}>`
        : `📝 Yapping scripts ready: <${url}|${title}> (no client Slack channel on file, so they're here)`,
      await threadTs(),
    );
    console.log(`[yapping-scripts] Done for ${clientName}: ${url}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[yapping-scripts] Failed:", msg);
    await supabase.from("yapping_submissions").update({ scripts_status: "failed", scripts_error: msg.slice(0, 1000) }).eq("id", submission.id);
    await slackPost(teamChannel, `⚠️ Couldn't create the Yapping scripts for *${submission.client_name}* automatically. Error: ${msg.slice(0, 300)}`, await threadTs());
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
