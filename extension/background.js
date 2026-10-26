// Keenshield background worker. Fetches the score for each page and puts the
// number on the shield. Nothing is ever blocked, and nothing pops up — the
// reasons only appear when the person clicks the shield.

import { CONFIG } from "./config.js";

const BADGE_COLORS = { green: "#49775c", yellow: "#c08b31", red: "#ad493e" };

// ── The shield number ─────────────────────────────────────────
async function clearShield(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  await chrome.storage.session.remove(`score-${tabId}`);
}

async function updateShield(tabId, page) {
  try {
    const res = await fetch(CONFIG.SCORE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page)
    });

    // 401/429/5xx: no number rather than a wrong one.
    if (!res.ok) return clearShield(tabId);

    const result = await res.json();
    await chrome.action.setBadgeText({ tabId, text: String(result.score) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[result.level] || BADGE_COLORS.yellow });
    await chrome.action.setBadgeTextColor?.({ tabId, color: "#faf7ee" });
    await chrome.action.setTitle({ tabId, title: `Keenshield: ${result.score} — click to see why` });
    await chrome.storage.session.set({ [`score-${tabId}`]: { ...result, url: page.url } });
  } catch (err) {
    console.error("Keenshield score failed:", err);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "keenshield:page" && sender.tab?.id) {
    updateShield(sender.tab.id, message.page);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`score-${tabId}`);
});
