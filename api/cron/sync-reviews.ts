import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchGoogleReviews } from '../../lib/google-reviews';
import { setCache } from '../../lib/cache';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Autorisé si:
  // 1) Appelé par Vercel Cron (header auto)
  // 2) OU appel manuel avec ?secret=CRON_SECRET
  const isVercelCron = Boolean(req.headers['x-vercel-cron-job-id']);
  const expected = process.env.CRON_SECRET;
  const provided = typeof req.query.secret === 'string' ? req.query.secret : undefined;

  const ok = isVercelCron || (expected && provided === expected);

  if (!ok) {
    return res.status(401).json({
      error: 'Unauthorized. Use ?secret=CRON_SECRET (manual) or call from Vercel Cron.',
    });
  }

  try {
    const data = await fetchGoogleReviews();
    await setCache(data);

    res.json({
      success: true,
      synced: data.reviews.length,
      rating: data.rating,
      totalReviewCount: data.totalReviewCount,
      lastUpdated: data.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
}
