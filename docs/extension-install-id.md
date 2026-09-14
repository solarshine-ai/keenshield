# Extension change: send an `installId` with every scan

The backend now meters free scans per extension install. This is the extension
half of that change. It is documented here rather than implemented because the
Chrome extension source is not part of this repository.

Until the extension starts sending an `installId`, nothing breaks — the backend
treats a request without one as unmetered, so those installs keep getting
unlimited free scans.

## What the backend expects

Add an `installId` field to the JSON body of the scan request:

```json
{
  "url": "...",
  "title": "...",
  "text": "...",
  "installId": "3f2b9c10-1a2b-4c3d-9e8f-000011112222"
}
```

It must be stable for the lifetime of an install and different between installs.
A `crypto.randomUUID()` generated once and kept in `chrome.storage.local` gives
both. See the [Limits section of the readme](../readme.md#limits) for what the
backend does with it.

## 1. Generate and persist the ID

Add this to `background.js` (or its own module the service worker imports).

```js
// ── Install ID ─────────────────────────────────────────────────────
// A random ID generated the first time this install runs and kept in
// chrome.storage.local, so it survives across scans and service-worker
// restarts but is different for every install. The backend uses it to
// count how many free scans this install has spent.
const INSTALL_ID_KEY = "keenshield_install_id";

// Single-flight guard. Two scans firing at once on a fresh install would
// otherwise both find nothing stored, both generate an ID, and one would
// overwrite the other — losing the scans already counted against the first.
let installIdPromise = null;

async function getInstallId() {
  if (installIdPromise) return installIdPromise;

  installIdPromise = (async () => {
    const stored = await chrome.storage.local.get(INSTALL_ID_KEY);
    const existing = stored[INSTALL_ID_KEY];
    if (typeof existing === "string" && existing) return existing;

    const installId = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: installId });
    return installId;
  })();

  try {
    return await installIdPromise;
  } catch (err) {
    // Clear the cached rejection so the next scan can retry rather than
    // replaying the same failure forever.
    installIdPromise = null;
    throw err;
  }
}
```

Use `chrome.storage.local`, not `chrome.storage.sync`. `sync` would share one ID
across every Chrome profile the user is signed into, so their five free scans
would be shared across all their machines instead of being per install.

## 2. Send it with the scan

In `scanPage()`, await the ID and add it to the body:

```js
async function scanPage(payload) {
  const installId = await getInstallId();

  const res = await fetch(CONFIG.API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-keenshield-secret": CONFIG.SHARED_SECRET,
    },
    body: JSON.stringify({
      url: payload.url,
      title: payload.title,
      text: (payload.textSample || "").slice(0, CONFIG.MAX_TEXT_CHARS),
      installId,
    }),
  });

  // ... existing response handling
}
```

Only the `installId` line is part of this change. The headers are shown as they
need to be today — keep whatever your current version sends.

## 3. Handle the 402

Worth doing at the same time. Once an install spends its fifth scan, every later
scan comes back as:

```
402  {"error": "Free scan limit reached", "scansUsed": 5}
```

The existing code throws `Scan API returned 402` for any non-OK response, which
surfaces to the user as a generic failure. Since this one is expected and
permanent, check for it before the generic branch:

```js
  if (res.status === 402) {
    const data = await res.json().catch(() => ({}));
    return {
      limitReached: true,
      scansUsed: data.scansUsed ?? 5,
    };
  }

  if (!res.ok) {
    throw new Error(`Scan API returned ${res.status}`);
  }
```

A `limitReached` result has no `score`, so anything that reads `result.score` —
the badge, the cached-result path, the popup — needs to branch on it and show an
out-of-free-scans message instead of a risk tier. Caching that result is fine and
saves a pointless round trip, but it should not be cached permanently if you want
a paid upgrade to take effect without a reinstall.

## Getting past the 402 yourself while testing

Hitting the 5-scan limit on your own install is the expected way to run out, and
reinstalling to reset it gets old fast. The backend now honours a
`KEENSHIELD_OWNER_TOKEN` that lifts both limits — send it from a local build as
either the `x-keenshield-owner-token` header or `userToken` in the body:

```js
    body: JSON.stringify({
      url: payload.url,
      title: payload.title,
      text: (payload.textSample || "").slice(0, CONFIG.MAX_TEXT_CHARS),
      installId,
      userToken: CONFIG.OWNER_TOKEN, // local builds only — never ship this
    }),
```

Keep it out of any build you publish. A packaged extension is readable by every
user who installs it, so a shipped owner token is a giveaway of unlimited scans
on your Anthropic key. See the readme's owner section for the full caveats.

## Things worth knowing

**Clearing storage resets the count.** If the extension ever calls
`chrome.storage.local.clear()`, it wipes the install ID along with everything
else, and the next scan looks like a brand-new install with five fresh scans. The
current `chrome.tabs.onUpdated` handler only removes `tab-*` keys, so it is safe
as written — just avoid a blanket `clear()`.

**Reinstalling resets the count**, for the same reason. This is inherent to
identifying an install rather than a person.

**The ID is self-reported.** It is a string the client sends, so anyone can omit
or rotate it for fresh scans. This shapes the free tier for ordinary users; it is
not a defence against a determined caller. Tying scans to a real account is what
would make the limit hold.
