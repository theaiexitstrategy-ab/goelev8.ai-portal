# Google Analytics GA4 Live Data Setup

The portal Analytics tab pulls live metrics from your GA4 property via the
Google Analytics Data API. To enable it, configure two environment
variables in Vercel.

## Required env vars

| Var | Description |
|---|---|
| `GA4_PROPERTY_ID` | Numeric property ID (e.g. `123456789`) — found in GA4 Admin → Property Settings |
| `GA4_SERVICE_ACCOUNT_JSON` | Full service account key JSON, pasted as a single line |

## Setup steps

1. **Enable the Google Analytics Data API**
   - Go to https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com
   - Click **Enable**

2. **Create a service account**
   - https://console.cloud.google.com/iam-admin/serviceaccounts
   - Click **Create Service Account**
   - Name it `goelev8-ga4-reader`
   - Skip role assignment, click **Done**
   - Open the new service account → **Keys** tab → **Add Key** → **Create new key** → **JSON**
   - A JSON file downloads — keep it safe

3. **Grant the service account access to your GA4 property**
   - Open https://analytics.google.com
   - Admin (gear icon, bottom-left) → **Property Access Management**
   - Click **+** → **Add users**
   - Paste the service account email (looks like `goelev8-ga4-reader@your-project.iam.gserviceaccount.com`)
   - Role: **Viewer**
   - Click **Add**

4. **Find the property ID**
   - GA4 Admin → **Property Settings** → copy the **Property ID** (a 9-digit number, NOT the measurement ID like `G-07Y6KTRES2`)

5. **Add the env vars to Vercel**
   - Vercel project → Settings → Environment Variables
   - Add `GA4_PROPERTY_ID` = `123456789`
   - Add `GA4_SERVICE_ACCOUNT_JSON` = paste the entire JSON file content as a single line
   - Redeploy the project

## 6. Connect each tenant (this step is NOT an env var)

The two env vars above are **platform-wide**. `GA4_PROPERTY_ID` only backs
the admin's non-impersonated, platform-wide Analytics view.

Every tenant resolves its own property from `clients.ga4_property_id`
in Supabase — it **never** falls back to `GA4_PROPERTY_ID`. That's
deliberate: without it, a tenant with no property of their own would be
shown whatever the platform env points at and told it was their data.

So for each tenant:

1. Master Admin → the tenant → ⚙ Settings → **GA4 Property ID** → paste
   the numeric Property ID → Save. (The Analytics tab also offers an
   inline "Save & connect" box when the ID is missing.)
2. Add the service account email as a **Viewer** on *that tenant's* GA4
   property (step 3 above, repeated per property).

## Verifying

After redeploy, log in as `ab@goelev8.ai` and click the **Analytics** tab.
You should see live sessions, page views, top sources, top pages, and
custom event totals from your GA4 property.

The Analytics tab names whichever piece is missing:

| What it says | Where to fix it |
|---|---|
| No GA4 property is saved for *&lt;tenant&gt;* | `clients.ga4_property_id` — step 6 above. Env vars will not fix this. |
| No platform-wide GA4 property is set | `GA4_PROPERTY_ID` env var, then redeploy |
| The portal has no Google service account credentials | `GA4_SERVICE_ACCOUNT_JSON` env var, then redeploy |
| Service account not authorized on this GA4 property | Add the named service account as a Viewer on that property |
| That's a Measurement ID, not the Property ID | You saved `G-XXXXXXX`; use the all-digits Property ID |

If an env-var message persists after a redeploy, confirm the variable is
set for the **Production** environment and check the deployment logs.
