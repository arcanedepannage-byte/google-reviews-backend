import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCodeForTokens } from '../../../lib/google-oauth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`OAuth Error: ${error}`);
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    const refresh = tokens.refresh_token || '(pas de refresh_token renvoyé)';

    res.send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>OAuth OK</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 20px; }
    .ok { color: #16a34a; }
    .box { background: #f3f4f6; padding: 14px; border-radius: 10px; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    code { background: #e5e7eb; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1 class="ok">✅ Authentification réussie</h1>

  <h2>Refresh token à copier</h2>
  <div class="box">${refresh}</div>

  <h2>Étapes</h2>
  <ol>
    <li>Vercel → Project → Settings → Environment Variables</li>
    <li>Ajoute <code>GOOGLE_REFRESH_TOKEN</code> = le token ci-dessus</li>
    <li>Redéploie</li>
    <li>Teste <code>/api/google/refresh</code> puis <code>/api/google-reviews</code></li>
  </ol>

  <p>Si tu vois “pas de refresh_token renvoyé”, relance l’auth en forçant le consentement (déjà activé via <code>prompt=consent</code>).</p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`Error exchanging code: ${String(err)}`);
  }
}
