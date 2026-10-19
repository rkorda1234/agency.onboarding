// Canva OAuth helper (PKCE flow). Open it in a browser to (re)connect Canva; the
// refresh token is saved to integration_tokens. Only deploy it while reconnecting.

const CLIENT_ID = Deno.env.get("CANVA_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("CANVA_CLIENT_SECRET") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const REDIRECT_URI = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/canva-oauth-helper`;

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return { verifier, challenge };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // Step 2: Canva redirected back with a code — exchange it for tokens
  if (code) {
    // Read code_verifier from cookie
    const cookieHeader = req.headers.get("cookie") ?? "";
    const verifierMatch = cookieHeader.match(/pkce_verifier=([^;]+)/);
    const codeVerifier = verifierMatch?.[1];

    if (!codeVerifier) {
      return new Response(html(`
        <h2 style="color:#e74c3c">Session expired</h2>
        <p>The PKCE verifier cookie was not found. This can happen if the browser blocked cookies or the session timed out.</p>
        <p><a href="${REDIRECT_URI}">Start over</a></p>
      `), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const resp = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const data = await resp.json();

    if (!data.refresh_token) {
      return new Response(html(`
        <h2 style="color:#e74c3c">Token exchange failed</h2>
        <pre>${JSON.stringify(data, null, 2)}</pre>
        <p><a href="${REDIRECT_URI}">Try again</a></p>
      `), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Save straight to integration_tokens; creative-brief-onboarding rotates it from there.
    const saveResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/integration_tokens`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ provider: "canva", refresh_token: data.refresh_token, updated_at: new Date().toISOString() }),
    });
    if (!saveResp.ok) {
      return new Response(html(`
        <h2 style="color:#e74c3c">Connected to Canva, but saving failed</h2>
        <pre>${await saveResp.text()}</pre>
        <p><a href="${REDIRECT_URI}">Try again</a></p>
      `), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response(html(`
      <h2 style="color:#27ae60">Canva connected ✓</h2>
      <p>New client briefs will create Canva designs again. You can close this tab.</p>
    `), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "pkce_verifier=; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      },
    });
  }

  if (error) {
    return new Response(html(`
      <h2 style="color:#e74c3c">Canva returned an error</h2>
      <p><strong>${error}</strong>: ${url.searchParams.get("error_description") ?? ""}</p>
      <p><a href="${REDIRECT_URI}">Try again</a></p>
    `), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Step 1: Generate PKCE pair, set cookie, redirect to Canva
  const { verifier, challenge } = await generatePKCE();

  const authUrl = new URL("https://www.canva.com/api/oauth/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "design:content:write design:content:read design:meta:read");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `pkce_verifier=${verifier}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
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
    pre { background: #f5f5f5; padding: 16px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    a { color: #7c4dff; }
  </style>
</head>
<body>${body}</body>
</html>`;
}
