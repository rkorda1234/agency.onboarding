// deno-lint-ignore-file no-explicit-any
/**
 * zoho-subscription-onboarding
 *
 * Triggered by a Zoho Billing webhook (new/updated subscription).
 * Orchestrates:
 *   1. Extract client data from the Zoho payload (handles multiple shapes)
 *   2. Create (or find) a Slack channel named `client-{slug}`
 *   3. Join the channel (bot) and invite all SLACK_ADMIN_USER_ID users
 *   4. Upsert the client row in Supabase `clients` table
 *   5. Sync the contact in GHL (search → add tag, or create)
 *
 * Deploy with:
 *   supabase functions deploy zoho-subscription-onboarding --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Constants ────────────────────────────────────────────────────────────────
const AGENCY_ID = "a20503b5-ea8a-4f8e-aa03-8e3030ab22bb";
const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_CLIENT_TAG = "mverse - client";
const SLACK_API = "https://slack.com/api";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ExtractedClient {
  clientName: string | null;
  clientEmail: string | null;
  plan: string | null;
}

interface SlackChannelResult {
  channelId: string;
  action: "created" | "found";
}

interface GHLResult {
  action: "created" | "tags_added";
  contactId: string;
}

interface SupabaseUpsertResult {
  id: string;
  action: "inserted" | "updated";
}

// ─── Utility: slugify (for DB handle) ────────────────────────────────────────
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

// ─── Utility: build Slack channel name ───────────────────────────────────────
/**
 * Produces `client-firstName_lastName` matching n8n convention.
 * Each name part is lowercased, diacritics stripped, non-alphanumeric chars
 * removed (spaces in multi-word last names become hyphens).
 * Total length capped at 80 chars (Slack limit).
 */
function buildChannelName(fullName: string): string {
  const { firstName, lastName } = parseName(fullName);
  const cleanPart = (s: string) =>
    s.toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")   // strip diacritics
      .replace(/[^a-z0-9-]/g, "")        // keep only a-z, 0-9, hyphens
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const first = cleanPart(firstName);
  const last = cleanPart(lastName.replace(/\s+/g, "-")); // multi-word → hyphens
  const slug = last ? `${first}_${last}` : first;
  return `client-${slug}`.substring(0, 80);
}

// ─── Utility: parse first / last name ─────────────────────────────────────────
function parseName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// ─── Utility: require env var ─────────────────────────────────────────────────
function requireEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Environment variable "${key}" is not set`);
  return val;
}

// ─── Step 0: Extract client data from Zoho payload ────────────────────────────
/**
 * Zoho Billing webhooks do not have a fixed payload shape across event types.
 * This function probes all known paths and returns the first non-null values.
 *
 * Handled shapes:
 *   body.subscription.customer.display_name / .email
 *   body.subscription.customer_name / .customer_email
 *   body.data.subscription.customer.display_name / .email
 *   body.data.subscription.customer_name / .customer_email
 *   body.customer_name / .customer_email (flat)
 */
function extractClientData(body: Record<string, any>): ExtractedClient {
  // Normalise: body.subscription OR body.data.subscription
  const sub: Record<string, any> | undefined =
    body.subscription ??
    (body.data as Record<string, any> | undefined)?.subscription ??
    undefined;

  const customer: Record<string, any> | undefined =
    (sub?.customer as Record<string, any> | undefined) ?? undefined;

  const planObj: Record<string, any> | undefined =
    (sub?.plan as Record<string, any> | undefined) ?? undefined;

  const clientName: string | null =
    customer?.display_name?.trim() ||
    sub?.customer_name?.trim() ||
    body.customer_name?.trim() ||
    null;

  const clientEmail: string | null =
    (customer?.email as string | undefined)?.trim().toLowerCase() ||
    (sub?.customer_email as string | undefined)?.trim().toLowerCase() ||
    (body.customer_email as string | undefined)?.trim().toLowerCase() ||
    null;

  const plan: string | null =
    planObj?.name?.trim() ||
    planObj?.plan_code?.trim() ||
    sub?.plan_name?.trim() ||
    sub?.plan_code?.trim() ||
    body.plan_name?.trim() ||
    body.plan_code?.trim() ||
    null;

  return { clientName, clientEmail, plan };
}

// ─── Step 1 + 2: Slack — ensure channel + join ────────────────────────────────
async function ensureSlackChannel(
  channelName: string
): Promise<SlackChannelResult> {
  const token = requireEnv("SLACK_BOT_TOKEN");

  // Attempt to create the channel
  const createResp = await fetch(`${SLACK_API}/conversations.create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: channelName, is_private: true }),
  });

  if (!createResp.ok) {
    throw new Error(
      `Slack conversations.create HTTP ${createResp.status}: ${await createResp.text()}`
    );
  }

  const createData = await createResp.json();

  if (createData.ok) {
    console.log(
      `[Slack] Created channel "${channelName}" → ${createData.channel.id}`
    );
    return { channelId: createData.channel.id, action: "created" };
  }

  if (createData.error === "name_taken") {
    console.log(
      `[Slack] Channel "${channelName}" already exists, searching for it...`
    );
    const channelId = await findSlackChannelByName(channelName, token);
    if (!channelId) {
      throw new Error(
        `Slack channel "${channelName}" is name_taken but was not found in channel list`
      );
    }
    // Bot may not be a member of a pre-existing channel — join it so we can invite
    await joinSlackChannel(channelId, token);
    console.log(`[Slack] Found existing channel "${channelName}" → ${channelId}`);
    return { channelId, action: "found" };
  }

  throw new Error(`Slack conversations.create failed: ${createData.error}`);
}

// Paginate conversations.list to find a channel by exact name.
// Includes archived channels so a previously-archived test channel
// can be found and unarchived rather than failing with name_taken.
async function findSlackChannelByName(
  name: string,
  token: string
): Promise<string | null> {
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      types: "private_channel",
      exclude_archived: "false",
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const resp = await fetch(
      `${SLACK_API}/conversations.list?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      throw new Error(
        `Slack conversations.list HTTP ${resp.status}: ${await resp.text()}`
      );
    }

    const data = await resp.json();
    if (!data.ok) {
      throw new Error(`Slack conversations.list failed: ${data.error}`);
    }

    for (const channel of data.channels ?? []) {
      if (channel.name === name) {
        if (channel.is_archived) {
          console.log(`[Slack] Channel "${name}" is archived — unarchiving...`);
          const unarchResp = await fetch(`${SLACK_API}/conversations.unarchive`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ channel: channel.id }),
          });
          const unarchData = await unarchResp.json();
          if (!unarchData.ok && unarchData.error !== "not_archived") {
            console.warn(`[Slack] Unarchive warning: ${unarchData.error}`);
          }
        }
        return channel.id as string;
      }
    }

    cursor = (data.response_metadata?.next_cursor as string | undefined) || undefined;
  } while (cursor);

  return null;
}

// Join a channel with the bot token (needed to invite others into pre-existing channels)
async function joinSlackChannel(channelId: string, token: string): Promise<void> {
  const resp = await fetch(`${SLACK_API}/conversations.join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.warn(
      `[Slack] conversations.join HTTP ${resp.status}: ${text} — continuing`
    );
    return;
  }

  const data = await resp.json();
  if (!data.ok && data.error !== "already_in_channel") {
    console.warn(
      `[Slack] conversations.join non-fatal error: ${data.error} — continuing`
    );
  }
}

// ─── Step 3: Slack — invite admins ────────────────────────────────────────────
async function inviteAdminsToChannel(channelId: string): Promise<void> {
  const token = requireEnv("SLACK_BOT_TOKEN");

  const adminEnv = Deno.env.get("SLACK_ADMIN_USER_ID") ?? "";
  const adminIds = adminEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (adminIds.length === 0) {
    console.warn(
      "[Slack] SLACK_ADMIN_USER_ID is empty — skipping admin invite"
    );
    return;
  }

  // Invite all admins in a single call; Slack accepts comma-separated user IDs
  const resp = await fetch(`${SLACK_API}/conversations.invite`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, users: adminIds.join(",") }),
  });

  if (!resp.ok) {
    throw new Error(
      `Slack conversations.invite HTTP ${resp.status}: ${await resp.text()}`
    );
  }

  const data = await resp.json();

  if (data.ok) {
    console.log(
      `[Slack] Invited ${adminIds.length} admin(s) to channel ${channelId}`
    );
    return;
  }

  // already_in_channel is fine — the admin is already there
  if (data.error === "already_in_channel") {
    console.log(
      `[Slack] Admin(s) already in channel ${channelId} — no action needed`
    );
    return;
  }

  // For bulk invites Slack may return errors[] alongside a partial success.
  // Log the errors but do not throw — the channel was still created.
  if (data.errors && Array.isArray(data.errors)) {
    const nonFatal = data.errors.every(
      (e: any) => e.error === "already_in_channel"
    );
    if (nonFatal) {
      console.log(`[Slack] All admins already in channel ${channelId}`);
      return;
    }
  }

  // Unexpected error
  console.error(
    `[Slack] conversations.invite unexpected error: ${data.error}`,
    data.errors
  );
  throw new Error(`Slack conversations.invite failed: ${data.error}`);
}

// ─── Step 4: Supabase — upsert client ─────────────────────────────────────────
async function upsertClient(params: {
  clientName: string;
  clientEmail: string;
  handle: string;
  slackChannelId: string | null;
  plan: string | null;
}): Promise<SupabaseUpsertResult> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Determine whether the client already exists (by email + agency)
  const { data: existing, error: selectError } = await supabase
    .from("clients")
    .select("id")
    .eq("email", params.clientEmail)
    .eq("agency_id", AGENCY_ID)
    .maybeSingle();

  if (selectError) {
    throw new Error(
      `Supabase select error: ${selectError.message} (${selectError.code})`
    );
  }

  const isExisting = !!existing?.id;

  if (isExisting) {
    // Update existing row
    const updatePayload: Record<string, unknown> = {
      name: params.clientName,
      handle: params.handle,
      brand_name: params.clientName,
      status: "active",
    };

    // Only update slack_channel_id if we have a value (don't overwrite with null)
    if (params.slackChannelId) {
      updatePayload.slack_channel_id = params.slackChannelId;
    }

    const { data: updated, error: updateError } = await supabase
      .from("clients")
      .update(updatePayload)
      .eq("id", existing.id)
      .select("id")
      .single();

    if (updateError) {
      throw new Error(
        `Supabase update error: ${updateError.message} (${updateError.code})`
      );
    }

    console.log(`[Supabase] Updated client id=${updated.id}`);
    return { id: updated.id, action: "updated" };
  }

  // Insert new row
  const insertPayload: Record<string, unknown> = {
    agency_id: AGENCY_ID,
    name: params.clientName,
    email: params.clientEmail,
    handle: params.handle,
    brand_name: params.clientName,
    status: "active",
  };

  if (params.slackChannelId) {
    insertPayload.slack_channel_id = params.slackChannelId;
  }

  // industry is left null — no mapping from subscription payload
  // id is left out — relies on DB default (uuid_generate_v4 or gen_random_uuid)

  const { data: inserted, error: insertError } = await supabase
    .from("clients")
    .insert(insertPayload)
    .select("id")
    .single();

  if (insertError) {
    throw new Error(
      `Supabase insert error: ${insertError.message} (${insertError.code})`
    );
  }

  console.log(`[Supabase] Inserted new client id=${inserted.id}`);
  return { id: inserted.id, action: "inserted" };
}

// ─── Step 5: GHL — sync contact ───────────────────────────────────────────────
async function syncGHLContact(params: {
  clientName: string;
  clientEmail: string;
  plan: string | null;
  opportunityValue: string | null;
}): Promise<GHLResult> {
  const apiKey = requireEnv("GHL_API_KEY");
  const locationId = requireEnv("GHL_LOCATION_ID");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };

  // Build tags: always "mverse - client" + plan name if available
  const tags = [GHL_CLIENT_TAG];
  if (params.plan) tags.push(params.plan);

  // Build custom fields
  const customFields = params.opportunityValue
    ? [{ key: "opportunity_value", field_value: params.opportunityValue }]
    : [];

  // ── Search for existing contact by email, fallback to phone ──
  // GHL v2 API uses `query` for text search — `email` as a direct param is rejected (422).
  let contactId: string | null = null;
  for (const value of [params.clientEmail, (params as any).clientPhone as string | undefined]) {
    if (!value) continue;
    const searchUrl =
      `${GHL_API_BASE}/contacts/?` +
      new URLSearchParams({ locationId, query: value, limit: "1" }).toString();
    const searchResp = await fetch(searchUrl, { headers });
    if (!searchResp.ok) {
      throw new Error(`GHL contact search HTTP ${searchResp.status}: ${await searchResp.text()}`);
    }
    const searchData = await searchResp.json();
    const contacts: any[] = searchData.contacts ?? searchData.data?.contacts ?? [];
    if (contacts.length > 0) {
      contactId = contacts[0].id as string;
      console.log(`[GHL] Found existing contact: ${contactId}`);
      break;
    }
  }

  if (contactId) {
    console.log(`[GHL] Updating contact ${contactId} — tags + custom fields...`);

    // Add tags non-destructively
    await fetch(`${GHL_API_BASE}/contacts/${contactId}/tags`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tags }),
    });

    // Update name + custom fields via PUT
    const { firstName, lastName } = parseName(params.clientName);
    const updateBody: Record<string, unknown> = { firstName, lastName };
    if (customFields.length > 0) updateBody.customFields = customFields;
    await fetch(`${GHL_API_BASE}/contacts/${contactId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(updateBody),
    });

    console.log(`[GHL] Updated contact ${contactId} — tags: ${tags.join(", ")}`);
    return { action: "tags_added", contactId };
  }

  // ── Create new contact ──
  const { firstName, lastName } = parseName(params.clientName);

  const createBody: Record<string, unknown> = {
    locationId,
    email: params.clientEmail,
    firstName,
    lastName,
    tags,
    source: "Zoho Billing",
  };
  if (customFields.length > 0) createBody.customFields = customFields;

  const createResp = await fetch(`${GHL_API_BASE}/contacts/`, {
    method: "POST",
    headers,
    body: JSON.stringify(createBody),
  });

  if (!createResp.ok) {
    throw new Error(`GHL create contact HTTP ${createResp.status}: ${await createResp.text()}`);
  }

  const createData = await createResp.json();
  const createdId: string | undefined = createData.contact?.id ?? createData.id ?? undefined;

  if (!createdId) {
    throw new Error(`GHL create contact: no id in response: ${JSON.stringify(createData)}`);
  }

  console.log(`[GHL] Created contact ${createdId} — tags: ${tags.join(", ")}`);
  return { action: "created", contactId: createdId };
}

// ─── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  console.log(
    `[zoho-subscription-onboarding] ${requestId} ${req.method} ${req.url}`
  );

  // Only accept POST (Zoho webhooks are POST)
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Parse request body ──
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    console.error(`[${requestId}] Failed to parse request body as JSON`);
    return new Response(
      JSON.stringify({ error: "Request body must be valid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Always log the raw payload so we can diagnose shape variations
  console.log(
    `[${requestId}] Raw Zoho payload:`,
    JSON.stringify(body, null, 2)
  );

  // ── Extract client data ──
  const { clientName, clientEmail, plan } = extractClientData(body);
  const opportunityValue: string | null =
    body.subscription?.line_items?.[0]?.item_total?.toString() ??
    body.data?.subscription?.line_items?.[0]?.item_total?.toString() ??
    null;

  if (!clientName || !clientEmail) {
    console.error(
      `[${requestId}] Could not extract clientName or clientEmail`,
      { clientName, clientEmail, topLevelKeys: Object.keys(body) }
    );
    return new Response(
      JSON.stringify({
        error: "Could not extract client name or email from Zoho payload",
        hint: "Check server logs for the raw payload to identify the correct field paths",
        receivedTopLevelKeys: Object.keys(body),
        extracted: { clientName, clientEmail, plan },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(
    `[${requestId}] Extracted — name: "${clientName}", email: "${clientEmail}", plan: "${plan}"`
  );

  // ── Accumulate result; continue even if individual steps fail ──
  const result: Record<string, unknown> = {
    ok: true,
    requestId,
    clientName,
    clientEmail,
    plan,
  };

  // ── Step 1 + 2: Slack channel ──
  const channelName = buildChannelName(clientName);
  let slackChannelId: string | null = null;

  try {
    const slackResult = await ensureSlackChannel(channelName);
    slackChannelId = slackResult.channelId;
    result.slackChannelId = slackChannelId;
    result.slackChannelName = channelName;
    result.slackChannelAction = slackResult.action;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] Slack channel error: ${msg}`);
    result.slackChannelError = msg;
    result.ok = false;
  }

  // ── Step 3: Slack invite admins ──
  if (slackChannelId) {
    try {
      await inviteAdminsToChannel(slackChannelId);
      result.slackInviteOk = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${requestId}] Slack invite error: ${msg}`);
      result.slackInviteError = msg;
      // Non-fatal: do not flip result.ok
    }
  }

  // ── Step 4: Supabase upsert ──
  try {
    const supabaseResult = await upsertClient({
      clientName,
      clientEmail,
      handle: slugify(clientName),
      slackChannelId,
      plan,
    });
    result.supabaseClientId = supabaseResult.id;
    result.supabaseAction = supabaseResult.action;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] Supabase upsert error: ${msg}`);
    result.supabaseError = msg;
    result.ok = false;
  }

  // ── Step 5: GHL contact sync ──
  try {
    const ghlResult = await syncGHLContact({ clientName, clientEmail, plan, opportunityValue });
    result.ghlAction = ghlResult.action;
    result.ghlContactId = ghlResult.contactId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${requestId}] GHL error: ${msg}`);
    result.ghlError = msg;
    result.ok = false;
  }

  // ── Step 6: Notify team in fulfillment channel ──
  const fulfillmentChannelId = Deno.env.get("SLACK_FULFILLMENT_CHANNEL_ID") || "";
  if (fulfillmentChannelId) {
    try {
      const token = requireEnv("SLACK_BOT_TOKEN");
      const notifyText = `*🆕 New subscription: ${clientName}*
• Email: ${clientEmail}
• Plan: ${plan || "—"}${opportunityValue ? `\n• Value: $${opportunityValue}` : ""}
• Slack: ${slackChannelId ? `<#${slackChannelId}>` : channelName}
• GHL: ${result.ghlContactId ? `Contact created/updated ✓` : "See logs"}`;
      await fetch(`${SLACK_API}/chat.postMessage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: fulfillmentChannelId, text: notifyText, mrkdwn: true }),
      });
      result.slackNotifyOk = true;
    } catch (err) {
      console.error(`[${requestId}] Slack notify error:`, err);
    }
  }

  console.log(`[${requestId}] Done:`, JSON.stringify(result, null, 2));

  // Always respond 200 so Zoho does not retry the webhook
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
