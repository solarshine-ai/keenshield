// Keenshield accounts: sign-in with Netlify Identity, account status, and
// sending buyers to Stripe with their email filled in.
//
// Purchases are matched to accounts by email, so the buy buttons pass the
// signed-in email to Stripe's payment page as `prefilled_email`. The session
// cookie Identity sets is what the scanner reads to know who is scanning.
import {
  AuthError,
  MissingIdentityError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  requestPasswordRecovery,
  signup,
  updateUser
} from "/vendor/netlify-identity.js";

const state = { user: null, account: null };
// app.js reads this for the document review option.
window.keenshieldAccount = state;

const dialog = document.querySelector("#account-dialog");
const accountButton = document.querySelector("#account-button");
const signedOut = document.querySelector("#account-signed-out");
const signedIn = document.querySelector("#account-signed-in");
const accountContext = document.querySelector("#account-context");
const accountTitle = document.querySelector("#account-title");
const checkoutNote = document.querySelector("#account-checkout-note");
const tabs = document.querySelectorAll("[data-auth-tab]");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const authSubmitLabel = document.querySelector("#auth-submit-label");
const forgotButton = document.querySelector("#forgot-password");
const resetForm = document.querySelector("#reset-form");
const resetPassword = document.querySelector("#reset-password");
const authStatus = document.querySelector("#auth-status");
const skip = document.querySelector("#account-skip");
const skipLink = document.querySelector("#account-skip-link");
const accountEmail = document.querySelector("#account-email");
const accountPlan = document.querySelector("#account-plan");
const accountCredits = document.querySelector("#account-credits");
const accountThanks = document.querySelector("#account-thanks");
const signOutButton = document.querySelector("#sign-out");

let mode = "login";
// The Stripe link someone clicked before signing in, so they carry on to it.
let pendingCheckout = null;

const PLAN_NAMES = { pro: "Pro", family: "Family" };
const INTERVAL_NAMES = { month: "monthly", year: "yearly" };

// ── State ────────────────────────────────────────────────────
function publish() {
  window.dispatchEvent(new CustomEvent("keenshield:account", { detail: { user: state.user, account: state.account } }));
}

async function refreshAccount() {
  if (!state.user) {
    state.account = null;
  } else {
    try {
      const response = await fetch("/api/account", { credentials: "same-origin", cache: "no-store" });
      state.account = response.ok ? await response.json() : null;
    } catch {
      state.account = null;
    }
  }
  render();
  publish();
}

async function setUser(user) {
  state.user = user && user.email ? user : null;
  await refreshAccount();
}

// ── Rendering ────────────────────────────────────────────────
function planLabel(account) {
  if (!account || !account.plan) return "Free";
  const interval = INTERVAL_NAMES[account.planInterval];
  return `${PLAN_NAMES[account.plan] || account.plan}${interval ? ` (${interval})` : ""}`;
}

function render() {
  const account = state.account;
  if (state.user) {
    accountButton.textContent = account && account.plan ? PLAN_NAMES[account.plan] || "Account" : "Account";
    accountEmail.textContent = state.user.email;
    accountPlan.textContent = planLabel(account);
    accountCredits.textContent =
      account && account.plan
        ? "Included with your plan"
        : `${account ? account.documentCredits : 0} left`;
  } else {
    accountButton.textContent = "Sign in";
  }
  signedIn.hidden = !state.user;
  signedOut.hidden = Boolean(state.user);
}

function setStatus(message, tone) {
  authStatus.textContent = message || "";
  authStatus.dataset.tone = tone || "";
}

function setMode(next) {
  mode = next;
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.authTab === next));
  authSubmitLabel.textContent = next === "signup" ? "Create account" : "Sign in";
  authPassword.autocomplete = next === "signup" ? "new-password" : "current-password";
  forgotButton.hidden = next === "signup";
  setStatus("");
}

function openDialog({ checkoutUrl = null, message = null } = {}) {
  pendingCheckout = checkoutUrl;
  const forCheckout = Boolean(checkoutUrl);
  accountContext.textContent = forCheckout ? "Before you buy" : "Your account";
  accountTitle.textContent = forCheckout ? "Create your account first" : "Sign in to Keenshield";
  checkoutNote.hidden = !forCheckout;
  skip.hidden = !forCheckout;
  if (forCheckout) {
    skipLink.href = checkoutUrl;
    setMode("signup");
  }
  resetForm.hidden = true;
  authForm.hidden = false;
  setStatus(message || "");
  if (!dialog.open) dialog.showModal();
  if (!state.user) setTimeout(() => authEmail.focus(), 30);
}

function closeDialog() {
  if (dialog.open) dialog.close();
}

// ── Checkout ─────────────────────────────────────────────────
function checkoutUrlFor(url, email) {
  const target = new URL(url);
  if (email) target.searchParams.set("prefilled_email", email);
  return target.toString();
}

function continueToCheckout() {
  if (!pendingCheckout || !state.user) return false;
  const url = checkoutUrlFor(pendingCheckout, state.user.email);
  pendingCheckout = null;
  window.location.href = url;
  return true;
}

for (const link of document.querySelectorAll("a[data-checkout]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    // home.js keeps href pointed at the monthly or yearly link.
    const url = link.href;
    if (state.user) {
      window.location.href = checkoutUrlFor(url, state.user.email);
    } else {
      openDialog({ checkoutUrl: url });
    }
  });
}

// ── Auth errors ──────────────────────────────────────────────
function authErrorMessage(error) {
  if (error instanceof MissingIdentityError) return "Sign-in isn't available right now. Please try again later.";
  if (error instanceof AuthError) {
    const text = String(error.message || "").toLowerCase();
    if (text.includes("not confirmed")) return "Confirm your email first. The link is in your inbox.";
    if (error.status === 401 || error.status === 400) return "That email and password don't match.";
    if (error.status === 403) return "New sign-ups are closed right now.";
    if (error.status === 422) {
      return text.includes("already") ? "That email already has an account. Sign in instead." : "Check your email, and use a password of at least 8 characters.";
    }
    if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  }
  return "Something went wrong. Please try again.";
}

// ── Events ───────────────────────────────────────────────────
accountButton.addEventListener("click", () => openDialog());

for (const el of dialog.querySelectorAll("[data-close-dialog]")) {
  el.addEventListener("click", closeDialog);
}

// Clicking the backdrop closes the dialog.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});

for (const tab of tabs) {
  tab.addEventListener("click", () => setMode(tab.dataset.authTab));
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setStatus("Please enter a valid email address.", "error");
    authEmail.focus();
    return;
  }
  if (password.length < 8) {
    setStatus("Use a password of at least 8 characters.", "error");
    authPassword.focus();
    return;
  }

  const button = authForm.querySelector("button[type='submit']");
  button.disabled = true;
  setStatus(mode === "signup" ? "Creating your account…" : "Signing in…");

  try {
    if (mode === "signup") {
      const user = await signup(email, password);
      if (!user.confirmedAt) {
        setStatus("Check your email for a link to confirm your account, then come back and sign in.", "success");
        if (pendingCheckout) skipLink.href = checkoutUrlFor(pendingCheckout, email);
        return;
      }
      await setUser(user);
    } else {
      await setUser(await login(email, password));
    }

    authForm.reset();
    setStatus("");
    if (!continueToCheckout()) render();
  } catch (error) {
    setStatus(authErrorMessage(error), "error");
  } finally {
    button.disabled = false;
  }
});

forgotButton.addEventListener("click", async () => {
  const email = authEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setStatus("Enter your email above, then choose “Forgot your password?” again.", "error");
    authEmail.focus();
    return;
  }
  try {
    await requestPasswordRecovery(email);
    setStatus("If that email has an account, a reset link is on its way.", "success");
  } catch (error) {
    setStatus(authErrorMessage(error), "error");
  }
});

resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (resetPassword.value.length < 8) {
    setStatus("Use a password of at least 8 characters.", "error");
    return;
  }
  try {
    await setUser(await updateUser({ password: resetPassword.value }));
    resetForm.reset();
    resetForm.hidden = true;
    authForm.hidden = false;
    setStatus("");
  } catch (error) {
    setStatus(authErrorMessage(error), "error");
  }
});

signOutButton.addEventListener("click", async () => {
  try {
    await logout();
  } finally {
    await setUser(null);
    closeDialog();
  }
});

// app.js updates the credit count after a review; keep the panel in step.
window.addEventListener("keenshield:account", render);

onAuthChange((event, user) => {
  // Keeps other open tabs in step. TOKEN_REFRESH needs no re-render.
  if (event === "login" || event === "logout" || event === "user_updated") setUser(user);
});

// ── Start up ─────────────────────────────────────────────────
async function start() {
  // Email confirmation and password reset links come back here with a token
  // in the URL hash.
  try {
    const result = await handleAuthCallback();
    if (result && result.type === "recovery") {
      await setUser(result.user);
      openDialog();
      signedIn.hidden = true;
      signedOut.hidden = false;
      authForm.hidden = true;
      resetForm.hidden = false;
      accountTitle.textContent = "Reset your password";
      return;
    }
    if (result && result.type === "confirmation") {
      await setUser(result.user);
      openDialog({ message: "Your email is confirmed and you're signed in." });
      return;
    }
  } catch (error) {
    console.error("Keenshield sign-in callback failed:", error);
  }

  await setUser(await getUser());

  // Stripe sends buyers back to ?purchase=success once you set that as the
  // payment links' confirmation page.
  const params = new URLSearchParams(window.location.search);
  if (params.get("purchase") === "success") {
    params.delete("purchase");
    const query = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);

    if (state.user) {
      accountThanks.hidden = false;
      openDialog();
      // The webhook usually lands within a second or two of the redirect.
      for (const delay of [1500, 4000, 9000]) setTimeout(refreshAccount, delay);
    } else {
      openDialog({ message: "Thanks for your purchase. Sign in or create an account with the email you paid with to use it." });
    }
  }
}

start();
