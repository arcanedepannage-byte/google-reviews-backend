import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCache } from '../lib/cache';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS pour Lovable
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const cached = await getCache();

    if (!cached) {
      return res.status(503).json({
        error: 'Reviews not yet cached. Call /api/google/refresh first.',
        rating: 5.0,
        totalReviewCount: 0,
        reviews: [],
        lastUpdated: null,
      });
    }

    res.json(cached);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
