import { kv } from '@vercel/kv';

const CACHE_KEY = 'google-reviews-cache';
const CACHE_TTL_SECONDS = 90000; // 25h

export type CachedReviews = {
  rating: number;
  totalReviewCount: number;
  reviews: {
    author: string;
    rating: number;
    comment: string;
    createTime: string;
    url: string | null;
  }[];
  lastUpdated: string;
};

// Fallback mémoire (utile en dev, pas fiable en prod serverless)
let inMemoryCache: CachedReviews | null = null;

export async function getCache(): Promise<CachedReviews | null> {
  try {
    const data = await kv.get<CachedReviews>(CACHE_KEY);
    if (data) return data;
  } catch {
    // KV pas dispo -> fallback mémoire
  }
  return inMemoryCache;
}

export async function setCache(data: CachedReviews): Promise<void> {
  inMemoryCache = data;

  try {
    await kv.set(CACHE_KEY, data, { ex: CACHE_TTL_SECONDS });
  } catch {
    // KV pas dispo -> mémoire seulement
  }
}
