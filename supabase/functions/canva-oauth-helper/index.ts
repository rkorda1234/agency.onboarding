// One-time Canva OAuth helper — get a refresh token without n8n
// Delete this function after you've saved CANVA_REFRESH_TOKEN to Supabase secrets.

const CLIENT_ID = Deno.env.get("CANVA_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("CANVA_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("SUPABASE_URL")
  ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/canva-oauth-helper`
  : "";

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // Step 2: Canva redirected back with a code — exchange it for tokens
  if (code) {
    const credentials = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
    const resp = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await resp.json();

    if (!data.refresh_token) {
      return new Response(html(`
        <h2 style="color:#e74c3c">❌ Token exchange failed</h2>
        <pre>${JSON.stringify(data, null, 2)}</pre>
        <p>Check that CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are set correctly in Supabase secrets.</p>
      `), { headers: { "Content-Type": "text/html" } });
    }

    return new Response(html(`
      <h2 style="color:#27ae60">✅ Got your Canva refresh token!</h2>
      <p>Copy the value below and add it to Supabase → Project Settings → Edge Functions → Secrets as <strong>CANVA_REFRESH_TOKEN</strong>:</p>
      <textarea readonly onclick="this.select()" style="width:100%;height:80px;font-family:monospace;font-size:13px;padding:8px;border:2px solid #27ae60;border-radius:4px;">${data.refresh_token}</textarea>
      <p style="margin-top:16px;color:#888">Access token (expires in ~1 hour — do NOT store this):<br><code style="font-size:11px;word-break:break-all">${data.access_token}</code></p>
      <p style="margin-top:24px;background:#fff3cd;padding:12px;border-radius:4px;">
        ⚠️ Once you've saved the refresh token to Supabase secrets, <strong>delete this edge function</strong> from the Supabase dashboard — it's a temporary helper.
      </p>
    `), { headers: { "Content-Type": "text/html" } });
  }

  if (error) {
    return new Response(html(`
      <h2 style="color:#e74c3c">❌ Canva returned an error</h2>
      <p><strong>${error}</strong>: ${url.searchParams.get("error_description") ?? ""}</p>
      <p><a href="${REDIRECT_URI}">Try again</a></p>
    `), { headers: { "Content-Type": "text/html" } });
  }

  // Step 1: Show the "Connect Canva" page
  const authUrl = new URL("https://www.canva.com/api/oauth/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "design:content:write");

  return new Response(html(`
    <h2>Canva OAuth — one-time setup</h2>
    <p>Click below to connect your Canva account and get a refresh token. You only need to do this once.</p>
    <a href="${authUrl.toString()}" style="display:inline-block;background:#7c4dff;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:600;">
      🎨 Connect Canva
    </a>
    <p style="margin-top:24px;color:#888;font-size:13px;">
      Redirect URI in use:<br><code>${REDIRECT_URI}</code><br><br>
      Make sure this URL is listed in your Canva Developer Portal → Authentication → Authorized redirects.
    </p>
  `), { headers: { "Content-Type": "text/html" } });
});

function html(body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Canva OAuth Helper</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 24px; color: #222; }
    h2 { margin-bottom: 16px; }
    pre { background: #f5f5f5; padding: 16px; border-radius: 6px; overflow-x: auto; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}
