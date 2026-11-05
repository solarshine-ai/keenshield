// Keenshield's website scanner: one text box, an optional photo, one Scan
// button, and a plain-language result.
//
// The website gives 3 free scans, counted on the server per signed-in account
// or, for signed-out visitors, per browser (the random ID below). After that a
// scan needs Pro or a $1.99 scan credit. account.js keeps
// window.keenshieldAccount up to date and announces changes.

const form = document.querySelector("#scan-form");
const pageText = document.querySelector("#text");
const characterCount = document.querySelector("#character-count");
const characterLimit = document.querySelector("#character-limit");
const characterUpsell = document.querySelector("#character-upsell");
const scanAllowance = document.querySelector("#scan-allowance");
const formError = document.querySelector("#form-error");
const loadingPanel = document.querySelector("#loading");
const resultPanel = document.querySelector("#result");
const riskBadge = document.querySelector("#risk-badge");
const resultTitle = document.querySelector("#result-title");
const resultSummary = document.querySelector("#result-summary");
const flagsWrap = document.querySelector("#flags-wrap");
const flagsList = document.querySelector("#flags");
const scanNote = document.querySelector("#scan-note");
const resetButton = document.querySelector("#reset-button");
const submitButton = form.querySelector("button[type='submit']");
const cameraButton = document.querySelector("#camera-button");
const uploadButton = document.querySelector("#upload-button");
const cameraInput = document.querySelector("#camera-input");
const uploadInput = document.querySelector("#upload-input");
const photoStatus = document.querySelector("#photo-status");
const photoPreview = document.querySelector("#photo-preview");
const photoThumb = document.querySelector("#photo-thumb");
const photoMeta = document.querySelector("#photo-meta");
const photoRemove = document.querySelector("#photo-remove");

const SCAN_ENDPOINT = "/.netlify/functions/keenshield-scan";

// A free scan reads up to 8,000 characters. Pro and a $1.99 scan credit read
// a whole lease or contract. These match the server's limits.
const FREE_TEXT_LIMIT = 8000;
const FULL_TEXT_LIMIT = 60000;

// The Stripe links the "out of free scans" message points at. The same links
// are on the pricing cards; account.js handles any a[data-checkout] click.
const SINGLE_SCAN_URL = "https://buy.stripe.com/8x214g8Ay7ZY0dCcD03AY01";
const PRO_YEARLY_URL = "https://buy.stripe.com/5kQfZa6sqbca7G432q3AY07";

// Photos are resized in the browser before upload. 1,568px on the long edge
// is the largest size the model gains any detail from, and shrinking a 12MP
// phone photo to it turns a ~4MB upload into a few hundred kilobytes — which
// matters most on the mobile connection the camera button is there for.
const MAX_IMAGE_EDGE = 1568;
const IMAGE_QUALITY = 0.82;

// Guard on the file the user picks, before it is decoded. A photo this large is
// either not a photo or will not survive being decoded on a phone anyway.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

// The prepared photo, as base64 ready for the scan request, or null.
let selectedImage = null;

// What the server last said about free scans: { free_scans, free_scans_left, unlimited }.
let allowance = null;

const riskCopy = {
  green: { badge: "Clear", title: "Nothing concerning found" },
  yellow: { badge: "Worth knowing", title: "Fine to use, but know this first" },
  red: { badge: "High concern", title: "Think twice before continuing" },
  unknown: { badge: "Unclear", title: "The scan needs another look" }
};

// ── Free scans ──────────────────────────────────────────────
// A random ID kept in this browser, so signed-out visitors get their 3 free
// scans per browser. It identifies nothing else.
function browserId() {
  const KEY = "keenshield-browser-id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Storage blocked: the server falls back to counting by network address.
    return "";
  }
}

function accountState() {
  return window.keenshieldAccount || { user: null, account: null };
}

function scanCredits() {
  const { account } = accountState();
  return account ? Number(account.scanCredits) || 0 : 0;
}

function hasPro() {
  const { account } = accountState();
  return Boolean((account && account.plan) || (allowance && allowance.unlimited));
}

function freeScansLeft() {
  return allowance ? Number(allowance.free_scans_left) || 0 : null;
}

// The next scan reads the full length when it's covered by Pro or by a
// credit (free scans used up and a credit to spend).
function nextScanIsFull() {
  return hasPro() || (freeScansLeft() === 0 && scanCredits() > 0);
}

function textLimit() {
  return nextScanIsFull() ? FULL_TEXT_LIMIT : FREE_TEXT_LIMIT;
}

function updateCharacterCount() {
  const limit = textLimit();
  characterLimit.textContent = limit.toLocaleString();
  characterUpsell.hidden = limit === FULL_TEXT_LIMIT;
  characterCount.textContent = Math.min(pageText.value.length, limit).toLocaleString();
}

function renderAllowance() {
  updateCharacterCount();
  const left = freeScansLeft();
  scanAllowance.replaceChildren();
  scanAllowance.dataset.tone = "ok";

  if (hasPro()) {
    scanAllowance.append("Pro: unlimited scans, up to 60,000 characters each.");
  } else if (left === null) {
    scanAllowance.hidden = true;
    return;
  } else if (left > 0) {
    scanAllowance.append(`${left} of ${allowance.free_scans} free scans left.`);
  } else if (scanCredits() > 0) {
    const n = scanCredits();
    scanAllowance.append(`This scan uses 1 of your ${n} scan credit${n === 1 ? "" : "s"}.`);
  } else {
    scanAllowance.dataset.tone = "warn";
    scanAllowance.append(outOfFreeScansMessage());
  }
  scanAllowance.hidden = false;
}

// "You've used your 3 free scans. Get one more scan for $1.99 or go Pro for unlimited."
function outOfFreeScansMessage() {
  const total = (allowance && allowance.free_scans) || 3;
  const fragment = document.createDocumentFragment();

  const single = document.createElement("a");
  single.href = SINGLE_SCAN_URL;
  single.dataset.checkout = "document";
  single.textContent = "Get one more scan for $1.99";

  const pro = document.createElement("a");
  pro.href = PRO_YEARLY_URL;
  pro.dataset.checkout = "pro";
  pro.textContent = "go Pro for unlimited";

  fragment.append(`You've used your ${total} free scans. `, single, " or ", pro, ".");
  return fragment;
}

async function refreshAllowance() {
  try {
    const response = await fetch(SCAN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "allowance", browserId: browserId() })
    });
    if (response.ok) allowance = await response.json();
  } catch {
    // Not knowing the count only hides the note; the server still decides.
  }
  renderAllowance();
}

pageText.addEventListener("input", updateCharacterCount);
// Signing in or out changes whose free scans count, and buying changes credits.
window.addEventListener("keenshield:account", refreshAllowance);
refreshAllowance();

cameraButton.addEventListener("click", () => cameraInput.click());
uploadButton.addEventListener("click", () => uploadInput.click());

[cameraInput, uploadInput].forEach((input) => {
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    // Resetting the input's value lets the same file be picked twice in a row;
    // without it the second `change` event never fires.
    input.value = "";
    if (file) await attachPhoto(file);
  });
});

photoRemove.addEventListener("click", clearPhoto);

async function attachPhoto(file) {
  formError.hidden = true;

  if (!file.type.startsWith("image/")) {
    showError("That file is not an image. Take a photo or choose a picture instead.");
    return;
  }

  if (file.size > MAX_SOURCE_BYTES) {
    showError("That image is too large to scan. Try taking the photo again.");
    return;
  }

  setPhotoStatus("Preparing photo…");

  try {
    const prepared = await prepareImage(file);
    selectedImage = { data: prepared.data, mediaType: prepared.mediaType };

    photoThumb.src = prepared.dataUrl;
    photoMeta.textContent = `${prepared.width} × ${prepared.height} · ${formatBytes(prepared.byteLength)} ready to scan`;
    photoPreview.hidden = false;
    setPhotoStatus("");
  } catch (error) {
    console.error("Keenshield photo error:", error);
    clearPhoto();
    showError("That photo could not be read. Try taking it again.");
  }
}

function clearPhoto() {
  selectedImage = null;
  photoPreview.hidden = true;
  photoThumb.removeAttribute("src");
  photoMeta.textContent = "";
  setPhotoStatus("");
}

function setPhotoStatus(message) {
  photoStatus.textContent = message;
  photoStatus.hidden = !message;
}

// Decode, downscale, and re-encode as JPEG. The canvas round-trip is also what
// strips the photo's EXIF metadata — location included — so none of it is sent
// to the server.
async function prepareImage(file) {
  const source = await decodeImage(file);
  const sourceWidth = source.naturalWidth || source.width;
  const sourceHeight = source.naturalHeight || source.height;

  if (!sourceWidth || !sourceHeight) throw new Error("Image has no dimensions");

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  // Photographed text is the whole point here, so bias the resampler toward
  // keeping small glyphs legible.
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);

  if (typeof source.close === "function") source.close();

  const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);

  return {
    dataUrl,
    data,
    mediaType: "image/jpeg",
    width,
    height,
    // base64 carries 3 bytes in every 4 characters.
    byteLength: Math.floor((data.length * 3) / 4)
  };
}

async function decodeImage(file) {
  // `imageOrientation: "from-image"` applies the EXIF rotation a phone camera
  // records, so a portrait photo is not analyzed sideways.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Older Safari either lacks the options argument or the function itself.
      // The <img> path below honours EXIF orientation on its own there.
    }
  }

  return await new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Image could not be decoded"));
    };

    image.src = objectUrl;
  });
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = pageText.value.trim();

  formError.hidden = true;
  resultPanel.hidden = true;

  if (!text && !selectedImage) {
    showError("Paste some text or add a photo first.");
    pageText.focus();
    return;
  }

  setLoading(true);

  try {
    const response = await fetch(SCAN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        text,
        browserId: browserId(),
        ...(selectedImage ? { image: selectedImage } : {})
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The function's `error` strings are written for whoever is reading the
      // logs. Leave them there and show the visitor copy written for them.
      console.error("Keenshield scan failed:", response.status, data.error || "(no error field)");
      if (data && data.code === "free-scans-used") {
        allowance = { ...(allowance || {}), free_scans: data.freeScans || 3, free_scans_left: 0 };
        renderAllowance();
        showError(outOfFreeScansMessage());
      } else {
        showError(scanErrorMessage(response.status, data));
      }
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
  // `form.reset()` does not reach the photo: it lives outside the form's own
  // fields, in module state and the preview.
  clearPhoto();
  renderAllowance();
  pageText.focus();
});

function setLoading(isLoading) {
  loadingPanel.hidden = !isLoading;
  form.hidden = isLoading || !resultPanel.hidden;
  submitButton.disabled = isLoading;
}

// Takes a string or a node (the out-of-free-scans message carries links).
function showError(message) {
  formError.replaceChildren(message);
  formError.hidden = false;
}

// Errors are mapped by status code rather than by matching the response body's
// text. That body is phrased for an operator reading logs — "Server
// misconfigured", "Invalid JSON", "Unauthorized" — so none of it belongs on a
// public page: it is either meaningless to a visitor or it describes server
// internals. A status code also survives the backend rewording its payload,
// which an equality check against the string did not.
function scanErrorMessage(status, data) {
  if (status === 503) {
    return "Your account couldn't be checked just now, so nothing was charged. Please try again shortly.";
  }

  if (status === 402) {
    const used = Number(data.scansUsed);
    return Number.isFinite(used) && used > 0
      ? `You've used all ${used} free scans.`
      : "No free scans remain.";
  }

  if (status === 429) {
    return "Too many scans in a row. Wait a moment, then try again.";
  }

  if (status === 413) {
    return "That text or photo is too large to scan. Try a shorter section or a new photo.";
  }

  if (status === 415) {
    return "That image format is not supported. Take the photo again or choose a JPEG or PNG.";
  }

  if (status === 400) {
    return "That could not be scanned. Paste the text or add a photo and try again.";
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

  // A short line on how the scan was covered and what's left.
  const notes = [];
  if (data.access === "free" && Number.isFinite(data.free_scans_left)) {
    const left = data.free_scans_left;
    notes.push(left > 0 ? `${left} free scan${left === 1 ? "" : "s"} left.` : "That was your last free scan.");
  }
  if (data.access === "credit" && Number.isFinite(data.credits_remaining)) {
    notes.push(`1 scan credit used. ${data.credits_remaining} left.`);
    // Keep the account panel in step without a refetch.
    const state = accountState();
    if (state.account) state.account.scanCredits = data.credits_remaining;
  }
  if (Number.isFinite(data.text_truncated_at)) {
    notes.push(`Only the first ${data.text_truncated_at.toLocaleString()} characters were read. Pro or a $1.99 scan reads up to 60,000.`);
  }
  scanNote.textContent = notes.join(" ");
  scanNote.hidden = notes.length === 0;

  form.hidden = true;
  resultPanel.hidden = false;

  // The server has the real count; pick it up for the next scan. This also
  // tells account.js about a spent credit.
  if (data.access === "credit") {
    window.dispatchEvent(new CustomEvent("keenshield:account", { detail: accountState() }));
  } else {
    refreshAllowance();
  }
}
