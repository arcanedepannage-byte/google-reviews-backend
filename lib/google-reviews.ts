import { refreshAccessToken } from './google-oauth';
import type { CachedReviews } from './cache';

const GBP_ACCOUNT_ID = process.env.GBP_ACCOUNT_ID;
const GBP_LOCATION_ID = process.env.GBP_LOCATION_ID;

type GoogleReview = {
  reviewer?: { displayName?: string };
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  createTime: string;
};

function starRatingToNumber(r: string): number {
  const map: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return map[r] ?? 0;
}

async function getAccountId(accessToken: string): Promise<string> {
  if (GBP_ACCOUNT_ID) return GBP_ACCOUNT_ID;

  const res = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch accounts: ${await res.text()}`);

  const data = await res.json();
  const first = data.accounts?.[0]?.name; // "accounts/123"
  if (!first) throw new Error('No accounts found (are you owner/manager of a Business Profile?)');

  return String(first).replace('accounts/', '');
}

async function getLocationInfo(accessToken: string, accountId: string): Promise<{ locationId: string; placeId: string | null }> {
  // readMask=metadata pour récupérer metadata.placeId si dispo
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations?readMask=name,metadata`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch locations: ${await res.text()}`);

  const data = await res.json();
  const locations = data.locations || [];
  if (!locations.length) throw new Error('No locations found on this account');

  // Si GBP_LOCATION_ID est fourni, on essaie de matcher, sinon on prend la 1ère location
  let loc = locations[0];
  if (GBP_LOCATION_ID) {
    const match = locations.find((l: any) => String(l.name || '').endsWith(`/${GBP_LOCATION_ID}`));
    if (match) loc = match;
  }

  const name = String(loc.name || ''); // "accounts/123/locations/456"
  const locationId = GBP_LOCATION_ID || name.split('/').pop();
  if (!locationId) throw new Error('Unable to determine locationId');

  const placeId = loc.metadata?.placeId ? String(loc.metadata.placeId) : null;
  return { locationId, placeId };
}

export async function fetchGoogleReviews(): Promise<CachedReviews> {
  const accessToken = await refreshAccessToken();

  const accountId = await getAccountId(accessToken);
  const { locationId, placeId } = await getLocationInfo(accessToken, accountId);

  // API reviews (v4)
  const reviewsRes = await fetch(
    `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!reviewsRes.ok) {
    throw new Error(`Failed to fetch reviews: ${await reviewsRes.text()}`);
  }

  const data = await reviewsRes.json();

  // Lien public (optionnel) basé sur placeId, sinon null
  const reviewsUrl = placeId ? `https://search.google.com/local/reviews?placeid=${placeId}` : null;

  // On limite à 5 pour affichage
  const reviews = (data.reviews || []).slice(0, 5).map((r: GoogleReview) => ({
    author: r.reviewer?.displayName || 'Client',
    rating: starRatingToNumber(r.starRating),
    comment: r.comment || '',
    createTime: r.createTime,
    url: reviewsUrl,
  }));

  // IMPORTANT : ne pas recalculer la note globale depuis 5 avis
  const rating = typeof data.averageRating === 'number' ? data.averageRating : 5.0;
  const totalReviewCount = typeof data.totalReviewCount === 'number' ? data.totalReviewCount : reviews.length;

  return {
    rating,
    totalReviewCount,
    reviews,
    lastUpdated: new Date().toISOString(),
  };
}
