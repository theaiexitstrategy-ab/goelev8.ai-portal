# iSlay Studios — GoElev8 Portal Integration Guide

> **Client:** iSlay Studios LLC
> **Portal:** [portal.goelev8.ai](https://portal.goelev8.ai)
> **Slug:** `islay-studios`
> **Twilio Number:** +1 (833) 278-7529

---

## Part 8 — Wire islaystudiosllc.com Forms to GoElev8

### Step 1: Add Environment Variable

In the iSlay Studios repo (islaystudiosllc.com), add to `.env.local`:

```env
NEXT_PUBLIC_GOELEV8_SECRET=[GOELEV8_WEBHOOK_SECRET]
```

Replace `[GOELEV8_WEBHOOK_SECRET]` with the actual secret from the GoElev8 portal environment.

---

### Step 2: Add GoElev8 Embed Script

Add this to the `<head>` of every page in the iSlay Studios website (e.g., in `_app.tsx` or `layout.tsx`):

```html
<script>
  window.GoElev8 = {
    slug: "islay-studios",
    secret: process.env.NEXT_PUBLIC_GOELEV8_SECRET || "[GOELEV8_WEBHOOK_SECRET]"
  };
</script>
<script
  src="https://portal.goelev8.ai/embed/track.js"
  async>
</script>
```

> **Note:** The embed script automatically captures all `<form>` submissions on the page and sends name/phone/email fields to the GoElev8 portal. No additional code needed for basic form capture.

---

### Step 3: Wire Custom Forms (Optional — For Full Control)

For forms that need to send additional iSlay-specific data (genre, service interest, budget), POST directly to the GoElev8 lead endpoint:

```javascript
// Example: Custom form submission handler
async function submitInquiryForm(formData) {
  const response = await fetch('https://portal.goelev8.ai/api/webhooks/lead', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GoElev8-Secret': process.env.NEXT_PUBLIC_GOELEV8_SECRET
    },
    body: JSON.stringify({
      slug: 'islay-studios',
      name: formData.artistName,
      phone: formData.phone,
      email: formData.email,
      source: 'islaystudiosllc.com',
      funnel: window.location.pathname,
      metadata: {
        genre: formData.genre || null,
        service_interest: formData.serviceInterest || null,
        budget: formData.budget || null
      }
    })
  });

  if (response.ok) {
    // Redirect to thank-you page
    window.location.href = `https://www.islaystudiosllc.com/thank-you?name=${encodeURIComponent(formData.artistName)}&source=website`;
  }
}
```

**Required fields:**
| Field | Type | Description |
|-------|------|-------------|
| `slug` | string | Always `"islay-studios"` |
| `name` | string | Artist name |
| `phone` | string | Phone number (E.164 preferred) |
| `email` | string | Email address |
| `source` | string | e.g., `"islaystudiosllc.com"` |
| `funnel` | string | Page path, e.g., `"/booking"` |
| `metadata.genre` | string | R&B, Hip Hop, Gospel, etc. |
| `metadata.service_interest` | string | Recording, Mixing, Mastering, Full Production |
| `metadata.budget` | string | Budget range |

---

### Step 4: Form Submission Redirect

On successful form submission, redirect to:

```
https://www.islaystudiosllc.com/thank-you?name=[artist_name]&source=website
```

---

## Part 9 — Thank You Page

Build a `/thank-you` page on islaystudiosllc.com with the following design:

### Design Specs

- **Background:** Dark theme `#0a0a0a`
- **Accent colors:** Purple (`#a855f7`) and Gold (`#eab308`)
- **Aesthetic:** Music/studio vibe
- **Layout:** Mobile-first, centered content

### Page Structure

```jsx
// pages/thank-you.tsx (or app/thank-you/page.tsx)
import { useSearchParams } from 'next/navigation';

export default function ThankYou() {
  const params = useSearchParams();
  const name = params.get('name') || 'Artist';
  const source = params.get('source') || '';

  return (
    <div style={{
      background: '#0a0a0a',
      minHeight: '100vh',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: 'Inter, sans-serif'
    }}>
      {/* Section 1: Confirmation */}
      <h1 style={{ fontSize: '2.5rem', textAlign: 'center' }}>
        We Got You, {name}! 🎤
      </h1>
      <p style={{ color: '#a0a0a0', fontSize: '1.1rem', textAlign: 'center', maxWidth: '500px' }}>
        Someone from iSlay Studios will be in touch shortly to discuss your session.
      </p>

      {/* Section 2: What happens next */}
      <div style={{
        marginTop: '2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        maxWidth: '400px',
        width: '100%'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '1.5rem' }}>🎵</span>
          <span>Check your phone for a text</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '1.5rem' }}>📅</span>
          <span>We'll reach out to schedule your session</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '1.5rem' }}>🎙️</span>
          <span>Come ready to create</span>
        </div>
      </div>

      {/* Section 3: Social links */}
      <div style={{ marginTop: '3rem', textAlign: 'center' }}>
        <p style={{ color: '#666', fontSize: '0.9rem' }}>Follow iSlay Studios</p>
        {/* Add social media links here */}
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 'auto',
        paddingTop: '3rem',
        color: '#444',
        fontSize: '0.8rem'
      }}>
        Powered by <a href="https://goelev8.ai" style={{ color: '#a855f7' }}>GoElev8.AI</a>
      </div>
    </div>
  );
}
```

---

## Part 10 — SMS Behavior

When an artist submits an inquiry form on islaystudiosllc.com, the GoElev8 portal automatically:

1. **To the artist:** Sends welcome SMS via Twilio (+18332787529):
   > "Hey [name]! 🎤 Thanks for reaching out to iSlay Studios! We'll be in touch shortly to set up your session. Check us out: islaystudiosllc.com"

2. **To the iSlay Studios owner:** Sends notification SMS:
   > "New artist inquiry! Name: [name] Phone: [phone] Interest: [service] View in portal: portal.goelev8.ai"

SMS deduplication: No double texts to the same phone number within 24 hours.

To enable owner notifications, set `ISLAY_OWNER_PHONE` env var in the GoElev8 portal.

---

## Part 11 — Redirect portal.islaystudiosllc.com

In the `portal.islaystudiosllc.com` repo, replace the `vercel.json` with:

```json
{
  "redirects": [
    {
      "source": "/:path*",
      "destination": "https://portal.goelev8.ai/:path*",
      "permanent": true
    }
  ]
}
```

Deploy this to make all existing bookmarks and links to portal.islaystudiosllc.com automatically redirect to portal.goelev8.ai.

---

## Testing Checklist

- [ ] Log in as islay-studios client at portal.goelev8.ai
- [ ] Dashboard shows artist pipeline with "Artist Conversions" label
- [ ] All 6 tabs render correctly (Dashboard, Sales, Calls, Messages, Analytics, Settings)
- [ ] Submit test form on islaystudiosllc.com → lead + artist inquiry appear in portal
- [ ] SMS sends to test phone (welcome + owner notification)
- [ ] Book Session modal works → studio_bookings record + SMS confirmation
- [ ] Calls tab shows artist names for matching phone numbers
- [ ] Messages tab shows artist names for matching phone numbers
- [ ] Redirect from portal.islaystudiosllc.com → portal.goelev8.ai works

---

*© 2026 GoElev8.ai | Aaron Bryant. All rights reserved.*
