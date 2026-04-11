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

## Verifying

After redeploy, log in as `ab@goelev8.ai` and click the **Analytics** tab.
You should see live sessions, page views, top sources, top pages, and
custom event totals from your GA4 property.

If you see "GA4 Not Configured", the env vars weren't picked up — check
the Vercel deployment logs and confirm the variables are set for the
production environment.
