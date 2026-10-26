# Extension change: the shield number

The backend now has a dedicated endpoint for the number on the shield icon:
`POST https://keenshield.app/api/site-score`. A complete extension that uses it
is in [`extension/`](../extension). Start there. This document explains what
that extension does, for anyone adapting an older version instead.

The rules the extension must follow — they are what the website's privacy
section promises users:

- **Never block a page and never pop anything up.** The only thing the
  extension changes is the number on its own toolbar icon. Reasons appear only
  when the person clicks the icon.
- **Only send page text on decision pages.** On ordinary pages, send the
  address alone. Text is sent only when the page asks the person to agree, pay,
  subscribe, sign up or hand over sensitive details.
- **Never read what the person types.** Form fields are only checked for
  whether they *exist* (is there a password box?), never for their values.

## What the endpoint expects

```json
{
  "url": "https://example.com/checkout",
  "title": "Checkout",
  "text": "visible page text — only on decision pages, max 8,000 characters",
  "signals": { "passwordField": true, "paymentField": false, "agreeCheckbox": true }
}
```

The extension in `extension/` is admitted by its Chrome extension ID: set
`KEENSHIELD_EXTENSION_IDS` in Netlify. Other callers send the
`x-keenshield-secret` header the deep scan already uses.
`text` and `signals` are optional. Without them, the server checks the
address only.

## What it returns

```json
{
  "score": 6,
  "level": "yellow",
  "topReason": "The free trial turns into a $14.99/month membership after 30 days.",
  "reasons": ["...", "..."],
  "summary": "1–2 plain-English sentences",
  "source": "fresh",
  "scoredAt": "2026-10-11T06:56:11.127Z"
}
```

- `score` is 1–10. `level` is `green` (1–3), `yellow` (4–6) or `red` (7–10).
- `source` says how the score was made:
  - `quick`: address checks only, no AI.
  - `cached`: someone already scored this page, so the result came back instantly.
  - `fresh`: just scored by AI.
- A `quick` response may also carry `limited: true` (this network used up its
  AI budget for the hour) or `degraded: true` (the AI was unavailable). The
  shield still gets a number either way.

Shield lookups do **not** use up the 5 free deep scans. The number is the free
product. The 5-scan limit still applies to the full deep scan
(`/.netlify/functions/keenshield-scan`).

Limits: 600 shield lookups per hour per network, of which at most 60 can be
fresh AI scores. Past the first limit the endpoint returns `429`. Leave the
badge blank in that case.

## 1. Content script: read the page without reading the person

```js
// content.js — runs on every page. Collects only what site-score needs.

// Must match the server's decision-moment test (netlify/functions/site-score.ts).
const DECISION_PATTERN = /\b(i agree|i accept|agree to (the|our|these)|by (clicking|signing up|continuing|creating an account|placing)|auto-?renew(s|al)?|automatically renew|renews automatically|free trial|cancel any ?time|recurring (charge|payment|billing)|place (your )?order|complete (your )?(purchase|order)|pay now|card number|cvv|cvc|billing address|security deposit|wire transfer|gift cards?|pay (with|in) (bitcoin|crypto)|zelle|social security|lease (term|agreement)|rental application|non-?refundable|arbitration)\b/i;
const DECISION_PATH_PATTERN = /\/(terms|tos|legal|eula|checkout|cart|basket|signup|sign-up|register|subscribe|subscription|billing|payment|pay|order|apply|lease|rental)(\/|$|[-_.])/i;

function pageSignals() {
  // Presence only — never .value.
  const passwordField = !!document.querySelector("input[type='password']");
  const paymentField = !!document.querySelector(
    "input[autocomplete^='cc-'], input[name*='card' i], input[id*='card' i], iframe[src*='stripe'], iframe[src*='braintree'], iframe[src*='adyen']"
  );
  const agreeCheckbox = [...document.querySelectorAll("input[type='checkbox']")].some((box) => {
    const label = box.closest("label")?.innerText || document.querySelector(`label[for='${box.id}']`)?.innerText || "";
    return /agree|terms|consent|authorize/i.test(label);
  });
  return { passwordField, paymentField, agreeCheckbox };
}

function collectPage() {
  const signals = pageSignals();
  const visibleText = (document.body?.innerText || "").slice(0, 8000);

  const isDecision = signals.paymentField || signals.agreeCheckbox
    || DECISION_PATH_PATTERN.test(location.pathname)
    || DECISION_PATTERN.test(`${document.title}\n${visibleText}`);

  return {
    url: location.href,
    title: document.title,
    // Ordinary pages send no text at all.
    text: isDecision ? visibleText : "",
    signals
  };
}

chrome.runtime.sendMessage({ type: "keenshield:page", page: collectPage() });
```

Sending the full `location.href` is fine. The server strips the query string
and fragment before using the address for anything shared.

## 2. Background: fetch the score and set the badge

```js
// background.js
const SCORE_ENDPOINT = "https://keenshield.app/api/site-score";
const BADGE_COLORS = { green: "#49775c", yellow: "#c08b31", red: "#ad493e" };

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "keenshield:page" || !sender.tab?.id) return;
  updateShield(sender.tab.id, message.page);
});

async function updateShield(tabId, page) {
  try {
    const res = await fetch(SCORE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-keenshield-secret": CONFIG.SHARED_SECRET,
      },
      body: JSON.stringify(page),
    });

    if (!res.ok) {
      // 401/429/5xx: no number rather than a wrong one.
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }

    const result = await res.json();
    await chrome.action.setBadgeText({ tabId, text: String(result.score) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[result.level] });

    // The popup reads this when the shield is clicked.
    await chrome.storage.session.set({ [`score-${tabId}`]: { ...result, url: page.url } });
  } catch (err) {
    console.error("Keenshield score failed:", err);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`score-${tabId}`));
```

Single-page apps (Facebook, Amazon) change pages without reloading. Re-run
`collectPage()` from the content script when `location.href` changes, for
example on a `popstate` listener or a light `setInterval` comparing the URL.
Don't re-score the same URL twice in one tab.

## 3. Popup: the reasons, only on click

The popup (`action.default_popup`) is the only place reasons appear. Read
`score-<tabId>` from `chrome.storage.session` for the active tab and show:

- the score and its color,
- `reasons` as a list (or `topReason` if the list is empty),
- `summary`,
- a **Full breakdown** button that runs the existing deep scan for this page.
  When that returns `402`, link to `https://keenshield.app/#pricing`.

No `chrome.notifications`, no injected banners or overlays. That's the product
promise.

## Manifest notes

- `"permissions": ["storage", "activeTab"]` plus host access to all sites, so
  the content script can run everywhere. The Chrome Web Store will ask why.
  Use the plain wording from the website's privacy section: the address is
  checked on every page, text only on decision pages, and nothing is blocked.
- `chrome.storage.session` needs Manifest V3.
