/**
 * GoElev8.AI Portal — Client Auth Config
 * No API keys here — just login credentials + display info.
 * Real data fetched server-side via /api/data
 */
const CLIENTS = {
  "daniels-legacy": {
    id: "daniels-legacy",
    name: "Daniels Legacy Planning",
    industry: "Estate Planning / Legal",
    email: "client@danielslegacy.com",
    password: "dlp2024",
    avatar: "DL",
    color: "#00d4ff",
    aiTier: "Revenue Accelerator",
    onboardedDate: "2024-09-01"
  },
  "islay-studios": {
    id: "islay-studios",
    name: "iSlay Studios",
    industry: "Photography / Creative",
    email: "client@islaystudios.com",
    password: "islay2024",
    avatar: "IS",
    color: "#00e89a",
    aiTier: "Pipeline Builder",
    onboardedDate: "2024-10-15"
  },
  "flex-facility": {
    id: "flex-facility",
    name: "The Flex Facility",
    industry: "Fitness / Wellness",
    email: "client@theflexfacility.com",
    password: "flex2024",
    avatar: "FF",
    color: "#ff4757",
    aiTier: "Revenue Accelerator",
    onboardedDate: "2024-11-01"
  }
};

function authenticate(email, password) {
  return Object.values(CLIENTS).find(
    c => c.email === email && c.password === password
  ) || null;
}
