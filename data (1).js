/**
 * GoElev8.AI — API Proxy (DEMO MODE)
 * Returns hardcoded demo data — no Airtable required.
 * To go live: replace mock return with real Airtable fetch (see SETUP.md)
 */

const VALID_CLIENTS = ['daniels-legacy', 'islay-studios', 'flex-facility'];
const ALLOWED_TABLES = ['Leads', 'CRM', 'Stats', 'Recommendations'];

const MOCK = {
  "daniels-legacy": {
    Leads: [
      { Name: "Margaret Thompson", Email: "mthompson@email.com", Phone: "(555) 234-7891", Service: "Estate Planning Consultation", Date: "2025-03-08", Status: "booked", Source: "AI Voice" },
      { Name: "Robert Simmons", Email: "rsimmons@email.com", Phone: "(555) 345-6712", Service: "Will & Trust Review", Date: "2025-03-07", Status: "contacted", Source: "Web Form" },
      { Name: "Patricia Wells", Email: "pwells@email.com", Phone: "(555) 456-8923", Service: "Elder Care Planning", Date: "2025-03-06", Status: "new", Source: "AI Voice" },
      { Name: "James Harrington", Email: "jharrington@email.com", Phone: "(555) 567-2341", Service: "Estate Planning Consultation", Date: "2025-03-05", Status: "booked", Source: "Web Form" },
      { Name: "Sandra Mitchell", Email: "smitchell@email.com", Phone: "(555) 678-3452", Service: "Power of Attorney", Date: "2025-03-04", Status: "closed", Source: "AI Voice" },
      { Name: "David Kowalski", Email: "dkowalski@email.com", Phone: "(555) 789-4563", Service: "Trust Administration", Date: "2025-03-03", Status: "contacted", Source: "Web Form" },
      { Name: "Helen Foster", Email: "hfoster@email.com", Phone: "(555) 890-5674", Service: "Estate Planning Consultation", Date: "2025-03-01", Status: "closed", Source: "AI Voice" }
    ],
    CRM: [
      { Name: "Margaret Thompson", Email: "mthompson@email.com", Phone: "(555) 234-7891", Value: "$4,500", Stage: "Proposal Sent", LastContact: "2025-03-08", Notes: "Interested in full estate plan" },
      { Name: "James Harrington", Email: "jharrington@email.com", Phone: "(555) 567-2341", Value: "$6,200", Stage: "Negotiation", LastContact: "2025-03-05", Notes: "Complex multi-property estate" },
      { Name: "Sandra Mitchell", Email: "smitchell@email.com", Phone: "(555) 678-3452", Value: "$3,100", Stage: "Closed Won", LastContact: "2025-03-04", Notes: "POA + Basic will completed" },
      { Name: "Robert Simmons", Email: "rsimmons@email.com", Phone: "(555) 345-6712", Value: "$5,800", Stage: "Discovery", LastContact: "2025-03-07", Notes: "Reviewing existing trust documents" },
      { Name: "Helen Foster", Email: "hfoster@email.com", Phone: "(555) 890-5674", Value: "$2,900", Stage: "Closed Won", LastContact: "2025-03-01", Notes: "Simple will + healthcare directive" }
    ],
    Stats: [{ PageViews: 4821, PageViewsChange: 12.4, Appointments: 31, ResponseRate: 97, WeeklyViews: "[310,420,385,510,475,620,580]" }],
    Recommendations: [
      { Priority: "high", Icon: "🔥", Title: "6 Leads Need Follow-Up Within 24 Hours", Body: "3 AI voice leads from this week haven't been contacted yet. AI voice leads convert 40% higher when followed up within 2 hours. Activate SMS auto-follow-up sequence now." },
      { Priority: "medium", Icon: "📈", Title: "Tuesday & Wednesday Traffic Spikes — Double Down", Body: "Your page views peak on Tue/Wed between 10am–2pm. Consider scheduling any email campaigns or social posts Monday evening to capture this window." },
      { Priority: "medium", Icon: "💡", Title: "Estate Planning FAQ Page Could Cut Call Time 30%", Body: "Your AI voice assistant is answering the same 5 questions repeatedly. A FAQ landing page would pre-qualify leads and reduce consultation time." },
      { Priority: "low", Icon: "⭐", Title: "Review Request Campaign — 3 Recent Closed Clients", Body: "Sandra Mitchell and Helen Foster recently closed. An automated review request via SMS could generate Google reviews while experience is fresh." }
    ]
  },
  "islay-studios": {
    Leads: [
      { Name: "Aisha Coleman", Email: "acoleman@email.com", Phone: "(555) 112-3341", Service: "Wedding Photography", Date: "2025-03-09", Status: "new", Source: "AI Voice" },
      { Name: "Marcus Webb", Email: "mwebb@email.com", Phone: "(555) 223-4452", Service: "Brand Photoshoot", Date: "2025-03-08", Status: "booked", Source: "Web Form" },
      { Name: "Tiffany Nguyen", Email: "tnguyen@email.com", Phone: "(555) 334-5563", Service: "Headshots", Date: "2025-03-07", Status: "contacted", Source: "AI Voice" },
      { Name: "Carlos Rivera", Email: "crivera@email.com", Phone: "(555) 445-6674", Service: "Wedding Photography", Date: "2025-03-06", Status: "booked", Source: "Web Form" },
      { Name: "Jordan Patel", Email: "jpatel@email.com", Phone: "(555) 556-7785", Service: "Family Portraits", Date: "2025-03-04", Status: "closed", Source: "AI Voice" },
      { Name: "Brianna Scott", Email: "bscott@email.com", Phone: "(555) 667-8896", Service: "Brand Photoshoot", Date: "2025-03-02", Status: "new", Source: "Web Form" }
    ],
    CRM: [
      { Name: "Marcus Webb", Email: "mwebb@email.com", Phone: "(555) 223-4452", Value: "$2,800", Stage: "Booked", LastContact: "2025-03-08", Notes: "Full brand day shoot, April 15" },
      { Name: "Carlos Rivera", Email: "crivera@email.com", Phone: "(555) 445-6674", Value: "$5,500", Stage: "Deposit Paid", LastContact: "2025-03-06", Notes: "October wedding, 8 hours coverage" },
      { Name: "Jordan Patel", Email: "jpatel@email.com", Phone: "(555) 556-7785", Value: "$900", Stage: "Closed Won", LastContact: "2025-03-04", Notes: "Family mini session complete" },
      { Name: "Tiffany Nguyen", Email: "tnguyen@email.com", Phone: "(555) 334-5563", Value: "$450", Stage: "Proposal Sent", LastContact: "2025-03-07", Notes: "Executive headshots for LinkedIn" }
    ],
    Stats: [{ PageViews: 3247, PageViewsChange: 8.9, Appointments: 19, ResponseRate: 94, WeeklyViews: "[210,280,320,290,410,480,450]" }],
    Recommendations: [
      { Priority: "high", Icon: "🔥", Title: "8 New Leads This Week — Highest Month Yet", Body: "Wedding season inquiries are up 22.5%. Your AI is capturing after-hours leads competitors miss. Consider adding a 2025 availability page to pre-qualify dates before calls." },
      { Priority: "high", Icon: "📸", Title: "Brand Photoshoot Package Underpriced vs. Demand", Body: "Brand shoot inquiries are up 40% this month. At $2,800 you're booked solid — this is a signal to test a $3,500 premium tier with extended usage rights." },
      { Priority: "medium", Icon: "💡", Title: "Add Portfolio Gallery by Category to Boost Time-on-Site", Body: "Visitors who see relevant portfolio work convert 3x higher. Segmenting your gallery (Weddings / Brand / Portraits) could significantly improve lead quality." },
      { Priority: "low", Icon: "⭐", Title: "Jordan Patel Is a Referral Goldmine", Body: "Recent happy clients are your best source of word-of-mouth. A referral incentive could generate 2–3 warm leads per month." }
    ]
  },
  "flex-facility": {
    Leads: [
      { Name: "Devon Harris", Email: "dharris@email.com", Phone: "(555) 991-2231", Service: "Free Trial Class", Date: "2025-03-09", Status: "new", Source: "AI Voice" },
      { Name: "Keisha Brown", Email: "kbrown@email.com", Phone: "(555) 882-3342", Service: "Personal Training", Date: "2025-03-09", Status: "booked", Source: "Web Form" },
      { Name: "Tyler Johnson", Email: "tjohnson@email.com", Phone: "(555) 773-4453", Service: "Membership Inquiry", Date: "2025-03-08", Status: "contacted", Source: "AI Voice" },
      { Name: "Alexis Turner", Email: "aturner@email.com", Phone: "(555) 664-5564", Service: "Free Trial Class", Date: "2025-03-08", Status: "booked", Source: "Web Form" },
      { Name: "Marcus Green", Email: "mgreen@email.com", Phone: "(555) 555-6675", Service: "Personal Training", Date: "2025-03-07", Status: "booked", Source: "AI Voice" },
      { Name: "Nina Patel", Email: "npatel@email.com", Phone: "(555) 446-7786", Service: "Group Classes", Date: "2025-03-07", Status: "contacted", Source: "Web Form" },
      { Name: "Chris Wallace", Email: "cwallace@email.com", Phone: "(555) 337-8897", Service: "Membership Inquiry", Date: "2025-03-06", Status: "new", Source: "AI Voice" },
      { Name: "Serena Adams", Email: "sadams@email.com", Phone: "(555) 228-9908", Service: "Free Trial Class", Date: "2025-03-05", Status: "closed", Source: "Web Form" },
      { Name: "Brian Foster", Email: "bfoster@email.com", Phone: "(555) 119-1019", Service: "Personal Training", Date: "2025-03-04", Status: "closed", Source: "AI Voice" }
    ],
    CRM: [
      { Name: "Keisha Brown", Email: "kbrown@email.com", Phone: "(555) 882-3342", Value: "$3,600/yr", Stage: "Negotiation", LastContact: "2025-03-09", Notes: "Interested in annual PT package" },
      { Name: "Marcus Green", Email: "mgreen@email.com", Phone: "(555) 555-6675", Value: "$2,400/yr", Stage: "Booked", LastContact: "2025-03-07", Notes: "2x/week PT sessions starting March 15" },
      { Name: "Serena Adams", Email: "sadams@email.com", Phone: "(555) 228-9908", Value: "$1,200/yr", Stage: "Closed Won", LastContact: "2025-03-05", Notes: "Annual membership signed" },
      { Name: "Brian Foster", Email: "bfoster@email.com", Phone: "(555) 119-1019", Value: "$2,400/yr", Stage: "Closed Won", LastContact: "2025-03-04", Notes: "Monthly PT package, auto-renews" },
      { Name: "Alexis Turner", Email: "aturner@email.com", Phone: "(555) 664-5564", Value: "$1,200/yr", Stage: "Trial", LastContact: "2025-03-08", Notes: "Free trial attended, following up" },
      { Name: "Tyler Johnson", Email: "tjohnson@email.com", Phone: "(555) 773-4453", Value: "$1,200/yr", Stage: "Discovery", LastContact: "2025-03-08", Notes: "Comparing membership tiers" }
    ],
    Stats: [{ PageViews: 6104, PageViewsChange: 31.2, Appointments: 61, ResponseRate: 99, WeeklyViews: "[480,510,590,620,710,840,790]" }],
    Recommendations: [
      { Priority: "high", Icon: "🔥", Title: "14 New Leads This Week — Activate Nurture Sequence", Body: "You're at your highest lead volume yet. 5 leads are still in 'new' status. An automated 3-touch SMS sequence (Day 1, Day 3, Day 7) could convert 2–4 more per week on autopilot." },
      { Priority: "high", Icon: "💪", Title: "Free Trial → Member Conversion Is Your #1 Lever", Body: "Trial leads are converting at ~65%. Every 1% improvement = ~1 new member/month. Consider a post-trial same-day offer (10% off if they sign today) delivered via AI SMS." },
      { Priority: "medium", Icon: "📈", Title: "Weekend Traffic Is Up 31% — Add Saturday Booking Slot", Body: "Saturday page views have surged but you have limited Saturday availability. Opening 4 more weekend slots could capture 3–5 bookings/month you're currently losing." },
      { Priority: "medium", Icon: "🎯", Title: "Personal Training Upsell Opportunity on New Members", Body: "6 new annual members joined this quarter. A 30-day PT intro package offered at signup has an avg attach rate of 28% at comparable gyms. That's ~$1,700 in upsell revenue." },
      { Priority: "low", Icon: "⭐", Title: "Referral Program Could 2x Word-of-Mouth Growth", Body: "Serena Adams and Brian Foster are satisfied closed clients. A 'Refer a Friend' program (both get a free month) is low cost and high ROI at your current momentum." }
    ]
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, table } = req.query;

  if (!clientId || !VALID_CLIENTS.includes(clientId))
    return res.status(400).json({ error: 'Invalid clientId' });
  if (!table || !ALLOWED_TABLES.includes(table))
    return res.status(400).json({ error: 'Invalid table' });

  const records = (MOCK[clientId]?.[table] || []).map((r, i) => ({ id: `demo-${i}`, ...r }));

  res.setHeader('Cache-Control', 's-maxage=60');
  return res.status(200).json({ records, table, clientId, mode: 'demo' });
}
