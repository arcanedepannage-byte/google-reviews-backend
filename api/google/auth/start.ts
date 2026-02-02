

# Plan CorrigÃ© : Backend Vercel pour Google Business Profile (OAuth 2.0)

## Corrections apportÃ©es par rapport au plan original

| ProblÃ¨me | Correction |
|----------|------------|
| **A) Encodage UTF-8** | Tous les caracteres speciaux (emojis, accents) ecrits en HTML entities ou ASCII simple |
| **B) placeId vs locationId** | Recuperation du vrai `metadata.placeId` depuis l'API Location, sinon URL omise |
| **C) Note moyenne** | Utilisation de `averageRating` et `totalReviewCount` de Google, pas de recalcul |
| **D) Cache Vercel KV** | KV obligatoire en prod, warning explicite si fallback memoire utilise |
| **E) Cron Auth** | Securisation via query param `?secret=CRON_SECRET` (plus fiable que header) |

---

## Structure du projet finale

```text
google-reviews-backend/
|-- api/
|   |-- google/
|   |   |-- auth/
|   |   |   |-- start.ts
|   |   |   |-- callback.ts
|   |   |-- refresh.ts
|   |-- google-reviews.ts
|   |-- cron/
|       |-- sync-reviews.ts
|-- lib/
|   |-- google-oauth.ts
|   |-- google-reviews.ts
|   |-- cache.ts
|-- vercel.json
|-- package.json
|-- tsconfig.json
|-- README.md
```

---

## Fichiers complets a creer

### 1. package.json

```json
{
  "name": "google-reviews-backend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vercel dev",
    "build": "tsc",
    "deploy": "vercel --prod"
  },
  "dependencies": {
    "@vercel/kv": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@vercel/node": "^3.0.0",
    "typescript": "^5.0.0",
    "vercel": "^33.0.0"
  }
}
```

### 2. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["api/**/*", "lib/**/*"],
  "exclude": ["node_modules"]
}
```

### 3. vercel.json

```json
{
  "crons": [
    {
      "path": "/api/cron/sync-reviews",
      "schedule": "0 2 * * *"
    }
  ]
}
```

Note : Vercel Cron ne supporte pas l'envoi de query params dans `vercel.json`. La route `/api/cron/sync-reviews` utilisera `VERCEL_CRON_JOB_ID` (header injecte automatiquement par Vercel) OU un secret en query param pour les appels manuels.

### 4. lib/google-oauth.ts

```typescript
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID!;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI!;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const SCOPES = [
  'https://www.googleapis.com/auth/business.manage'
];

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

export async function refreshAccessToken(): Promise<string> {
  if (!GOOGLE_REFRESH_TOKEN) {
    throw new Error('GOOGLE_REFRESH_TOKEN not configured');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}
```

### 5. lib/google-reviews.ts (CORRIGE)

```typescript
import { refreshAccessToken } from './google-oauth';

const GBP_ACCOUNT_ID = process.env.GBP_ACCOUNT_ID;
const GBP_LOCATION_ID = process.env.GBP_LOCATION_ID;

interface GoogleReview {
  name: string;
  reviewer: { displayName: string };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime: string;
}

interface LocationInfo {
  accountId: string;
  locationId: string;
  locationName: string;
  placeId: string | null;
}

interface ReviewsResponse {
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
}

// Convertit FIVE -> 5, FOUR -> 4, etc.
function starRatingToNumber(rating: string): number {
  const map: Record<string, number> = {
    'FIVE': 5, 'FOUR': 4, 'THREE': 3, 'TWO': 2, 'ONE': 1
  };
  return map[rating] || 0;
}

// Recupere account, location ET placeId
async function getLocationInfo(accessToken: string): Promise<LocationInfo> {
  let accountId = GBP_ACCOUNT_ID;
  let locationId = GBP_LOCATION_ID;
  let locationName = '';
  let placeId: string | null = null;

  // Recuperer les comptes si non configure
  if (!accountId) {
    const accountsRes = await fetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    
    if (!accountsRes.ok) throw new Error('Failed to fetch accounts');
    const accountsData = await accountsRes.json();
    
    if (!accountsData.accounts?.length) throw new Error('No accounts found');
    const accountName = accountsData.accounts[0].name;
    accountId = accountName.replace('accounts/', '');
  }

  // Recuperer les locations avec readMask pour avoir metadata.placeId
  const locationsRes = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations?readMask=name,metadata`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  
  if (!locationsRes.ok) throw new Error('Failed to fetch locations');
  const locationsData = await locationsRes.json();
  
  if (!locationsData.locations?.length) throw new Error('No locations found');
  
  const location = locationsData.locations[0];
  locationName = location.name;
  locationId = locationId || locationName.split('/').pop()!;
  
  // Extraire le vrai placeId depuis metadata
  placeId = location.metadata?.placeId || null;

  return { accountId, locationId, locationName, placeId };
}

export async function fetchGoogleReviews(): Promise<ReviewsResponse> {
  const accessToken = await refreshAccessToken();
  const { accountId, locationId, placeId } = await getLocationInfo(accessToken);

  // Recuperer les avis
  const reviewsRes = await fetch(
    `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!reviewsRes.ok) {
    const error = await reviewsRes.text();
    throw new Error(`Failed to fetch reviews: ${error}`);
  }

  const data = await reviewsRes.json();
  
  // Construire l'URL Google Reviews avec le VRAI placeId
  const reviewsUrl = placeId 
    ? `https://search.google.com/local/reviews?placeid=${placeId}`
    : null;

  // Mapper les 5 derniers avis pour affichage
  const reviews = (data.reviews || []).slice(0, 5).map((review: GoogleReview) => ({
    author: review.reviewer?.displayName || 'Client',
    rating: starRatingToNumber(review.starRating),
    comment: review.comment || '',
    createTime: review.createTime,
    url: reviewsUrl
  }));

  // IMPORTANT: Utiliser averageRating et totalReviewCount de Google
  // Ne PAS recalculer depuis les 5 derniers avis
  return {
    rating: data.averageRating ?? 5.0,
    totalReviewCount: data.totalReviewCount ?? reviews.length,
    reviews,
    lastUpdated: new Date().toISOString()
  };
}
```

### 6. lib/cache.ts (CORRIGE)

```typescript
import { kv } from '@vercel/kv';

const CACHE_KEY = 'google-reviews-cache';
const CACHE_TTL = 90000; // 25 heures en secondes

interface CachedData {
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
}

// Cache en memoire (fallback TEMPORAIRE - pas fiable en prod)
let inMemoryCache: CachedData | null = null;
let kvAvailable: boolean | null = null;

async function checkKvAvailable(): Promise<boolean> {
  if (kvAvailable !== null) return kvAvailable;
  
  try {
    await kv.ping();
    kvAvailable = true;
    console.log('[Cache] Vercel KV disponible');
  } catch {
    kvAvailable = false;
    console.warn('[Cache] ATTENTION: Vercel KV non disponible. Le cache memoire sera perdu entre les requetes.');
  }
  
  return kvAvailable;
}

export async function getCache(): Promise<CachedData | null> {
  const isKvAvailable = await checkKvAvailable();
  
  if (isKvAvailable) {
    try {
      const data = await kv.get<CachedData>(CACHE_KEY);
      if (data) return data;
    } catch (e) {
      console.error('[Cache] Erreur lecture KV:', e);
    }
  }
  
  // Fallback memoire (pas fiable en serverless)
  return inMemoryCache;
}

export async function setCache(data: CachedData): Promise<void> {
  // Toujours stocker en memoire (backup immediat)
  inMemoryCache = data;
  
  const isKvAvailable = await checkKvAvailable();
  
  if (isKvAvailable) {
    try {
      await kv.set(CACHE_KEY, data, { ex: CACHE_TTL });
      console.log('[Cache] Donnees stockees dans Vercel KV');
    } catch (e) {
      console.error('[Cache] Erreur ecriture KV:', e);
    }
  } else {
    console.warn('[Cache] Donnees stockees en memoire uniquement (temporaire)');
  }
}
```

### 7. api/google/auth/start.ts

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuthUrl } from '../../../lib/google-oauth';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const authUrl = getAuthUrl();
  res.redirect(authUrl);
}
```

### 8. api/google/auth/callback.ts (CORRIGE UTF-8)

```typescript
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
    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <title>OAuth Success</title>
          <style>
            body { font-family: system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .token-box { background: #f0f0f0; padding: 15px; border-radius: 8px; word-break: break-all; margin: 20px 0; font-family: monospace; }
            .success { color: #16a34a; }
            code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; }
            .step { margin: 20px 0; padding: 15px; border-left: 4px solid #3b82f6; background: #eff6ff; }
          </style>
        </head>
        <body>
          <h1 class="success">[OK] Authentification reussie !</h1>
          
          <div class="step">
            <h2>Etape 1 - Copie ce Refresh Token :</h2>
            <div class="token-box">${tokens.refresh_token}</div>
          </div>
          
          <div class="step">
            <h2>Etape 2 - Ajoute-le dans Vercel :</h2>
            <ol>
              <li>Va sur <a href="https://vercel.com" target="_blank">vercel.com</a> &rarr; ton projet</li>
              <li>Settings &rarr; Environment Variables</li>
              <li>Ajoute : <code>GOOGLE_REFRESH_TOKEN</code> = le token ci-dessus</li>
              <li>Redemploie le projet</li>
            </ol>
          </div>
          
          <div class="step">
            <h2>Etape 3 - Teste l'endpoint :</h2>
            <p>Une fois redemploye, accede a <code>/api/google/refresh</code> puis <code>/api/google-reviews</code></p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Error exchanging code: ${err}`);
  }
}
```

### 9. api/google/refresh.ts

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchGoogleReviews } from '../../lib/google-reviews';
import { setCache } from '../../lib/cache';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    console.log('[Refresh] Demarrage sync manuelle...');
    const reviews = await fetchGoogleReviews();
    await setCache(reviews);

    console.log(`[Refresh] Sync OK: ${reviews.reviews.length} avis, note ${reviews.rating}`);
    
    res.json({ 
      success: true, 
      message: 'Reviews synced successfully',
      data: reviews 
    });
  } catch (err) {
    console.error('[Refresh] Erreur:', err);
    res.status(500).json({ 
      success: false, 
      error: String(err) 
    });
  }
}
```

### 10. api/google-reviews.ts

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getCache } from '../lib/cache';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers pour Lovable
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const cached = await getCache();

    if (!cached) {
      return res.status(503).json({
        error: 'Reviews not yet cached. Call /api/google/refresh first.',
        rating: 5.0,
        totalReviewCount: 30,
        reviews: [],
        lastUpdated: null
      });
    }

    res.json(cached);
  } catch (err) {
    console.error('[google-reviews] Erreur:', err);
    res.status(500).json({ error: String(err) });
  }
}
```

### 11. api/cron/sync-reviews.ts (CORRIGE Auth)

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchGoogleReviews } from '../../lib/google-reviews';
import { setCache } from '../../lib/cache';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Securite: verifier l'origine de l'appel
  const isVercelCron = req.headers['x-vercel-cron-job-id'];
  const secretParam = req.query.secret;
  const expectedSecret = process.env.CRON_SECRET;

  // Autoriser si:
  // 1. Appel depuis Vercel Cron (header automatique)
  // 2. OU secret correct en query param (pour tests manuels)
  const isAuthorized = isVercelCron || (expectedSecret && secretParam === expectedSecret);

  if (!isAuthorized) {
    console.warn('[Cron] Acces refuse - ni Vercel Cron ni secret valide');
    return res.status(401).json({ 
      error: 'Unauthorized. Use ?secret=YOUR_CRON_SECRET or call from Vercel Cron.' 
    });
  }

  try {
    console.log('[Cron] Demarrage sync quotidienne...');
    const startTime = Date.now();
    
    const reviews = await fetchGoogleReviews();
    await setCache(reviews);
    
    const duration = Date.now() - startTime;
    console.log(`[Cron] Sync OK en ${duration}ms: ${reviews.reviews.length} avis, note ${reviews.rating}/5`);
    
    res.json({ 
      success: true, 
      synced: reviews.reviews.length,
      rating: reviews.rating,
      totalReviewCount: reviews.totalReviewCount,
      duration: `${duration}ms`
    });
  } catch (err) {
    console.error('[Cron] Sync echouee:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
}
```

---

## README.md (COMPLET)

```markdown
# Google Reviews Backend pour Vercel

Backend minimal pour recuperer les avis Google Business Profile via OAuth 2.0.

> **Important**: Ce backend utilise l'API officielle Google Business Profile.
> Il ne fait PAS de scraping et respecte les conditions Google.

---

## Checklist de deploiement (7 etapes)

### Etape 1 - Creer le repository GitHub

1. Creer un nouveau repo `google-reviews-backend`
2. Copier tous les fichiers de ce plan
3. `npm install`
4. Commit et push

### Etape 2 - Deployer sur Vercel

1. Installer Vercel CLI: `npm i -g vercel`
2. Dans le dossier du projet: `vercel --prod`
3. Noter l'URL finale: `https://ton-projet.vercel.app`

### Etape 3 - Configurer Google Cloud Console

1. Aller sur [console.cloud.google.com](https://console.cloud.google.com/)
2. Creer un nouveau projet ou en selectionner un existant
3. Dans le menu, aller a **APIs & Services > Library**
4. Activer ces APIs:
   - **My Business Account Management API**
   - **My Business Business Information API**
5. Aller a **APIs & Services > Credentials**
6. Cliquer sur **Create Credentials > OAuth client ID**
7. Type: **Web application**
8. Nom: `Google Reviews Backend`
9. **IMPORTANT**:
   - **Origines JavaScript autorisees**: LAISSER VIDE
   - **URI de redirection autorises**: `https://ton-projet.vercel.app/api/google/auth/callback`
10. Cliquer sur **Create**
11. Noter le **Client ID** et **Client Secret**

### Etape 4 - Configurer les variables d'environnement Vercel

Aller sur vercel.com > ton projet > Settings > Environment Variables

| Variable | Valeur | Obligatoire |
|----------|--------|-------------|
| `GOOGLE_OAUTH_CLIENT_ID` | `123456-xxx.apps.googleusercontent.com` | Oui |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `GOCSPX-xxx` | Oui |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://ton-projet.vercel.app/api/google/auth/callback` | Oui |
| `GOOGLE_REFRESH_TOKEN` | (a remplir apres etape 5) | Oui |
| `CRON_SECRET` | un mot de passe aleatoire (ex: `abc123xyz`) | Recommande |
| `GBP_ACCOUNT_ID` | (optionnel) | Non |
| `GBP_LOCATION_ID` | (optionnel) | Non |

Redemployer apres avoir ajoute les variables.

### Etape 5 - Obtenir le Refresh Token

1. Redemployer: `vercel --prod`
2. Ouvrir dans le navigateur: `https://ton-projet.vercel.app/api/google/auth/start`
3. Se connecter avec le compte **proprietaire de la fiche Google Business**
4. Autoriser l'acces
5. Copier le **refresh_token** affiche
6. Ajouter dans Vercel: `GOOGLE_REFRESH_TOKEN` = le token copie
7. Redemployer

### Etape 6 - Tester

1. Forcer une sync: `https://ton-projet.vercel.app/api/google/refresh`
   - Reponse attendue: `{ "success": true, "data": { ... } }`

2. Verifier les avis: `https://ton-projet.vercel.app/api/google-reviews`
   - Reponse attendue: voir ci-dessous

### Etape 7 - C'est automatique !

Le cron Vercel appellera `/api/cron/sync-reviews` tous les jours a 02:00 UTC (03:00 Paris).

Pour tester manuellement le cron:
```
https://ton-projet.vercel.app/api/cron/sync-reviews?secret=TON_CRON_SECRET
```

---

## Format de reponse /api/google-reviews

```json
{
  "rating": 5.0,
  "totalReviewCount": 32,
  "reviews": [
    {
      "author": "Nicolas G.",
      "rating": 5,
      "comment": "Tres satisfait du service...",
      "createTime": "2025-01-28T10:00:00Z",
      "url": "https://search.google.com/local/reviews?placeid=ChIJ..."
    }
  ],
  "lastUpdated": "2025-01-29T02:00:00Z"
}
```

---

## Integration Lovable

Une fois le backend fonctionnel, fournir l'URL (ex: `https://arcane-reviews.vercel.app`).

Le composant `GoogleRatingBadge.tsx` sera modifie pour consommer directement:

```typescript
useEffect(() => {
  fetch('https://ton-backend.vercel.app/api/google-reviews')
    .then(res => res.json())
    .then(data => {
      setRating(data.rating);
      setTotalReviews(data.totalReviewCount);
    });
}, []);
```

---

## Depannage

| Probleme | Solution |
|----------|----------|
| "Token exchange failed" | Verifier que l'URI de redirection est exactement identique dans Google Console et Vercel |
| "No accounts found" | Le compte Google connecte n'est pas proprietaire d'une fiche Business |
| "GOOGLE_REFRESH_TOKEN not configured" | Ajouter la variable puis redemployer |
| Donnees non persistantes | Configurer Vercel KV (obligatoire en prod) |

---

## Notes techniques

- **Cache**: Vercel KV est obligatoire en production pour persister les donnees entre les requetes.
- **Cron**: Vercel Cron injecte automatiquement le header `x-vercel-cron-job-id`.
- **placeId vs locationId**: Le `placeId` est recupere depuis `metadata.placeId` de l'API Location.
- **averageRating**: Utilise directement la valeur Google, pas de recalcul local.
```

---

## Resume des corrections

| Fichier | Correction |
|---------|------------|
| `lib/google-reviews.ts` | Recuperation du vrai `placeId` depuis `metadata.placeId`, utilisation de `averageRating` de Google |
| `lib/cache.ts` | Detection de disponibilite KV, warnings explicites si fallback memoire |
| `api/google/auth/callback.ts` | Encodage UTF-8 correct, pas de caracteres speciaux |
| `api/cron/sync-reviews.ts` | Auth via `x-vercel-cron-job-id` OU `?secret=CRON_SECRET` |
| `README.md` | Instructions detaillees, mise en garde sur Origines JS vides |

## Prochaines etapes

Une fois le backend deploye et le refresh_token configure:

1. **Fournir l'URL du backend** (ex: `https://arcane-reviews.vercel.app`)
2. **Modification de GoogleRatingBadge.tsx** pour consommer l'endpoint
3. (Optionnel) Creation d'une Edge Function Supabase pour backup des donnees

