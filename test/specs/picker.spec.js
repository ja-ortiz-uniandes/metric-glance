// Smart Picker. This is the spec that genuinely needs a real browser: it turns
// on hit-testing (elementFromPoint) and layout (getBoundingClientRect), neither
// of which a fake DOM implements.

const { test, expect } = require("@playwright/test");
const { loadFixture, sendToContentScript, MARK } = require("../helpers");

// Point at the middle of an element, in viewport coordinates.
async function center(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error("no box for " + selector);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}
// Pick mode acts on mousedown, so a real press is what drives stage 1.
async function pickAt(page, selector) {
  const { x, y } = await center(page, selector);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await loadFixture(page, "picker.html", { stub: true, styles: true });
  await sendToContentScript(page, { type: "mg-pick-mode" });
  await expect(page.locator(".mg-pick-bar")).toBeVisible();
});

test("a point over a box resolves to the transparent input, not its text", async ({ page }) => {
  // Establishes the premise of the next two tests: without climbing out of this
  // element there is no text to pick.
  const { x, y } = await center(page, "#unitless");
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return { tag: el && el.tagName, cls: el && el.className, text: el ? el.textContent : null };
  }, [x, y]);
  expect(hit.tag).toBe("INPUT");
  expect(hit.text).toBe("");
});

test("outlines the box under the cursor", async ({ page }) => {
  const { x, y, box } = await center(page, "#unitless");
  await page.mouse.move(x, y);
  const outline = page.locator(".mg-pick-box");
  await expect(outline).toBeVisible();
  const drawn = await outline.boundingBox();
  expect(drawn.width).toBeGreaterThan(0);
  expect(drawn.height).toBeGreaterThan(0);
  // Tracking something box-sized, not the whole page.
  expect(drawn.width).toBeLessThan(box.width * 3);
});

test("offers every word in the box when the detector proposes nothing", async ({ page }) => {
  await pickAt(page, "#unitless");
  const words = page.locator(".mg-pick-word");
  await expect(words).toHaveCount(3);
  await expect(words.nth(0)).toHaveText("36");
  await expect(words.nth(1)).toHaveText("x");
  await expect(words.nth(2)).toHaveText("18");
  await expect(page.locator(".mg-pick-msg")).not.toHaveText(/No text there/);
});

test("selecting words enables Convert", async ({ page }) => {
  await pickAt(page, "#unitless");
  const convert = page.locator(".mg-pick-btn.mg-pick-primary");
  await expect(convert).toBeDisabled();
  await page.locator(".mg-pick-word").nth(0).click();
  await expect(convert).toBeEnabled();
});

test("offers a price the page scan declined to round, and rounds it when chosen", async ({ page }) => {
  await pickAt(page, "#pricey");
  const chip = page.locator(".mg-pick-chip").first();
  await expect(chip).toHaveText("$12.30");
  await chip.click();
  await expect(page.locator("#pricey " + MARK).first()).toHaveText("$13");
});

test("picks plain paragraph text too", async ({ page }) => {
  await pickAt(page, "#plain");
  await expect(page.locator(".mg-pick-word").first()).toHaveText("Plain");
});

test("Escape leaves pick mode and removes its UI", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.locator(".mg-pick-bar")).toHaveCount(0);
  await expect(page.locator(".mg-pick-box")).toHaveCount(0);
});
