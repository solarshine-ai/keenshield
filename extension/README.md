# Keenshield Chrome extension

The complete extension: the number on the shield, the click-to-see-why panel,
and the full breakdown (deep scan). It never blocks a page and never pops up.

## Try it in your own Chrome (about 2 minutes)

1. Get this `extension` folder onto your computer. On GitHub, use
   **Code → Download ZIP** and unzip it.
2. In Chrome, go to `chrome://extensions`, turn on **Developer mode** (top
   right), click **Load unpacked**, and pick the `extension` folder.
3. Keenshield appears in the list with an **ID**, a 32-letter code. Copy it.
4. In Netlify, go to **Site configuration → Environment variables** and add
   `KEENSHIELD_EXTENSION_IDS` with that ID as the value. Redeploy the site.
   This is how the server knows the requests are from your extension. There's
   no secret to paste into the code.
5. Pin the shield to the toolbar (the puzzle-piece icon → pin) and browse.

When you publish to the Chrome Web Store, the store gives the extension a new
ID. Add it to the same variable, separated by a comma:
`storeid…,localid…`.

## What's in here

- `manifest.json` — the extension's settings (Manifest V3).
- `content.js` — runs on each page and reports the address, whether the page
  has password, payment or "I agree" fields (never what's typed in them), and
  the page text only on checkout, sign-up, terms and similar pages.
- `background.js` — gets the score from keenshield.app and puts the number on
  the shield.
- `popup.html` / `popup.js` / `popup.css` — the panel that opens when the
  shield is clicked.
- `install-id.js` — the random install ID used to count free full breakdowns.
- `config.js` — the keenshield.app addresses. No secrets go here; this file
  ships to every user.
- `icons/` — the shield icons.

To publish: zip the contents of this folder and upload it in the Chrome Web
Store developer dashboard.
