# Keenshield Scan

Keenshield is a Netlify-hosted fine-print scanner. The public page lets someone
paste text from a checkout, sign-up flow, or agreement — or photograph a printed
one with their phone camera — then sends it to the server-side function for a
plain-English risk summary.

The Anthropic API key stays in Netlify and is never sent to the browser.

Keenshield is now built extension-first. The extension puts a 1–10 risk number
on its toolbar shield, never blocks anything and never pops up, and the person
clicks the shield to read why. keenshield.app is the extension's home: what it
does, the bigger scanner, the trust and privacy section, pricing and a launch
waitlist.

## Setup
1. Deploy this repository to Netlify.
2. In Netlify's dashboard → **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY` = your actual Anthropic API key
   - `KEENSHIELD_SHARED_SECRET` = a long random string the extension will send
   - `KEENSHIELD_EXTENSION_IDS` = your Chrome extension's ID (comma-separate
     several, e.g. the Web Store ID and a local unpacked build's ID). Requests
     from these extensions are let in without the shared secret, so no secret
     has to ship in the extension's code.
   - `KEENSHIELD_OWNER_TOKEN` = a long random string, for your own unlimited use
     (optional — leave it unset and nobody gets an exemption)
   - `STRIPE_SECRET_KEY` = your Stripe secret key (`sk_live_…`), used by the
     webhook to read what a checkout bought
   - `STRIPE_WEBHOOK_SECRET` = the signing secret (`whsec_…`) Stripe shows for
     the webhook endpoint below
3. Redeploy after saving the variables.

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

## Accounts and paid plans
People sign in on keenshield.app with Netlify Identity. What each person has
paid for lives in the `accounts` table in Netlify Database, keyed by their
email:

| Plan | Price | What it unlocks |
|------|-------|-----------------|
| Pro | $4.99 / month or $39.99 / year | No free scan limit, unlimited document reviews |
| Family | $5.99 / month or $59.99 / year | Same as Pro for the buyer's account |
| Single document review | $1.99 once | One credit, spent by one document review |

**Document review mode.** The scanner takes `"mode": "document"` for a full
lease or contract: up to 60,000 characters, reviewed clause by clause, with a
`clauses` array in the result. It needs a signed-in account (`401` with
`code: "signin-required"` otherwise). An active Pro or Family plan covers it.
Without one, it spends one credit (`402` with `code: "no-credits"` when there
are none). The credit is spent before the AI call so two reviews can't share
one, and handed back if the review fails.

A signed-in subscriber also skips the per-install free scan limit.

`GET /api/account` returns the signed-in person's plan and remaining credits
for the website.

### Stripe webhook (`/api/stripe-webhook`)
Stripe calls `https://keenshield.app/api/stripe-webhook` after each billing
event. Every request must carry a valid `Stripe-Signature` made with
`STRIPE_WEBHOOK_SECRET`, and anything unsigned, wrongly signed or more than 5
minutes old gets `400` before anything else happens.

| Event | Effect |
|-------|--------|
| `checkout.session.completed` | Turns on Pro or Family, or adds a document credit, for the buyer's email |
| `checkout.session.async_payment_succeeded` | The same, for payments that settle later (bank debits) |
| `customer.subscription.deleted` | Turns that subscription's plan off |
| `charge.refunded` (full refunds only) | Removes the credit that payment bought or, for a subscription payment, turns the plan off |

What a checkout bought is read from its line items through the Stripe API
(using `STRIPE_SECRET_KEY`), matched by price and billing interval and then by
product name. Each event ID is stored in `stripe_events`, in the same
transaction as its effect, so a repeated delivery changes nothing. Credit
purchases are also unique per checkout session. If processing fails, nothing
is saved and the `500` makes Stripe retry.

The buy buttons pass the signed-in email to Stripe as `prefilled_email`.
Someone who buys without an account can sign up later with the same email,
and the purchase is already waiting on it.

The browser copy of `@netlify/identity` in `public/vendor/` is generated with
`npm run vendor:identity`. Re-run it after upgrading the package.

## Not done yet (intentionally — for later)
- **Family members**: Family currently unlocks the buyer's own account. Adding
  up to four more people to the plan still needs to be built.
- **Extension sign-in**: the extension stays on 5 free deep scans. Paid plans
  apply on keenshield.app.
- **Install IDs are self-reported**: an install ID is just a string the client sends, so the free-tier limit only holds for ordinary extension users.

## The shield number (`/api/site-score`)
The endpoint behind the number on the extension's icon. It applies the same
shared-secret gate as the deep scan. Its budget is separate and much larger
(600 lookups per IP per hour, at most 60 of them fresh AI scores), because it
runs during ordinary browsing. It does not touch the 5 free deep scans.

It keeps cost down in layers:
1. **Address checks.** Lookalike brand domains, raw IP addresses, look-alike
   characters, throwaway TLDs, and password or payment pages without HTTPS.
   These are free and need no AI.
2. **Decision pages only.** Pages that don't ask the person to agree, pay,
   subscribe, sign up or share sensitive details stop at the address checks.
3. **Score once, share with everyone.** Decision pages are scored by
   `claude-haiku-5-5` and stored in Netlify Database (`site_scores`), keyed by
   hostname + path with no query string. Later visitors get the stored score
   while the page text is unchanged (up to 30 days), or within 24 hours
   regardless, since cart pages change on every load.

Page text is never stored, only a hash of it. If the database is unavailable,
the endpoint scores fresh rather than failing, so the shield always gets a
number. The extension side is written up in
[`docs/extension-shield-score.md`](docs/extension-shield-score.md).

## Waitlist (`/api/waitlist`)
The waitlist form saves `{ email, plan }` to the `waitlist` table, for people
waiting on the extension's launch or on team plans. Plans are
`launch`, `pro`, `family`, `document` and `teams`. Only Keenshield's own site
can post to it, with a per-IP limit and a honeypot field against bots.

## Project structure
- `public/` is the website: the extension homepage (`index.html`, `home.js`),
  the scanner (`app.js`), and the privacy policy and terms pages.
- `netlify/functions/keenshield-scan.js` is the deep scan (`claude-sonnet-5-5`).
- `netlify/functions/site-score.ts` is the shield number.
- `netlify/functions/waitlist.ts` is the launch and teams waitlist.
- `netlify/functions/stripe-webhook.ts` turns plans and credits on and off.
  Its logic is in `lib/stripe-webhook.js`, tested in `test/stripe-webhook.test.js`.
- `netlify/functions/account.ts` reports the signed-in person's plan.
- `db/billing.ts` reads and writes plans and credits. `lib/entitlements.js`
  decides what an account can do.
- `public/account.js` is sign-in and the buy buttons.
- `lib/gate.js` holds the shared rules for who may call the endpoints and how
  fast.
- `db/schema.ts` is the database schema. Migrations in
  `netlify/database/migrations/` are applied by Netlify on deploy.
- `extension/` is the Chrome extension. See `extension/README.md` to load it.
- `netlify.toml` defines the publish and functions directories.

## Test locally
Run `netlify dev` and open the local site URL shown by the CLI.
