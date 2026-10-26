// Where the extension sends pages to be scored. No secrets belong in this
// file — it ships to every user. The server recognizes this extension by its
// Chrome extension ID instead (KEENSHIELD_EXTENSION_IDS in Netlify).
export const CONFIG = {
  SITE: "https://keenshield.app",
  SCORE_ENDPOINT: "https://keenshield.app/api/site-score",
  DEEP_SCAN_ENDPOINT: "https://keenshield.app/.netlify/functions/keenshield-scan",
  PRICING_URL: "https://keenshield.app/#pricing",
  MAX_TEXT_CHARS: 8000
};
