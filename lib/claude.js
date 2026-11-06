// ============================================================
// KEENSHIELD — lib/claude.js
//
// One small helper for "send a prompt, get JSON back" calls to
// Claude. Used by the page and site scores. Returns null on any
// failure so callers can fall back instead of erroring.
// ============================================================

export async function askClaudeForJson({ model, system, user, maxTokens = 400, label = "claude" }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  if (!apiKey) {
    console.error(`${label}: ANTHROPIC_API_KEY is not set`);
    return null;
  }

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!response.ok) {
      console.error(`${label}: Anthropic API error:`, await response.text());
      return null;
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    return JSON.parse((textBlock?.text || "").replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error(`${label}: AI call failed:`, err);
    return null;
  }
}
