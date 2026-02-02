import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuthUrl } from '../../../lib/google-oauth';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const authUrl = getAuthUrl();
  res.redirect(authUrl);
}
