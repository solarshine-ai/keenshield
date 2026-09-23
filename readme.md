# Keenshield Scan

Keenshield is a Netlify-hosted fine-print scanner. The public page lets someone
paste text from a checkout, sign-up flow, or agreement — or photograph a printed
one with their phone camera — then sends it to the server-side function for a
plain-English risk summary.

The Anthropic API key stays in Netlify and is never sent to the browser.

## Setup
1. Deploy this repository to Netlify.
2. In Netlify's dashboard → **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY` = your actual Anthropic API key
   - `KEENSHIELD_SHARED_SECRET` = a long random string the extension will send
   - `KEENSHIELD_OWNER_TOKEN` = a long random string, for your own unlimited use
     (optional — leave it unset and nobody gets an exemption)
3. Redeploy after saving the variable.

No `ANTHROPIC_BASE_URL` setting is required. When Netlify AI Gateway supplies one,
the function uses it automatically; otherwise it connects to Anthropic's standard
API endpoint.

The scanner is available at `https://keenshield.netlify.app`. The API endpoint is:
   `https://keenshield.netlify.app/.netlify/functions/keenshield-scan`

The same endpoint can be used by the Keenshield Chrome extension.

## Who can call the endpoint
Requests coming from Keenshield's own site are allowed through as-is, so the
public page at `https://keenshield.netlify.app` works without any extra header.
Deploy previews and `netlify dev` are covered too, since a request whose `Origin`
matches the host serving the function counts as the site's own.

Every other caller — the Chrome extension included — must send the shared secret:

```
x-keenshield-secret: <value of KEENSHIELD_SHARED_SECRET>
```

Requests without a matching secret get a `401` before any Claude call is made, so
they cost nothing. Presenting the owner token described below also satisfies this
gate, so the owner never needs to send both.

This is deliberately a soft speed bump rather than real security. An `Origin`
header is trivial to spoof from anything that isn't a browser, so this keeps
casual traffic off the endpoint and nothing more. Real protection means the
auth/metering work listed below.

## Unlimited use for the owner
`KEENSHIELD_SHARED_SECRET` is an admission gate, not a paywall pass — it decides
who may call the endpoint and has no effect on either limit below. A separate
`KEENSHIELD_OWNER_TOKEN` is what lifts the limits, and it lifts **both** of them.

Send it either as a header:

```
x-keenshield-owner-token: <value of KEENSHIELD_OWNER_TOKEN>
```

or as `userToken` in the request body, whichever is easier for the caller. A
request carrying it skips the shared-secret gate, the per-IP rate limit, and the
per-install free scan limit, and successful responses come back with an
`x-keenshield-limits: bypassed` header so you can confirm it took effect.

An owner scan does not increment the stored per-install count, so revoking the
token later leaves that install's free scans exactly where they were.

If `KEENSHIELD_OWNER_TOKEN` is unset, nobody is the owner and every caller is
metered normally — a missing variable never reads as a match. Both this token and
the shared secret are compared in constant time.

**Never put this token in frontend code or in the extension's bundled config.**
Both ship to users, and anyone who reads it out gets unlimited scans on your
Anthropic key. It is for requests you make yourself — curl, a local build of the
extension, your own tooling. It is one shared secret with no per-user revocation,
which is why it is an owner hatch and not a paid tier.

## What it does
- Receives `{ url, title, text, image, installId, userToken }` from the extension
  or the public page
- Sends the page text and/or photo to Claude with a scam/fine-print analysis prompt
- Returns `{ risk_level, flags, summary }`
- Never exposes the API key to the browser

### Photo input
A request may carry page text, a photo, or both — at least one is required.
The photo goes in `image` as base64:

```json
{ "image": { "mediaType": "image/jpeg", "data": "<base64>" } }
```

`mediaType` must be `image/jpeg`, `image/png`, `image/webp`, or `image/gif`, and
the base64 payload is capped at 5MB (Anthropic's per-image ceiling). A full
`data:` URL is accepted in place of bare base64. Rejections are
`415 {"error": "Unsupported image type"}`,
`413 {"error": "Image too large"}`, and
`400 {"error": "Invalid image data"}`.

The public page's **Take a photo** button uses
`<input type="file" accept="image/*" capture="environment">`, which opens the
rear camera on a phone. Before uploading, the browser resizes the photo to
1,568px on its long edge and re-encodes it as JPEG — that keeps a 12MP camera
photo to a few hundred kilobytes and, as a side effect of the canvas
round-trip, strips the EXIF metadata (including location) from what is sent.

## Limits
Two independent limits sit in front of the Claude call. A request has to pass
both, and passing one says nothing about the other. Each is checked before any
Claude call is made, so a blocked request costs nothing. A request carrying
`KEENSHIELD_OWNER_TOKEN` skips both.

### Per-IP rate limit (abuse speed)
A rolling window of **20 requests per hour per IP**, counted in the
`keenshield-rate-limits` Netlify Blobs store. Applies to every caller except the
owner, including Keenshield's own site. Over the limit returns:

```
429  {"error": "Rate limit exceeded, please try again later"}
```

### Per-install free scan limit (business model)
Each Chrome extension install gets **5 free scans, ever**. There is no time
window — the count in the `keenshield-scan-counts` Netlify Blobs store only goes
up, so a spent install stays spent. From the 6th scan on:

```
402  {"error": "Free scan limit reached", "scansUsed": 5}
```

The extension identifies itself with an `installId` in the request body: a
`crypto.randomUUID()` generated the first time it runs and kept in
`chrome.storage.local`, so it survives across scans but differs per install.

**Requests with no `installId` are not metered by this limit at all.** That is
how the public page at `https://keenshield.netlify.app` keeps working — the site
has no install concept yet, so it has nothing to count against. This also means
the limit is only as strong as the client's honesty: anything that can send an
HTTP request can omit or rotate `installId` and get fresh scans. It exists to
shape the free tier for ordinary extension users, not to stop a determined
caller. Real enforcement needs the accounts work below.

If Netlify Blobs is ever unreachable, both limits fall back to an in-memory
counter that resets on cold start and isn't shared between instances. That is a
deliberate fail-open: an outage degrades metering rather than taking scanning
offline for everyone.

The extension is not in this repository. The exact change it needs in order to
send an `installId` is written up in
[`docs/extension-install-id.md`](docs/extension-install-id.md).

## Not done yet (intentionally — for later)
- **Accounts / paid tier**: `userToken` now lifts the limits for one value — the owner token — and is otherwise ignored. Real accounts are still missing: a single shared secret cannot be revoked per user or attributed to a subscriber, so that is what should eventually lift the 5-scan limit for paying users.
- **Install IDs are self-reported**: an install ID is just a string the client sends. Tying scans to a real account is the only way to make the free-tier limit hold.

## Project structure
- `public/` contains the scanner interface.
- `netlify/functions/keenshield-scan.js` contains the server-side analysis function.
- `netlify.toml` defines the publish and functions directories.

## Test locally
Run `netlify dev` and open the local site URL shown by the CLI.
