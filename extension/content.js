// Keenshield content script. Runs on every page and reports only what the
// shield number needs. It never changes the page, never reads what the person
// types, and only includes page text on decision pages.

// Must match the server's decision-moment test (netlify/functions/site-score.ts).
const DECISION_PATTERN = /\b(i agree|i accept|agree to (the|our|these)|by (clicking|signing up|continuing|creating an account|placing)|auto-?renew(s|al)?|automatically renew|renews automatically|free trial|cancel any ?time|recurring (charge|payment|billing)|place (your )?order|complete (your )?(purchase|order)|pay now|card number|cvv|cvc|billing address|security deposit|wire transfer|gift cards?|pay (with|in) (bitcoin|crypto)|zelle|social security|lease (term|agreement)|rental application|non-?refundable|arbitration)\b/i;
const DECISION_PATH_PATTERN = /\/(terms|tos|legal|eula|checkout|cart|basket|signup|sign-up|register|subscribe|subscription|billing|payment|pay|order|apply|lease|rental)(\/|$|[-_.])/i;
const MAX_TEXT_CHARS = 8000;

function visibleText() {
  return (document.body?.innerText || "").slice(0, MAX_TEXT_CHARS);
}

// Presence only — never a field's value.
function pageSignals() {
  const passwordField = !!document.querySelector("input[type='password']");
  const paymentField = !!document.querySelector(
    "input[autocomplete^='cc-'], input[name*='cardnumber' i], input[id*='cardnumber' i], iframe[src*='stripe'], iframe[src*='braintree'], iframe[src*='adyen']"
  );
  const agreeCheckbox = [...document.querySelectorAll("input[type='checkbox']")].some((box) => {
    const label = box.closest("label")?.innerText
      || (box.id && document.querySelector(`label[for='${CSS.escape(box.id)}']`)?.innerText)
      || "";
    return /agree|terms|consent|authorize/i.test(label);
  });
  return { passwordField, paymentField, agreeCheckbox };
}

function collectPage() {
  const signals = pageSignals();
  const text = visibleText();
  const isDecision = signals.paymentField || signals.agreeCheckbox
    || DECISION_PATH_PATTERN.test(location.pathname)
    || DECISION_PATTERN.test(`${document.title}\n${text}`);

  return {
    url: location.href,
    title: document.title,
    // Ordinary pages send no text at all.
    text: isDecision ? text : "",
    signals
  };
}

let lastReported = "";

function report() {
  if (location.href === lastReported) return;
  lastReported = location.href;
  chrome.runtime.sendMessage({ type: "keenshield:page", page: collectPage() }).catch(() => {});
}

report();

// Single-page apps (Facebook, Amazon…) change pages without reloading.
// Re-check the address every couple of seconds; reporting is skipped unless it changed.
setInterval(report, 2000);

// The popup's "Full breakdown" asks for the page text explicitly, because the
// person clicked for it.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "keenshield:get-text") {
    sendResponse({ url: location.href, title: document.title, text: visibleText() });
  }
});
