import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchGoogleReviews } from '../../lib/google-reviews';
import { setCache } from '../../lib/cache';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (pour tests simples)
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const data = await fetchGoogleReviews();
    await setCache(data);

    res.json({
      success: true,
      message: 'Reviews synced successfully',
      data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
}
