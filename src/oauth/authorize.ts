// Authorization endpoint. Where the user actually pastes their Roo API key.
//
// Flow:
//   GET  /authorize?...  → render branded HTML form (API key + hidden OAuth params)
//   POST /authorize      → validate API key against Roo, mint JWE code, 302 back to
//                          the client's redirect_uri with code + state.
//
// The redirect_uri was registered via DCR, encoded into the client_id JWE, and is
// re-validated here. The code JWE binds the key, PKCE challenge, and redirect_uri
// together so /token can verify the exchange is from the same client that initiated.
//
// We also render the client's name and the redirect host prominently so a user who
// did NOT initiate this flow (phishing) sees an unfamiliar app name and bails.
import { RooClient } from '../roo-client.js';
import { decryptClientId, mintAuthCode } from './jwe.js';
import { ROO_ICON_DATA_URL } from '../icon.js';

interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  state: string | null;
  scope: string | null;
}

function readParams(input: URLSearchParams): AuthorizeParams {
  return {
    responseType: input.get('response_type'),
    clientId: input.get('client_id'),
    redirectUri: input.get('redirect_uri'),
    codeChallenge: input.get('code_challenge'),
    codeChallengeMethod: input.get('code_challenge_method'),
    state: input.get('state'),
    scope: input.get('scope'),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function renderErrorPage(title: string, message: string): Response {
  const html = pageShell({
    title,
    bodyHtml: `
      <h1>${escapeHtml(title)}</h1>
      <p class="muted">${escapeHtml(message)}</p>
      <p class="muted small">If a client sent you here, close this tab and retry from that app.</p>
    `,
  });
  return new Response(html, {
    status: 400,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

interface FormOptions {
  params: AuthorizeParams;
  clientName: string;
  redirectHost: string;
  error?: string;
}

function renderForm({ params, clientName, redirectHost, error }: FormOptions): Response {
  const safeClient = escapeHtml(clientName);
  const safeHost = escapeHtml(redirectHost);
  const hidden = [
    ['response_type', params.responseType],
    ['client_id', params.clientId],
    ['redirect_uri', params.redirectUri],
    ['code_challenge', params.codeChallenge],
    ['code_challenge_method', params.codeChallengeMethod],
    ['state', params.state],
    ['scope', params.scope],
  ]
    .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
    .map(
      ([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`,
    )
    .join('\n');

  const errorHtml = error
    ? `<div class="error" role="alert">${escapeHtml(error)}</div>`
    : '';

  const bodyHtml = `
    <h1>Connect <span class="client">${safeClient}</span> to Roo</h1>
    <p class="muted">
      Paste your Roo API key below. ${safeClient} will be able to create and manage
      shortlinks on your account.
    </p>
    <p class="muted small">
      After you continue, your browser will be sent back to <code>${safeHost}</code>.
      If you didn't start this flow from ${safeClient}, close this tab.
    </p>
    ${errorHtml}
    <form method="POST" action="/authorize" autocomplete="off">
      ${hidden}
      <label for="api_key">Roo API key</label>
      <input
        id="api_key"
        name="api_key"
        type="password"
        inputmode="text"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        autocomplete="off"
        required
        placeholder="rk_..."
      >
      <button type="submit">Continue</button>
    </form>
    <p class="muted small">
      Don't have an API key?
      <a href="https://app.roo.bz/account/api-keys" target="_blank" rel="noopener">
        Get one at app.roo.bz
      </a>
      (Account Settings → Api Keys).
    </p>
  `;
  return new Response(pageShell({ title: `Connect ${clientName} to Roo`, bodyHtml }), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Hard against the authorize page being iframed from another origin — phishing kills.
      'content-security-policy':
        "default-src 'self'; img-src data: https:; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    },
  });
}

interface ShellOptions {
  title: string;
  bodyHtml: string;
}

function pageShell({ title, bodyHtml }: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="${ROO_ICON_DATA_URL}">
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #0f172a;
      --muted: #475569;
      --card: #ffffff;
      --border: #e2e8f0;
      --input-bg: #f8fafc;
      --accent: #4f46e5;
      --accent-fg: #ffffff;
      --error-bg: #fef2f2;
      --error-fg: #991b1b;
      --error-border: #fecaca;
      --code-bg: #f1f5f9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b1120;
        --fg: #f1f5f9;
        --muted: #94a3b8;
        --card: #111827;
        --border: #1f2937;
        --input-bg: #0b1120;
        --accent: #818cf8;
        --accent-fg: #0b1120;
        --error-bg: #1f1215;
        --error-fg: #fecaca;
        --error-border: #7f1d1d;
        --code-bg: #1e293b;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      line-height: 1.5;
    }
    main {
      width: 100%;
      max-width: 440px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px 28px 24px;
      box-shadow: 0 10px 30px rgba(2, 6, 23, 0.06);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
    }
    .brand img {
      width: 28px;
      height: 28px;
      border-radius: 6px;
    }
    .brand span {
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 8px;
      letter-spacing: -0.01em;
    }
    h1 .client { color: var(--accent); }
    p { margin: 0 0 12px; }
    p.muted { color: var(--muted); font-size: 0.95rem; }
    p.small { font-size: 0.85rem; }
    code {
      background: var(--code-bg);
      border-radius: 4px;
      padding: 1px 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
    }
    form { margin-top: 20px; display: flex; flex-direction: column; gap: 8px; }
    label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--muted);
    }
    input[type="password"] {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.95rem;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--input-bg);
      color: var(--fg);
      outline: none;
    }
    input[type="password"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.2);
    }
    button {
      margin-top: 8px;
      padding: 10px 14px;
      border: none;
      border-radius: 8px;
      background: var(--accent);
      color: var(--accent-fg);
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
    }
    button:hover { filter: brightness(1.05); }
    .error {
      background: var(--error-bg);
      color: var(--error-fg);
      border: 1px solid var(--error-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 12px;
      font-size: 0.9rem;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <img src="${ROO_ICON_DATA_URL}" alt="">
      <span>Roo</span>
    </div>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

async function resolveClient(
  clientId: string,
): Promise<{ ok: true; clientName: string; redirectUris: string[] } | { ok: false; reason: string }> {
  try {
    const payload = await decryptClientId(clientId);
    return { ok: true, clientName: payload.clientName, redirectUris: payload.redirectUris };
  } catch {
    return { ok: false, reason: 'The client_id in this request is invalid or expired. Re-register the client with the authorization server.' };
  }
}

function validateParams(
  params: AuthorizeParams,
  registeredRedirects: string[],
): string | null {
  if (params.responseType !== 'code') {
    return `Unsupported response_type: ${params.responseType ?? '(missing)'}. Only "code" is supported.`;
  }
  if (params.codeChallengeMethod !== 'S256') {
    return `Unsupported code_challenge_method: ${params.codeChallengeMethod ?? '(missing)'}. Only "S256" is supported.`;
  }
  if (!params.codeChallenge) {
    return 'Missing code_challenge. PKCE is required.';
  }
  if (!params.redirectUri) {
    return 'Missing redirect_uri.';
  }
  if (!registeredRedirects.includes(params.redirectUri)) {
    return `redirect_uri "${params.redirectUri}" is not registered for this client.`;
  }
  return null;
}

export async function handleAuthorizeGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = readParams(url.searchParams);

  if (!params.clientId) {
    return renderErrorPage('Missing client_id', 'This request is missing a client_id.');
  }
  const client = await resolveClient(params.clientId);
  if (!client.ok) return renderErrorPage('Invalid client', client.reason);

  const err = validateParams(params, client.redirectUris);
  if (err) return renderErrorPage('Invalid authorization request', err);

  return renderForm({
    params,
    clientName: client.clientName,
    redirectHost: hostOf(params.redirectUri!),
  });
}

export async function handleAuthorizePost(request: Request): Promise<Response> {
  const bodyText = await request.text();
  const body = new URLSearchParams(bodyText);
  const params = readParams(body);
  const apiKey = body.get('api_key');

  if (!params.clientId) {
    return renderErrorPage('Missing client_id', 'This request is missing a client_id.');
  }
  const client = await resolveClient(params.clientId);
  if (!client.ok) return renderErrorPage('Invalid client', client.reason);

  const err = validateParams(params, client.redirectUris);
  if (err) return renderErrorPage('Invalid authorization request', err);

  if (!apiKey) {
    return renderForm({
      params,
      clientName: client.clientName,
      redirectHost: hostOf(params.redirectUri!),
      error: 'Paste your Roo API key to continue.',
    });
  }

  // Validate the API key against Roo. One cheap /v1/me call.
  const roo = new RooClient({ apiKey });
  try {
    await roo.get('/v1/me');
  } catch {
    return renderForm({
      params,
      clientName: client.clientName,
      redirectHost: hostOf(params.redirectUri!),
      error:
        'That API key did not work. Double-check it in app.roo.bz → Account Settings → Api Keys.',
    });
  }

  const code = await mintAuthCode({
    rooApiKey: apiKey,
    codeChallenge: params.codeChallenge!,
    codeChallengeMethod: 'S256',
    redirectUri: params.redirectUri!,
    clientId: params.clientId,
  });

  const redirect = new URL(params.redirectUri!);
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', params.state);

  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString(), 'cache-control': 'no-store' },
  });
}
