const form = document.querySelector("#scan-form");
const pageUrl = document.querySelector("#url");
const pageText = document.querySelector("#text");
const characterCount = document.querySelector("#character-count");
const formError = document.querySelector("#form-error");
const loadingPanel = document.querySelector("#loading");
const resultPanel = document.querySelector("#result");
const riskBadge = document.querySelector("#risk-badge");
const resultTitle = document.querySelector("#result-title");
const resultSummary = document.querySelector("#result-summary");
const flagsWrap = document.querySelector("#flags-wrap");
const flagsList = document.querySelector("#flags");
const resetButton = document.querySelector("#reset-button");
const submitButton = form.querySelector("button[type='submit']");

const riskCopy = {
  green: { badge: "Clear", title: "Nothing concerning found" },
  yellow: { badge: "Worth knowing", title: "Pause and read this part" },
  red: { badge: "High concern", title: "Think twice before continuing" },
  unknown: { badge: "Unclear", title: "The scan needs another look" }
};

pageText.addEventListener("input", () => {
  characterCount.textContent = Math.min(pageText.value.length, 8000).toLocaleString();
});

pageUrl.addEventListener("blur", () => {
  pageUrl.value = normalizeHttpsUrl(pageUrl.value);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const text = String(formData.get("text") || "").trim();
  const url = normalizeHttpsUrl(formData.get("url"));

  pageUrl.value = url;

  formError.hidden = true;
  resultPanel.hidden = true;

  if (!text) {
    showError("Paste some page text before starting the scan.");
    pageText.focus();
    return;
  }

  setLoading(true);

  try {
    const response = await fetch("/.netlify/functions/keenshield-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        title: String(formData.get("title") || "").trim(),
        text
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The function's `error` strings are written for whoever is reading the
      // logs. Leave them there and show the visitor copy written for them.
      console.error("Keenshield scan failed:", response.status, data.error || "(no error field)");
      showError(scanErrorMessage(response.status, data));
      return;
    }

    showResult(data);
  } catch (error) {
    // Only network and parse failures reach here now. Their messages are
    // browser-generated ("Failed to fetch") and mean nothing to a visitor.
    console.error("Keenshield scan error:", error);
    showError("The scan could not be completed. Check your connection and try again.");
  } finally {
    setLoading(false);
  }
});

resetButton.addEventListener("click", () => {
  resultPanel.hidden = true;
  form.hidden = false;
  form.reset();
  characterCount.textContent = "0";
  pageText.focus();
});

function setLoading(isLoading) {
  loadingPanel.hidden = !isLoading;
  form.hidden = isLoading || !resultPanel.hidden;
  submitButton.disabled = isLoading;
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

// Errors are mapped by status code rather than by matching the response body's
// text. That body is phrased for an operator reading logs — "Server
// misconfigured", "Invalid JSON", "Unauthorized" — so none of it belongs on a
// public page: it is either meaningless to a visitor or it describes server
// internals. A status code also survives the backend rewording its payload,
// which an equality check against the string did not.
function scanErrorMessage(status, data) {
  if (status === 402) {
    const used = Number(data.scansUsed);
    return Number.isFinite(used) && used > 0
      ? `That is all ${used} free scans for this install.`
      : "No free scans remain for this install.";
  }

  if (status === 429) {
    return "Too many scans in a row. Wait a moment, then try again.";
  }

  if (status === 413) {
    return "That page text is too long to scan. Try pasting a shorter section.";
  }

  if (status === 400) {
    return "That text could not be scanned. Paste the page copy and try again.";
  }

  if (status === 401) {
    return "This scanner is not accepting requests from here.";
  }

  // 500 (which includes the missing API key), 502, and anything unforeseen. A
  // visitor can act on none of them, and the real reason is in the console and
  // the function logs for whoever can.
  return "The scanner is temporarily unavailable. Please try again shortly.";
}

function showResult(data) {
  const riskLevel = Object.hasOwn(riskCopy, data.risk_level) ? data.risk_level : "unknown";
  const copy = riskCopy[riskLevel];

  riskBadge.className = `risk-badge risk-${riskLevel}`;
  riskBadge.textContent = copy.badge;
  resultTitle.textContent = copy.title;
  resultSummary.textContent = data.summary || "No summary was returned.";
  flagsList.replaceChildren();

  const flags = Array.isArray(data.flags) ? data.flags : [];
  flags.forEach((flag) => {
    const item = document.createElement("li");
    item.textContent = flag;
    flagsList.append(item);
  });

  flagsWrap.hidden = flags.length === 0;
  form.hidden = true;
  resultPanel.hidden = false;
}

function normalizeHttpsUrl(value) {
  const url = String(value || "").trim();

  if (!url) return "";
  if (/^http:\/\//i.test(url)) return url.replace(/^http:\/\//i, "https://");
  if (!/^https:\/\//i.test(url)) return `https://${url}`;

  return url;
}
