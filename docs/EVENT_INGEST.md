# Cross-project event ingestion

The GoElev8.AI portal (this Supabase project) receives events from
**The-AI-Exit-Strategy** Supabase project and from client websites in real
time. The two Supabase projects stay fully isolated — GoElev8.AI never reads
or writes to The-AI-Exit-Strategy. It only **receives** webhook POSTs.

## 1. Run the migration

Apply `supabase/migrations/0004_client_events.sql` against the GoElev8.AI
Supabase project (SQL editor → paste → Run). This creates `public.client_events`,
its RLS policies, and adds it to the `supabase_realtime` publication.

## 2. Set the shared secret

In **Vercel → goelev8.ai-portal → Settings → Environment Variables** add:

```
INGEST_WEBHOOK_SECRET=<long random string, e.g. openssl rand -hex 32>
```

Redeploy. Store the same secret in The-AI-Exit-Strategy project (Vault) and
on each client site.

## 3. Endpoint

```
POST https://portal.goelev8.ai/api/events?action=ingest
Content-Type: application/json
X-GoElev8-Signature: sha256=<hex HMAC-SHA256 of raw body using INGEST_WEBHOOK_SECRET>
```

Body:

```json
{
  "client_slug": "flex-facility",          // OR client_domain, OR derived from source host
  "source": "theflexfacility.com",
  "source_path": "/fit",
  "event_type": "form_submission",
  "external_id": "row-uuid-from-upstream",  // optional, dedupes
  "contact_name": "Jane Doe",
  "contact_email": "jane@example.com",
  "contact_phone": "+15551234567",
  "title": "New /fit signup",
  "payload": { "...arbitrary fields..." },
  "occurred_at": "2026-04-07T15:32:11Z"
}
```

Known domains auto-resolve to client slugs:

| Domain | Slug |
|---|---|
| theflexfacility.com | flex-facility |
| islaystudiosllc.com | islay-studios |

To onboard new clients, add them to `DOMAIN_TO_SLUG` in `api/events.js` or
send `client_slug` explicitly.

## 4. Wiring The-AI-Exit-Strategy → GoElev8.AI

### Option A — Supabase Database Webhooks (recommended for table inserts)

In **The-AI-Exit-Strategy** project:

1. Database → Webhooks → **Create a new hook**
2. Table: e.g. `flex_fit_signups`
3. Events: Insert (and Update if you want)
4. Type: HTTP Request
5. URL: `https://portal.goelev8.ai/api/events?action=ingest`
6. HTTP Headers:
   - `Content-Type: application/json`
   - `X-GoElev8-Signature: sha256=<computed by an Edge Function — see below>`
7. HTTP Params: leave default

Because Supabase database webhooks can't compute HMACs natively, route them
through a small Edge Function in The-AI-Exit-Strategy that:

1. Receives the webhook payload from the trigger.
2. Normalizes it into the body shape above (sets `client_slug`, `source`,
   `event_type`, etc.).
3. Computes `sha256=` HMAC of the JSON body using `INGEST_WEBHOOK_SECRET`
   (stored in Supabase Vault).
4. POSTs to `https://portal.goelev8.ai/api/events?action=ingest`.

Point each table's webhook at this single Edge Function (e.g.
`forward-to-goelev8`) and pass a `target_client_slug` query param so the
function knows which client to attribute the event to.

### Option B — Direct from client websites

Any client site (Webflow, Next.js, WordPress, etc.) can POST directly. Use a
serverless function on the client site so the secret never ships to browsers.

Node example:

```js
import crypto from 'node:crypto';
const body = JSON.stringify({
  client_slug: 'flex-facility',
  source: 'theflexfacility.com',
  source_path: '/r2s',
  event_type: 'lead',
  contact_email: req.body.email,
  contact_name: req.body.name,
  payload: req.body
});
const sig = 'sha256=' + crypto
  .createHmac('sha256', process.env.INGEST_WEBHOOK_SECRET)
  .update(body).digest('hex');
await fetch('https://portal.goelev8.ai/api/events?action=ingest', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-goelev8-signature': sig },
  body
});
```

## 5. Viewing in the portal

Sign in → **Activity** tab. Each client only sees their own events (RLS on
`client_id`). The list refreshes every 5 seconds. Click any row to expand
the full payload.
