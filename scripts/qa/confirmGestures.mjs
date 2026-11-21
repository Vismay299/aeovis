/**
 * The deliberate confirm gestures the app uses, performed the way a keyboard
 * user does them, so browser checks exercise the real interaction instead of a
 * plain click that the UI no longer accepts.
 *
 * - Spend approvals end in a slide-to-confirm (src/components/kokonutui/
 *   slide-to-confirm.tsx). Its thumb is a button named
 *   "<label> · $<amount>. Press Enter to confirm."; Enter or Space on the
 *   focused thumb confirms in one go.
 * - Destructive confirms are hold-to-confirm (src/components/kokonutui/
 *   hold-button.tsx, via ConfirmDialog and InlineConfirm): Enter or Space held
 *   for the hold duration completes it; releasing early cancels.
 */
import assert from "node:assert/strict";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Confirms the slide-to-confirm labelled `label` inside `scope` (usually the
 * cost dialog) and returns the dollar amount its thumb announced, as a number
 * (0.42 for "$0.42").
 * When the dialog shows a "Cost / Up to $X" line, the thumb must name the same
 * amount, so the gesture approves exactly the price the user reviewed.
 */
export async function slideToConfirm(scope, label, { timeout = 10000 } = {}) {
  const thumb = scope.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(label)} · (\\$[0-9][0-9,]*\\.[0-9]{2,4})\\. Press Enter to confirm\\.$`),
  });
  await thumb.waitFor({ timeout });
  // The thumb is aria-disabled while the quote loads or refreshes.
  const started = Date.now();
  while ((await thumb.getAttribute("aria-disabled")) !== "false") {
    assert.ok(Date.now() - started < timeout, `the "${label}" slider never became enabled`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const name = await thumb.getAttribute("aria-label");
  const amount = name.match(/· (\$[0-9][0-9,]*\.[0-9]{2,4})\./)[1];
  const dialogText = await scope.textContent();
  if (dialogText.includes("Up to $")) {
    assert.ok(
      dialogText.includes(`Up to ${amount}`),
      `the slider approves ${amount} but the dialog shows a different price: ${dialogText}`,
    );
  }
  await thumb.focus();
  await thumb.press("Enter");
  return Number(amount.replace(/[$,]/g, ""));
}

/**
 * Holds the hold-to-confirm `button` with the keyboard for `holdMs` plus a
 * margin, then releases. The component's own default is 1200 ms.
 */
export async function holdToConfirm(button, { holdMs = 1200, marginMs = 400 } = {}) {
  await button.waitFor();
  await button.focus();
  const page = button.page();
  await page.keyboard.down("Enter");
  await page.waitForTimeout(holdMs + marginMs);
  await page.keyboard.up("Enter");
}
