# GoElev8.ai Portal — Setup

Production multi-tenant SMS portal. Five steps to go live.

## ⚠️ Step 0 — Rotate exposed credentials

The Supabase service role key, Stripe secret key, and Twilio auth token were exposed in chat. Before going live:
- **Stripe** → Developers → API keys → Roll secret key
- **Twilio** → Account → API keys & tokens → Rotate auth token
- **Supabase** → Project Settings → API → Reset service role key

Use the new values in Step 2.

## Step 1 — Provision the Supabase schema

1. Go to https://supabase.com/dashboard → your GoElev8 project → **SQL Editor**
2. Open `supabase/migrations/0001_init.sql` from this repo
3. Paste it into the SQL editor and click **Run**
4. Then do the same with `supabase/migrations/0002_twilio_subaccounts.sql`

This creates all tables, RLS policies, helper functions, and triggers, plus the per-client Twilio subaccount auth-token column.

## Step 2 — Add environment variables

Copy `.env.example` to `.env.local` and fill in. Then add the **same** variables to **Vercel → Project → Settings → Environment Variables** (Production scope):

```
SUPABASE_URL                   https://bnkoqybkmwtrlorhowyv.supabase.co
SUPABASE_ANON_KEY              <rotated anon key>
SUPABASE_SERVICE_ROLE_KEY      <rotated service role key>
STRIPE_SECRET_KEY              <rotated sk_live_...>
STRIPE_PUBLISHABLE_KEY         <pk_live_...>
STRIPE_WEBHOOK_SECRET          (filled in Step 3)
STRIPE_CONNECT_CLIENT_ID       (from https://dashboard.stripe.com/settings/connect — "ca_..." )
PLATFORM_FEE_BPS               290
TWILIO_ACCOUNT_SID             <rotated SID>
TWILIO_AUTH_TOKEN              <rotated token>
TWILIO_COST_PER_SEGMENT_CENTS  1
ANTHROPIC_API_KEY              (optional — enables AI reply suggestions; falls back to canned suggestions if absent)
PORTAL_BASE_URL                https://portal.goelev8.ai
```

> **Activate Stripe Connect** if not already: https://dashboard.stripe.com/connect/accounts/overview → Get Started → fill out platform profile. Then grab `STRIPE_CONNECT_CLIENT_ID` from settings.

## Step 3 — Install deps and run setup scripts

```bash
npm install
node scripts/setup-stripe.mjs    # creates webhook → prints STRIPE_WEBHOOK_SECRET
```

Take the `STRIPE_WEBHOOK_SECRET` value it prints and put it in **both** `.env.local` and Vercel env vars (then redeploy or it won't be picked up).

```bash
node scripts/setup-twilio.mjs    # points both numbers' webhooks at portal.goelev8.ai
node scripts/onboard-client.mjs --preset flex-facility
node scripts/onboard-client.mjs --preset islay-studios
```

## Step 4 — Deploy

```bash
git push -u origin claude/multi-tenant-portal-Nik0D
```

Open the PR in GitHub, merge to `main`, Vercel auto-deploys.

## Step 5 — Smoke test

Visit https://portal.goelev8.ai and log in with:

| Client | Email | Password |
|---|---|---|
| The Flex Facility | ab@theflexfacility.com | Flex123!!! |
| The Flex Facility | kenny@theflexfacility.com | Flex123!!! |
| iSlay Studios | ab@islaystudiosllc.com | iSlay123!!! |
| iSlay Studios | nate@islaystudiosllc.com | iSlay123!!! |

Each client should see only their own data (RLS-enforced).

Test flow:
1. Buy a Starter pack (use a Stripe test mode card if running in test, or a real card for live).
2. Add a contact.
3. Send an SMS — credit balance should decrement by the segment count.
4. Reply from your phone to the Twilio number — it appears in the inbox.
5. Reply STOP — contact is auto-marked opted_out.

---

## Architecture

- **Frontend:** vanilla JS SPA in `index.html` + `app.js` + `styles.css`
- **API:** Vercel serverless functions in `api/`
- **Auth:** Supabase Auth (email/password) — JWT passed in `Authorization: Bearer` header
- **Tenancy:** every per-tenant table has `client_id`. RLS policies use `current_client_id()` (looks up the user → client_users → client_id) so each client can only read/write their own rows. Webhooks bypass RLS via the service-role key.
- **Credits:** prepaid via Stripe Checkout. Atomic deduction via `consume_credits` PG function before Twilio send (refunded if Twilio call fails).
- **Pricing:**
  - Starter: $25 → 250 credits ($0.10/SMS)
  - Growth: $50 → 625 credits ($0.08/SMS)
  - Pro: $100 → 2,000 credits ($0.05/SMS)
- **Auto-reload:** off-session PaymentIntent fired when balance crosses threshold; configured per client.
- **Stripe Connect:** Express accounts. Clients OAuth-onboard to accept payments from *their* customers via portal-generated payment links. GoElev8 takes 2.9% as `application_fee_amount`.
- **AI suggestions:** Claude Haiku 4.5 generates 3 short reply options per inbound message thread.

## Onboarding new clients

The `onboard-client.mjs` script handles **everything** end-to-end: Stripe customer, Twilio subaccount, phone number purchase, webhook wiring, Supabase auth users, and `client_users` mapping.

### Recommended: isolated Twilio subaccount (auto-purchase a number)

```bash
node scripts/onboard-client.mjs \
  --name "Acme Co" --slug acme \
  --email owner@acme.com --password "Acme123!!" \
  --subaccount --area-code 415
```

What this does:
1. Creates a Stripe customer
2. Creates a **Twilio subaccount** under your master account (isolated billing, isolated suspension, isolated number ownership)
3. Searches for an available US local number in the requested area code and **purchases it under the new subaccount** (charged to your Twilio balance)
4. Configures the new number's inbound (`/api/twilio/inbound`) and status callback (`/api/twilio/status`) webhooks
5. Stores the subaccount SID + auth token on the `clients` row so the messaging API automatically routes that tenant's outbound SMS through their own subaccount credentials
6. Creates the Supabase auth user(s) with the password you specified
7. Links the user(s) to the new client via `client_users`

### Variant: subaccount but transfer an existing number

```bash
node scripts/onboard-client.mjs \
  --name "Acme Co" --slug acme \
  --email owner@acme.com --password "Acme123!!" \
  --subaccount --transfer-number +14155551234
```

This moves a number you already own (currently in the parent account) into the new subaccount and re-points its webhooks.

### Legacy: parent-account number (no subaccount)

```bash
node scripts/onboard-client.mjs \
  --name "Acme Co" --slug acme \
  --email owner@acme.com --password "Acme123!!" \
  --phone +14155551234
```

(This is what the `flex-facility` and `islay-studios` presets use.)

### Multi-user clients

The `--email` flag accepts one address. To add additional users to the same client afterward, run the script again with the same `--slug` and a new `--email` — it will detect the existing client row and just attach the new user.

Or use the JS API directly (Supabase admin → `auth.admin.createUser` → insert `client_users` row pointing at the existing `client_id`).
