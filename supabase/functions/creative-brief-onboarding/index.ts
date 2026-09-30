// deno-lint-ignore-file no-explicit-any
/**
 * creative-brief-onboarding
 *
 * Replaces the n8n webhook at marketingverse.app.n8n.cloud/webhook/c134ad6f-…
 * Called from index.html (agency onboarding form) on final submission.
 *
 * Flow:
 *   1. Save raw brief to form_submissions (fast)
 *   2. Return 200 immediately
 *   3. Background (EdgeRuntime.waitUntil):
 *      a. Upsert client in Supabase clients table
 *      b. Create Slack channel client-{slug}
 *      c. Invite admins to channel
 *      d. Post welcome message
 *      e. Generate brand canvas with Claude (full Marketingverse methodology)
 *      f. Post brand canvas to Slack (split into chunks)
 *      g. Post Meta onboarding steps to channel
 *      h. Post summary to fulfillment + content channels
 *      i. Upsert GHL contact + add "creative brief done" tag
 *
 * Deploy with:
 *   supabase functions deploy creative-brief-onboarding --no-verify-jwt
 *
 * Required secrets (in addition to built-in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY):
 *   ANTHROPIC_API_KEY
 *   SLACK_BOT_TOKEN
 *   SLACK_ADMIN_USER_ID          (comma-separated Slack user IDs)
 *   SLACK_FULFILLMENT_CHANNEL_ID (internal team channel)
 *   SLACK_CONTENT_CHANNEL_ID     (e.g. #mr-al-content)
 *   GHL_API_KEY
 *   GHL_LOCATION_ID
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Constants ────────────────────────────────────────────────────────────────
const AGENCY_ID = "a20503b5-ea8a-4f8e-aa03-8e3030ab22bb";
const GHL_API_BASE = "https://services.leadconnectorhq.com";
const SLACK_API = "https://slack.com/api";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_MAX_TOKENS = 8192;
const SLACK_MAX_CHARS = 38000; // leave buffer under Slack's 40k limit

// ─── Marketingverse System Prompt ────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior brand strategist and content director for Marketingverse. You build brand systems for social media clients that are specific, opinionated, and actionable — never generic. You build every brand system using Marketingverse's proprietary storytelling methodology below.

RULES:
- If a field contains "test", placeholder text, or is clearly blank/vague, do NOT invent content. Instead mark that section with: ⚠️ *[Field] not provided — confirm with client before finalising.*
- Every insight must be grounded in the actual data provided. Specificity is the product.
- Be direct and confident. Cut filler, corporate speak, and hedging.
- Use only ## and ### headings — never #### or deeper.
- For the color palette, list each hex code on its own line with a descriptive name you assign it.
- Never suggest video, image, or design production directly — content concepts and copy only. Design happens in a separate step.
- Do not recommend more than 5 formats or use a different structure for every single post idea — the methodology below is built on repeating a small validated toolkit, not maximizing variety.

═══════════════════════════════════════
METHODOLOGY
═══════════════════════════════════════

CORE PHILOSOPHY: Predictability wins — both for the brain and the algorithm.
The goal is never one viral post, it's finding 1-3 formats/structures that fit
THIS client's authenticity and resources, then repeating them. Every piece of
content starts from a TEMA (an emotionally-relevant, universal hook) that
leads to a MORAL (the actual point — usually not interesting on its own).
Never lead with the informational point directly.

NARRATIVE STRUCTURES (assign one per content concept):
- I.H.C. (Identificación → Historia → Contenido): hook with something the
  audience already feels, tell a real story (conflicto → giro →
  consecuencia), land an insight or invisible CTA.
- Incorrecto → Giro → Correcto → Cambio: show the common mistake, why it
  fails, the discovery, the better way, the visible transformation.
- Él → Yo → Tú → Futuro: open with someone else's story, bring yourself in,
  bring the audience in with a bridge question, project forward.
- Análisis Estratégico (Conflicto → Resultados → 3 Motivos → Moraleja):
  open with a universal take on someone/something, show their results,
  break down 3 reasons (each mirroring a pillar of this client's approach),
  close with the moral.

PSYCHOLOGICAL PRINCIPLES (apply throughout):
- Relevancia Emocional: the hook must trigger real feeling in the first line.
- Lenguaje Familiar & Imagen Mental: everyday words the audience already
  uses, concrete enough to create a mental picture — never jargon.
- Contraste Emocional: intensity comes from the gap between two states
  placed side by side (before/after, wrong way/right way, negative→positive).
- Conflicto y Cambio: no conflict, no story — every conflict shown needs a
  visible change that follows it.
- Curiosidad & Efecto A-Há: open a loop early, close it by the end.
- Tema & Moral: the hook topic and the real lesson are usually different —
  find the emotionally-loaded entry point, use it as the vehicle.

FORMATS (recommend only what fits this client's resources/comfort level):
Pantalla Dividida (split screen: talking + illustrative images) · Pantalla
Verde (green screen, brisk pacing) · Conferencia Breve (slide/whiteboard
mini-lecture, builds authority) · Narrado (voiceover over B-roll, fast cuts) ·
Cine (letterboxed, music-driven, conversational) · Storytelling Visual (act
out what's said) · Experimento Social (street interviews, contrast between
answers) · Conflicto Situacional (staged dramatic cold open tied to the real
content) · Cajita de Preguntas (on-screen polarizing question) · Dinamismo
(fixed camera, creator moves constantly) · Comparación (split screen wrong
vs. right) · Diálogo (creator plays two characters) · Trivial (talk to
camera during a mundane task) · The Office (staged scene + confessional) ·
Lo-Fi (deliberately simple, close-friend tone) · Detrás de Cámaras (process
before result).

SEMILLAS PARA VENDER: audiences buy the LEADER, the MOVEMENT, and the
PRODUCT. Every content idea should plant a small seed toward one of these
three, never a hard pitch — Producto (proof it works, objection-breakers),
Líder (personal story, credibility, closeness), Movimiento (repeatable
language, beliefs the audience needs to hold), CTA Escondida (implied
availability without a direct pitch).

REAL ESTATE EMPATHY DEFAULTS (use as baseline unless the brief clearly
indicates a different industry — specialize using Specialty/Client
Focus/Market Tier/Top Objection below):
- BUYERS commonly fear: overpaying, a bad inspection surprise, losing a
  bidding war, distrust of agents rushing a close, financing overwhelm,
  picking the wrong neighborhood. They want: to stop renting, build equity,
  feel confident signing the biggest purchase of their life.
- SELLERS commonly fear: leaving money on the table, a bad inspection
  tanking the deal, agents pushing a quick sale over their interest. They
  want: certainty on timeline and price, to feel like they "won" the deal.
- INVESTORS commonly fear: a bad cash-flow calculation, bad market timing,
  "guru" advice. They want: a trustworthy local expert, passive income,
  long-term security.
- Common objections: "rates are too high," "I can do this myself online,"
  "it's not the right time," "agents don't work in my interest," "just
  looking, not ready."
- Common beliefs to work against: the market is unpredictable to outsiders,
  all agents say the same things, buying/selling is inherently adversarial.`;

const BRAND_CANVAS_INSTRUCTIONS = `Write a brand canvas in clean markdown with exactly these sections:

## 01 · Brand Overview
One sharp paragraph: who they are, what they stand for, and why it matters. No fluff.

## 02 · Target Audience & Empathy Profile
Primary and secondary audience with psychographic detail. Then, specialized from the real estate empathy defaults above using this client's specialty/focus/tier/objection: their top 3-4 fears, top 3-4 desires, and the beliefs standing in the way of buying.

## 03 · Tone of Voice
4–5 voice principles, each with a one-line description and a concrete example of what this sounds like in a caption.

## 04 · Content Pillars
4-6 CUSTOM pillars built from this specific client's differentiator, specialty, and audience — not a generic template. Each gets: pillar name, one-sentence purpose, and two example post angles.

## 05 · Brand Identity
Aesthetic direction and visual rules — what the feed should feel like, what to avoid.

## 06 · Color Palette
List every brand color provided. Format each as:
🟥 \`#HEXCODE\` — [Name you assign] — [when/how to use it]

Use the closest matching color emoji from this set:
⚫ for black/dark — ⚪ for white/light — 🟤 for brown/tan — 🔴 for red — 🟠 for orange — 🟡 for yellow — 🟢 for green — 🔵 for blue/navy — 🟣 for purple — 🩷 for pink — 🩶 for grey
If no colors were provided, flag it as missing.

## 07 · Platform Strategy
For each selected platform: content format priorities, posting cadence recommendation, and one tactic specific to that platform's algorithm.

## 08 · Dos & Don'ts
Two columns. Be specific — generic rules like "be authentic" are banned.

## 09 · Semillas Para Vender
3-4 seeds each for Producto, Líder, and Movimiento, plus 2-3 CTA Escondida lines — all specific to this client's actual differentiator, personal hook, and market area, not placeholders.

## 10 · Recommended Formats
Pick 3-5 formats from the methodology list that best fit this client's camera comfort level and available content resources. One line each on why it fits.

## 11 · Content Concepts

Five complete, ready-to-execute content pieces, each using a different structure+format combination from the methodology. For each:

**Concept [N] — [Title]**
- **Structure:** [which of the 4 narrative structures]
- **Format:** [which recommended format]
- **Pillar:** [which content pillar this supports]
- **Tema:** [the emotional hook/entry point]
- **Moral:** [the real point being taught]
- **Text overlay:** [exact text for the design, short and punchy]
- **Design direction:** [background, colors, mood, imagery style — enough for a designer to execute]
- **Caption:** [full caption copy, ready to post, in the client's content language]
- **CTA:** [exact call to action]`;

// ─── Utilities ────────────────────────────────────────────────────────────────
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 73);
}

function buildChannelName(fullName: string): string {
  const { firstName, lastName } = parseName(fullName);
  const cleanPart = (s: string) =>
    s.toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const first = cleanPart(firstName);
  const last = cleanPart(lastName.replace(/\s+/g, "-"));
  const slug = last ? `${first}_${last}` : first;
  return `client-${slug}`.substring(0, 80);
}

function parseName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return parts.length === 1
    ? { firstName: parts[0], lastName: "" }
    : { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function arr(v: any): string {
  return Array.isArray(v) ? v.join(", ") : (v || "Not specified");
}
function str(v: any): string {
  return v || "Not specified";
}

// ─── Build Claude user message from brief ─────────────────────────────────────
function buildBriefText(brief: any): string {
  return `**Industry:** ${str(brief.industry)}
**Website:** ${str(brief.website)}
**Instagram:** ${str(brief.handle)}
**Audience:** ${str(brief.targetAudience)}
**Tone:** ${arr(brief.toneOfVoice)}
**Language:** ${str(brief.contentLanguage)}
**Goals:** ${arr(brief.goals)}
**Platforms:** ${arr(brief.platforms)}
**Aesthetic:** ${str(brief.designAesthetic)}${brief.aestheticCustom ? " — " + brief.aestheticCustom : ""}
**Brand Colors:** ${arr(brief.colors)}
**Fonts:** ${arr(brief.fontStyle)}
**Promoting:** ${str(brief.promote)}
**Competitors/Inspo:** ${str(brief.competitors)}
**Dos & Don'ts:** ${str(brief.dosAndDonts)}
**Market area:** ${str(brief.market_area || brief.marketArea)}
**Specialty:** ${arr(brief.re_specialty || brief.reSpecialty)}
**Client focus:** ${arr(brief.client_focus || brief.clientFocus)}
**Market tier:** ${str(brief.market_tier || brief.marketTier)}
**Differentiator:** ${str(brief.differentiator)}
**Top objection heard:** ${str(brief.top_objection || brief.topObjection)}
**Camera comfort:** ${str(brief.camera_comfort || brief.cameraComfort)}
**Content resources:** ${arr(brief.content_resources || brief.contentResources)}
**Personal hook:** ${str(brief.personal_hook || brief.personalHook)}

---

${BRAND_CANVAS_INSTRUCTIONS}`;
}

// ─── Slack helpers ────────────────────────────────────────────────────────────
async function slackPost(
  channelId: string,
  text: string,
  token: string
): Promise<void> {
  const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
  });
  const data = await resp.json();
  if (!data.ok) {
    console.error(`[Slack] chat.postMessage error: ${data.error}`);
  }
}

async function slackPostChunked(
  channelId: string,
  content: string,
  token: string
): Promise<void> {
  if (content.length <= SLACK_MAX_CHARS) {
    await slackPost(channelId, content, token);
    return;
  }

  // Split at section boundaries (## headings) to keep chunks coherent
  const sections = content.split(/(?=\n## )/);
  let chunk = "";

  for (const section of sections) {
    if ((chunk + section).length > SLACK_MAX_CHARS) {
      if (chunk) await slackPost(channelId, chunk.trim(), token);
      chunk = section;
    } else {
      chunk += section;
    }
  }

  if (chunk.trim()) await slackPost(channelId, chunk.trim(), token);
}

async function ensureSlackChannel(
  channelName: string,
  token: string
): Promise<{ channelId: string; action: "created" | "found" }> {
  const createResp = await fetch(`${SLACK_API}/conversations.create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: channelName, is_private: true }),
  });
  const createData = await createResp.json();

  if (createData.ok) {
    return { channelId: createData.channel.id, action: "created" };
  }

  if (createData.error === "name_taken") {
    // Paginate to find the existing channel — include archived so a
    // previously-archived channel can be found and unarchived.
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        types: "private_channel",
        exclude_archived: "false",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);
      const listResp = await fetch(`${SLACK_API}/conversations.list?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listResp.json();
      if (!listData.ok) break;
      const found = listData.channels?.find((c: any) => c.name === channelName);
      if (found) {
        if (found.is_archived) {
          console.log(`[Slack] Channel "${channelName}" is archived — unarchiving...`);
          const unarchResp = await fetch(`${SLACK_API}/conversations.unarchive`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ channel: found.id }),
          });
          const unarchData = await unarchResp.json();
          if (!unarchData.ok && unarchData.error !== "not_archived") {
            console.warn(`[Slack] Unarchive warning: ${unarchData.error}`);
          }
        }
        // Join so we can invite others
        await fetch(`${SLACK_API}/conversations.join`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channel: found.id }),
        });
        return { channelId: found.id, action: "found" };
      }
      cursor = listData.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  throw new Error(`Slack create channel failed: ${createData.error}`);
}

async function inviteAdminsToChannel(channelId: string, token: string): Promise<void> {
  const adminEnv = Deno.env.get("SLACK_ADMIN_USER_ID") ?? "";
  const adminIds = adminEnv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!adminIds.length) return;

  const resp = await fetch(`${SLACK_API}/conversations.invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, users: adminIds.join(",") }),
  });
  const data = await resp.json();
  if (!data.ok && data.error !== "already_in_channel") {
    console.warn(`[Slack] invite warning: ${data.error}`);
  }
}

async function createSlackCanvas(
  channelId: string,
  clientName: string,
  brandCanvas: string,
  driveFolderUrl: string | null,
  token: string
): Promise<string | null> {
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const header = [
    `# 🎨 Brand Canvas — ${clientName}`,
    ``,
    `*Generated by Marketingverse AI · ${today}*${driveFolderUrl ? `\n📁 [Open in Google Drive](${driveFolderUrl})` : ""}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const resp = await fetch(`${SLACK_API}/conversations.canvases.create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel_id: channelId,
      document_content: {
        type: "markdown",
        markdown: header + brandCanvas,
      },
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    console.error(`[Slack] Canvas creation error: ${data.error}`, data);
    return null;
  }

  const canvasId = (data.canvas_id ?? data.canvas?.canvas_id) as string | undefined;
  console.log(`[Slack] Canvas created: ${canvasId}`);
  return canvasId ?? null;
}

// ─── Claude: generate brand canvas ────────────────────────────────────────────
async function generateBrandCanvas(brief: any): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the client brief:\n\n${buildBriefText(brief)}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API HTTP ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error("Claude returned empty response");
  return content;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function saveFormSubmission(brief: any, supabase: any): Promise<void> {
  const { error } = await supabase.from("form_submissions").insert({
    email: brief.clientEmail?.toLowerCase() || null,
    client_name: brief.clientName || null,
    raw_data: brief,
  });
  if (error) console.error("[Supabase] form_submissions insert error:", error);
}

async function upsertClient(
  brief: any,
  slackChannelId: string | null,
  supabase: any
): Promise<string | null> {
  const email = brief.clientEmail?.toLowerCase() || null;
  const phone = brief.clientPhone || brief.phone || null;
  if (!email && !phone) return null;

  const slug = slugify(brief.clientName || "");

  let existing: { id: string } | null = null;

  // Primary: look up by email
  if (email) {
    const { data } = await supabase
      .from("clients")
      .select("id")
      .eq("email", email)
      .eq("agency_id", AGENCY_ID)
      .maybeSingle();
    existing = data;
  }

  // Fallback: look up by phone if email didn't match
  if (!existing && phone) {
    try {
      const { data } = await supabase
        .from("clients")
        .select("id")
        .eq("phone", phone)
        .eq("agency_id", AGENCY_ID)
        .maybeSingle();
      if (data) existing = data;
    } catch {
      // phone column may not exist — safe to ignore
    }
  }

  const insertPayload: Record<string, unknown> = {
    name: brief.clientName,
    handle: slug,
    brand_name: brief.clientName,
    industry: brief.industry || null,
    website: brief.website || null,
    status: "active",
  };
  if (slackChannelId) insertPayload.slack_channel_id = slackChannelId;

  if (existing?.id) {
    // Don't update name — set at subscription time; brand_name and other fields come from form
    const updatePayload: Record<string, unknown> = {
      brand_name: brief.clientName,
      handle: slug,
      industry: brief.industry || null,
      website: brief.website || null,
      status: "active",
    };
    if (slackChannelId) updatePayload.slack_channel_id = slackChannelId;
    await supabase.from("clients").update(updatePayload).eq("id", existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabase
    .from("clients")
    .insert({ ...insertPayload, email, agency_id: AGENCY_ID })
    .select("id")
    .single();

  if (error) {
    console.error("[Supabase] client insert error:", error);
    return null;
  }
  return inserted.id;
}

// ─── GHL helpers ──────────────────────────────────────────────────────────────
async function ghlSearchContact(
  params: { email?: string; phone?: string; locationId: string },
  headers: Record<string, string>
): Promise<string | null> {
  // GHL v2 API uses `query` for text search — `email` as a direct param is rejected (422).
  for (const value of [params.email, params.phone]) {
    if (!value) continue;
    const resp = await fetch(
      `${GHL_API_BASE}/contacts/?` +
        new URLSearchParams({ locationId: params.locationId, query: value, limit: "1" }),
      { headers }
    );
    const data = await resp.json();
    const contacts: any[] = data.contacts ?? data.data?.contacts ?? [];
    if (contacts.length > 0) {
      console.log(`[GHL] Found existing contact: ${contacts[0].id}`);
      return contacts[0].id as string;
    }
  }
  return null;
}

async function syncGHLContact(brief: any): Promise<void> {
  const apiKey = Deno.env.get("GHL_API_KEY");
  const locationId = Deno.env.get("GHL_LOCATION_ID");
  if (!apiKey || !locationId) {
    console.warn("[GHL] GHL_API_KEY or GHL_LOCATION_ID not set — skipping");
    return;
  }

  const email = brief.clientEmail?.toLowerCase();
  const phone = brief.clientPhone || brief.phone || undefined;
  if (!email && !phone) return;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };

  const { firstName, lastName } = parseName(brief.clientName || "");
  const tags = ["mverse - client", "creative brief done"];

  const contactId = await ghlSearchContact({ email, phone, locationId }, headers);

  if (contactId) {
    // Update name/details then add tags non-destructively
    await fetch(`${GHL_API_BASE}/contacts/${contactId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ firstName, lastName, ...(email ? { email } : {}), ...(phone ? { phone } : {}) }),
    });
    await fetch(`${GHL_API_BASE}/contacts/${contactId}/tags`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tags }),
    });
    console.log(`[GHL] Updated existing contact ${contactId}`);
    return;
  }

  const createResp = await fetch(`${GHL_API_BASE}/contacts/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      locationId,
      email,
      ...(phone ? { phone } : {}),
      firstName,
      lastName,
      tags,
      source: "Creative Brief Form",
    }),
  });
  const createData = await createResp.json();
  const newId = createData.contact?.id ?? createData.id;
  console.log(`[GHL] Created contact ${newId}`);
}

// ─── Canva helpers ────────────────────────────────────────────────────────────
async function getCanvaAccessToken(): Promise<string | null> {
  const clientId = Deno.env.get("CANVA_CLIENT_ID");
  const clientSecret = Deno.env.get("CANVA_CLIENT_SECRET");
  const refreshToken = Deno.env.get("CANVA_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn("[Canva] CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, or CANVA_REFRESH_TOKEN not set — skipping");
    return null;
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await resp.json();
  if (!data.access_token) {
    console.error("[Canva] Token exchange failed:", JSON.stringify(data));
    return null;
  }
  return data.access_token as string;
}

async function createCanvaDesign(clientName: string): Promise<string | null> {
  const token = await getCanvaAccessToken();
  if (!token) return null;

  const resp = await fetch("https://api.canva.com/rest/v1/designs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      design_type: { type: "custom", width: 1080, height: 1350 },
      title: `Mverse - ${clientName}`,
    }),
  });

  const data = await resp.json();
  const editUrl = data.design?.urls?.edit_url ?? null;
  if (!editUrl) {
    console.error("[Canva] Failed to get edit URL:", JSON.stringify(data));
    return null;
  }
  console.log(`[Canva] Design created: ${editUrl}`);
  return editUrl;
}

// ─── Google Drive helpers ─────────────────────────────────────────────────────
async function saveDriveFile(
  name: string,
  content: string,
  mimeType: "application/vnd.google-apps.document",
  folderId: string,
  token: string
): Promise<string> {
  const boundary = "mv_multipart_boundary";
  const metadata = JSON.stringify({ name, mimeType, parents: [folderId] });
  const multipartBody = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");

  const resp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );
  const data = await resp.json();
  if (!data.id) throw new Error(`Drive file upload failed for "${name}": ${JSON.stringify(data)}`);
  return data.id as string;
}

async function getGoogleAccessToken(): Promise<string> {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");

  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);

  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const header = b64url({ alg: "RS256", typ: "JWT" });
  const claim = b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });

  const signingInput = `${header}.${claim}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----\n?/, "")
    .replace(/\n?-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");

  const keyBuffer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = `${signingInput}.${sig}`;

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token as string;
}

async function createDriveFolder(name: string, parentId: string, token: string): Promise<string> {
  const resp = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const data = await resp.json();
  if (!data.id) throw new Error(`Drive folder creation failed: ${JSON.stringify(data)}`);
  return data.id as string;
}

async function saveBrandCanvasToDrive(
  clientName: string,
  brandCanvas: string,
  brief: any
): Promise<{ folderUrl: string } | null> {
  const clientsFolderId = Deno.env.get("GOOGLE_DRIVE_CLIENTS_FOLDER_ID");
  if (!clientsFolderId) {
    console.warn("[Drive] GOOGLE_DRIVE_CLIENTS_FOLDER_ID not set — skipping");
    return null;
  }

  const token = await getGoogleAccessToken();
  const folderId = await createDriveFolder(clientName, clientsFolderId, token);
  console.log(`[Drive] Created folder "${clientName}" → ${folderId}`);

  // 1. Brand Canvas — AI-generated brand strategy
  await saveDriveFile(`Brand Canvas — ${clientName}`, brandCanvas, "application/vnd.google-apps.document", folderId, token);

  // 2. Brief — raw form submission as markdown
  const briefContent = [
    `# Brief — ${clientName}`,
    "",
    `**Client name:** ${brief.clientName || "—"}`,
    `**Email:** ${brief.clientEmail || "—"}`,
    `**Phone:** ${brief.clientPhone || brief.phone || "—"}`,
    `**Website:** ${brief.website || "—"}`,
    `**Instagram handle:** ${brief.handle || "—"}`,
    `**Industry:** ${brief.industry || "—"}`,
    `**Target audience:** ${brief.targetAudience || "—"}`,
    `**Tone of voice:** ${arr(brief.toneOfVoice)}`,
    `**Content language:** ${brief.contentLanguage || "—"}`,
    `**Goals:** ${arr(brief.goals)}`,
    `**Platforms:** ${arr(brief.platforms)}`,
    `**Design aesthetic:** ${brief.designAesthetic || "—"}${brief.aestheticCustom ? " — " + brief.aestheticCustom : ""}`,
    `**Brand colors:** ${arr(brief.colors)}`,
    `**Fonts:** ${arr(brief.fontStyle)}`,
    `**Promoting:** ${brief.promote || "—"}`,
    `**Competitors / inspo:** ${brief.competitors || "—"}`,
    `**Dos & Don'ts:** ${brief.dosAndDonts || "—"}`,
    `**Market area:** ${brief.market_area || brief.marketArea || "—"}`,
    `**Specialty:** ${arr(brief.re_specialty || brief.reSpecialty)}`,
    `**Client focus:** ${arr(brief.client_focus || brief.clientFocus)}`,
    `**Market tier:** ${brief.market_tier || brief.marketTier || "—"}`,
    `**Differentiator:** ${brief.differentiator || "—"}`,
    `**Top objection:** ${brief.top_objection || brief.topObjection || "—"}`,
    `**Camera comfort:** ${brief.camera_comfort || brief.cameraComfort || "—"}`,
    `**Content resources:** ${arr(brief.content_resources || brief.contentResources)}`,
    `**Personal hook:** ${brief.personal_hook || brief.personalHook || "—"}`,
  ].join("\n");
  await saveDriveFile(`Brief — ${clientName}`, briefContent, "application/vnd.google-apps.document", folderId, token);

  // 3. Metrics — KPI tracking placeholder
  const metricsContent = [
    `# Metrics — ${clientName}`,
    "",
    "| Month | Followers | Reach | Impressions | Engagement Rate | Link Clicks | Leads |",
    "|-------|-----------|-------|-------------|-----------------|-------------|-------|",
    "| | | | | | | |",
    "",
    "## Notes",
    "",
    "_Add monthly performance notes here._",
  ].join("\n");
  await saveDriveFile(`Metrics — ${clientName}`, metricsContent, "application/vnd.google-apps.document", folderId, token);

  // 4. Content Log — empty content tracking table
  const contentLogContent = [
    `# Content Log — ${clientName}`,
    "",
    "| Date | Platform | Format | Pillar | Caption (excerpt) | Status | Link | Notes |",
    "|------|----------|--------|--------|-------------------|--------|------|-------|",
    "| | | | | | | | |",
  ].join("\n");
  await saveDriveFile(`Content Log — ${clientName}`, contentLogContent, "application/vnd.google-apps.document", folderId, token);

  const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
  console.log(`[Drive] 4 files saved → folder: ${folderUrl}`);
  return { folderUrl };
}

// ─── Meta onboarding steps message ────────────────────────────────────────────
function buildMetaOnboardingMessage(clientName: string): string {
  return `*📣 Meta Business Suite — Onboarding Checklist for ${clientName}*

Complete these steps to connect your social accounts to our system:

*1. Meta Business Suite*
→ Go to business.facebook.com → Create or claim your Business account
→ Add your Facebook Page and Instagram account under Assets

*2. Add Marketingverse as a Partner*
→ Business Settings → Partners → Add Partner
→ Partner ID: *(your team will send this separately)*
→ Grant access to: Pages, Instagram accounts, Ad accounts

*3. Facebook Page Access*
→ Business Settings → Accounts → Pages → Add → Claim existing Page
→ Set Marketingverse role: Content Creator or Admin

*4. Instagram Professional Account*
→ Confirm Instagram is converted to a Professional (Business or Creator) account
→ Connect to your Facebook Page (required for scheduling)

*5. Confirm access is live*
→ Reply here once steps 1-4 are done — your team will verify and activate your content calendar`;
}

// ─── Main background processor ────────────────────────────────────────────────
async function processOnboarding(brief: any, supabase: any): Promise<void> {
  const clientName = brief.clientName || "New Client";
  const channelName = buildChannelName(clientName);
  const token = Deno.env.get("SLACK_BOT_TOKEN") || "";
  const fulfillmentChannelId = Deno.env.get("SLACK_FULFILLMENT_CHANNEL_ID") || "";
  const contentChannelId = Deno.env.get("SLACK_CONTENT_CHANNEL_ID") || "";

  let slackChannelId: string | null = null;

  // 1. Check if client already has a Slack channel (created by subscription step)
  const clientEmail = brief.clientEmail?.toLowerCase() || null;
  if (clientEmail) {
    try {
      const { data: existingClient } = await supabase
        .from("clients")
        .select("slack_channel_id")
        .eq("email", clientEmail)
        .eq("agency_id", AGENCY_ID)
        .maybeSingle();
      if (existingClient?.slack_channel_id) {
        slackChannelId = existingClient.slack_channel_id;
        console.log(`[Slack] Reusing existing channel: ${slackChannelId}`);
      }
    } catch (err) {
      console.error("[Slack] Existing channel lookup error:", err);
    }
  }

  // 2. Create channel + invite admins only if no existing channel
  if (!slackChannelId) {
    try {
      const { channelId, action } = await ensureSlackChannel(channelName, token);
      slackChannelId = channelId;
      console.log(`[Slack] Channel ${action}: ${channelId}`);
    } catch (err) {
      console.error("[Slack] Channel error:", err);
    }

    if (slackChannelId) {
      try {
        await inviteAdminsToChannel(slackChannelId, token);
      } catch (err) {
        console.error("[Slack] Invite error:", err);
      }
    }
  }

  // 3. Post welcome message to channel
  if (slackChannelId) {
    await slackPost(
      slackChannelId,
      `👋 Welcome to your Marketingverse workspace, *${clientName}*!\n\nYour brand canvas and content strategy are being generated now. This usually takes about 60 seconds — we'll post everything here as it's ready.`,
      token
    );
  }

  // 4. Upsert client in Supabase
  let clientId: string | null = null;
  try {
    clientId = await upsertClient(brief, slackChannelId, supabase);
  } catch (err) {
    console.error("[Supabase] Client upsert error:", err);
  }

  // 4.5. Create Canva design + save edit URL to client record
  let canvaEditUrl: string | null = null;
  try {
    canvaEditUrl = await createCanvaDesign(clientName);
    if (canvaEditUrl && clientId) {
      await supabase
        .from("clients")
        .update({ canva_design_url: canvaEditUrl })
        .eq("id", clientId);
      console.log(`[Canva] Saved edit URL to client ${clientId}`);
    }
  } catch (err) {
    console.error("[Canva] Error:", err);
  }

  // 5. Generate brand canvas with Claude
  let brandCanvas = "";
  try {
    console.log("[Claude] Generating brand canvas...");
    brandCanvas = await generateBrandCanvas(brief);
    console.log(`[Claude] Generated ${brandCanvas.length} chars`);
  } catch (err) {
    console.error("[Claude] Generation error:", err);
    brandCanvas = `⚠️ Brand canvas generation failed. Please regenerate manually.\n\nError: ${err}`;
  }

  // 5.5. Save brand canvas to Google Drive
  let driveFolderUrl: string | null = null;
  if (brandCanvas) {
    try {
      const driveResult = await saveBrandCanvasToDrive(clientName, brandCanvas, brief);
      driveFolderUrl = driveResult?.folderUrl ?? null;
    } catch (err) {
      console.error("[Drive] Error:", err);
    }
  }

  // 6. Create Slack canvas with brand strategy (fallback to chunked messages)
  let canvasId: string | null = null;
  if (slackChannelId && brandCanvas) {
    try {
      canvasId = await createSlackCanvas(slackChannelId, clientName, brandCanvas, driveFolderUrl, token);
      if (canvasId && clientId) {
        await supabase.from("clients").update({ slack_canvas_id: canvasId }).eq("id", clientId);
        console.log(`[Slack] Canvas ID saved to client ${clientId}`);
      }
    } catch (err) {
      console.error("[Slack] Canvas error:", err);
    }
    if (!canvasId) {
      const header = `*📋 Brand Canvas — ${clientName}*\n_Generated by Marketingverse AI_${driveFolderUrl ? `\n📁 <${driveFolderUrl}|Open in Google Drive>` : ""}\n\n`;
      await slackPostChunked(slackChannelId, header + brandCanvas, token);
    }
  }

  // 7. Post Meta onboarding steps to client channel
  if (slackChannelId) {
    await slackPost(slackChannelId, buildMetaOnboardingMessage(clientName), token);
  }

  // 8. Post summary to fulfillment + content channels
  const summaryText = [
    `*🆕 New client onboarded: ${clientName}*`,
    `• Email: ${brief.clientEmail || "—"}`,
    `• Industry: ${brief.industry || "—"}`,
    `• Handle: ${brief.handle || "—"}`,
    `• Platforms: ${arr(brief.platforms)}`,
    `• Aesthetic: ${str(brief.designAesthetic)}`,
    `• Slack: ${slackChannelId ? `<#${slackChannelId}>` : channelName}`,
    driveFolderUrl ? `• Drive: <${driveFolderUrl}|Open Drive folder>` : null,
    canvaEditUrl ? `• Canva: <${canvaEditUrl}|Open Canva design>` : null,
    ``,
    `Brand canvas ${canvasId ? "created as channel canvas ✅" : "posted in channel ↑"}`,
  ].filter(Boolean).join("\n");

  if (fulfillmentChannelId) {
    await slackPost(fulfillmentChannelId, summaryText, token);
  }
  if (contentChannelId && contentChannelId !== fulfillmentChannelId) {
    await slackPost(contentChannelId, summaryText, token);
  }

  // 9. GHL contact sync
  try {
    await syncGHLContact(brief);
  } catch (err) {
    console.error("[GHL] Error:", err);
  }

  console.log(`[creative-brief-onboarding] Completed for ${clientName}`);
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // The form sends { prompt, brief } — extract brief
  const brief = body.brief || body;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Save form submission immediately (fast path)
  await saveFormSubmission(brief, supabase);

  // Start background processing — respond 200 right away
  // @ts-ignore — EdgeRuntime is Supabase's Deno runtime global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(processOnboarding(brief, supabase));
  } else {
    // Fallback for local dev — process synchronously
    processOnboarding(brief, supabase).catch(console.error);
  }

  return new Response(JSON.stringify({ ok: true, message: "Onboarding started" }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
});
