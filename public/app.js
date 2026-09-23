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
const cameraButton = document.querySelector("#camera-button");
const uploadButton = document.querySelector("#upload-button");
const cameraInput = document.querySelector("#camera-input");
const uploadInput = document.querySelector("#upload-input");
const photoStatus = document.querySelector("#photo-status");
const photoPreview = document.querySelector("#photo-preview");
const photoThumb = document.querySelector("#photo-thumb");
const photoMeta = document.querySelector("#photo-meta");
const photoRemove = document.querySelector("#photo-remove");

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
  const formData = new FormData(form);
  const text = String(formData.get("text") || "").trim();
  const url = normalizeHttpsUrl(formData.get("url"));

  pageUrl.value = url;

  formError.hidden = true;
  resultPanel.hidden = true;

  if (!text && !selectedImage) {
    showError("Paste some page text or add a photo before starting the scan.");
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
        text,
        ...(selectedImage ? { image: selectedImage } : {})
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
  // `form.reset()` does not reach the photo: it lives outside the form's own
  // fields, in module state and the preview.
  clearPhoto();
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
    return "That page text or photo is too large to scan. Try a shorter section or a new photo.";
  }

  if (status === 415) {
    return "That image format is not supported. Take the photo again or choose a JPEG or PNG.";
  }

  if (status === 400) {
    return "That submission could not be scanned. Paste the page copy or add a photo and try again.";
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
