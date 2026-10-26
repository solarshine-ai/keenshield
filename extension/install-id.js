// Install ID.
// A random ID for this install, kept in chrome.storage.local, used by the
// server to count the free deep scans. Single-flight so two scans on a fresh
// install can't each create their own.
const INSTALL_ID_KEY = "keenshield_install_id";
let installIdPromise = null;

export function getInstallId() {
  if (!installIdPromise) {
    installIdPromise = (async () => {
      const stored = await chrome.storage.local.get(INSTALL_ID_KEY);
      if (typeof stored[INSTALL_ID_KEY] === "string" && stored[INSTALL_ID_KEY]) return stored[INSTALL_ID_KEY];
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
      return id;
    })().catch((err) => {
      installIdPromise = null;
      throw err;
    });
  }
  return installIdPromise;
}
