// Keenshield homepage: the shield demo, the pricing toggle and the waitlist.
// The scanner itself lives in app.js.

// ── Shield demo ──────────────────────────────────────────────
// Cycles through a few pages so visitors see the number move the way it does
// in the toolbar. Every example is invented.
const demoPages = [
  {
    caption: "Browsing a shop's homepage",
    address: "harbor-goods.com",
    score: 1,
    reasons: ["Nothing here asks you to agree, pay or sign in."]
  },
  {
    caption: "Same shop, at checkout",
    address: "harbor-goods.com/checkout",
    score: 6,
    reasons: [
      "The free trial turns into a $14.99/month membership after 30 days.",
      "Cancelling is by phone only, weekdays 9–5.",
      "Disputes go to private arbitration instead of court."
    ]
  },
  {
    caption: "A rental listing from a marketplace",
    address: "cedar-lane-rentals.top/listing/2br",
    score: 8,
    reasons: [
      "Asks for a $650 deposit by Zelle before you can see the home.",
      "Rent is far below similar two-bedrooms in the area.",
      "The owner says they're overseas and can't meet in person."
    ]
  },
  {
    caption: "A “verify your account” link from an email",
    address: "amaz0n-account-verify.xyz/login",
    score: 10,
    reasons: [
      'The address mentions "amazon" but isn’t one of amazon’s real websites (amazon.com).',
      "Asks for your full card number to “unlock” your account.",
      "Says your account closes in 24 hours unless you act now."
    ]
  }
];

const demo = {
  address: document.querySelector("#demo-address"),
  shield: document.querySelector("#demo-shield"),
  score: document.querySelector("#demo-score"),
  panelScore: document.querySelector("#demo-panel-score"),
  reasons: document.querySelector("#demo-reasons"),
  caption: document.querySelector("#demo-caption"),
  panel: document.querySelector("#demo-panel")
};

function levelOf(score) {
  if (score >= 7) return "red";
  if (score >= 4) return "yellow";
  return "green";
}

function showDemoPage(page) {
  demo.address.textContent = page.address;
  demo.score.textContent = String(page.score);
  demo.panelScore.textContent = String(page.score);
  demo.shield.dataset.level = levelOf(page.score);
  demo.caption.textContent = page.caption;
  demo.reasons.replaceChildren(
    ...page.reasons.map((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      return li;
    })
  );

  // Restart the small "number changed" pulse.
  for (const el of [demo.shield, demo.panel]) {
    el.classList.remove("is-changing");
    void el.offsetWidth;
    el.classList.add("is-changing");
  }
}

if (demo.shield) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let index = 0;
  showDemoPage(demoPages[index]);

  if (!reduceMotion) {
    setInterval(() => {
      if (document.hidden) return;
      index = (index + 1) % demoPages.length;
      showDemoPage(demoPages[index]);
    }, 4200);
  } else {
    // Without motion, let people step through the examples by clicking.
    demo.shield.closest(".demo").addEventListener("click", () => {
      index = (index + 1) % demoPages.length;
      showDemoPage(demoPages[index]);
    });
  }
}

// ── Billing toggle ──────────────────────────────────────────
const billingButtons = document.querySelectorAll("[data-billing]");

function setBilling(period) {
  for (const button of billingButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.billing === period));
  }
  for (const el of document.querySelectorAll("[data-price-yearly]")) {
    el.textContent = el.dataset[period === "yearly" ? "priceYearly" : "priceMonthly"];
  }
  for (const el of document.querySelectorAll("[data-per-yearly]")) {
    el.textContent = el.dataset[period === "yearly" ? "perYearly" : "perMonthly"];
  }
}

for (const button of billingButtons) {
  button.addEventListener("click", () => setBilling(button.dataset.billing));
}

// ── Waitlist ─────────────────────────────────────────────────
const waitlistForm = document.querySelector("#waitlist-form");
const waitlistEmail = document.querySelector("#waitlist-email");
const waitlistPlan = document.querySelector("#waitlist-plan");
const waitlistStatus = document.querySelector("#waitlist-status");

// Any "join" link elsewhere on the page preselects its plan in the form.
for (const link of document.querySelectorAll("a[data-plan]")) {
  link.addEventListener("click", () => {
    waitlistPlan.value = link.dataset.plan;
    // Let the jump to #get happen first, then put the cursor in the field.
    setTimeout(() => waitlistEmail.focus({ preventScroll: true }), 350);
  });
}

function setWaitlistStatus(message, tone) {
  waitlistStatus.textContent = message;
  waitlistStatus.dataset.tone = tone || "";
}

waitlistForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = waitlistEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setWaitlistStatus("Please enter a valid email address.", "error");
    waitlistEmail.focus();
    return;
  }

  const button = waitlistForm.querySelector("button[type='submit']");
  button.disabled = true;
  setWaitlistStatus("Adding you…");

  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        plan: waitlistPlan.value,
        company: waitlistForm.elements.company.value
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setWaitlistStatus(data.error || "Something went wrong. Please try again.", "error");
      return;
    }

    waitlistForm.reset();
    setWaitlistStatus("You're on the list. We'll email you when it's ready.", "success");
  } catch {
    setWaitlistStatus("Couldn't reach Keenshield. Check your connection and try again.", "error");
  } finally {
    button.disabled = false;
  }
});
