// The panel that opens when the shield is clicked: the score, why, and an
// optional full breakdown (the deep scan, which counts against free scans).

import { CONFIG } from "./config.js";
import { getInstallId } from "./install-id.js";

const $ = (id) => document.getElementById(id);

const HEADLINES = {
  green: "Looks normal",
  yellow: "Worth reading first",
  red: "High risk — take a close look"
};

function list(el, items) {
  el.replaceChildren(...items.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const stored = tab ? (await chrome.storage.session.get(`score-${tab.id}`))[`score-${tab.id}`] : null;

if (!stored) {
  $("empty").hidden = false;
} else {
  $("score-view").hidden = false;
  $("score").textContent = String(stored.score);
  $("score").dataset.level = stored.level;
  $("headline").textContent = HEADLINES[stored.level] || "";
  try {
    $("address").textContent = new URL(stored.url).hostname;
  } catch {
    $("address").textContent = "";
  }
  list($("reasons"), stored.reasons?.length ? stored.reasons : [stored.topReason]);
  $("summary").textContent = stored.reasons?.length ? stored.summary : "";
}

$("deep-button")?.addEventListener("click", async () => {
  const button = $("deep-button");
  button.disabled = true;
  $("deep-view").hidden = false;
  $("deep-status").textContent = "Reading the whole page…";

  try {
    const page = await chrome.tabs.sendMessage(tab.id, { type: "keenshield:get-text" });
    const res = await fetch(CONFIG.DEEP_SCAN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...page, installId: await getInstallId() })
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 402) {
      $("deep-status").textContent = `You've used your ${data.scansUsed ?? 5} free full breakdowns. Pro gives you unlimited.`;
      $("upgrade").hidden = false;
      $("upgrade").href = CONFIG.PRICING_URL;
      return;
    }
    if (!res.ok) {
      $("deep-status").textContent = res.status === 429
        ? "Too many scans for now — try again in a little while."
        : "Couldn't run the full breakdown right now.";
      return;
    }

    $("deep-status").textContent = "Full breakdown";
    list($("deep-flags"), data.flags || []);
    $("deep-summary").textContent = data.summary || "";
  } catch {
    $("deep-status").textContent = "Couldn't read this page. Try reloading it.";
  } finally {
    button.disabled = false;
  }
});
