// Detection: what converts, what must not, and what the surrounding text looks
// like afterwards.

const { test, expect } = require("@playwright/test");
const { loadFixture, MARK, visibleText } = require("../helpers");

test.describe("baseline units", () => {
  test.beforeEach(async ({ page }) => {
    await loadFixture(page, "units.html");
  });

  test("converts the common imperial units", async ({ page }) => {
    await expect(page.locator("#miles " + MARK)).toHaveText(/km/);
    await expect(page.locator("#feet " + MARK)).toHaveText(/m|km/);
    await expect(page.locator("#inches " + MARK)).toHaveText(/cm|mm/);
    await expect(page.locator("#pounds " + MARK)).toHaveText(/kg|g/);
    await expect(page.locator("#fahrenheit " + MARK)).toHaveText(/°C/);
  });

  test("shares one trailing unit across a dimension list", async ({ page }) => {
    await expect(page.locator("#dims " + MARK)).toHaveCount(1);
    await expect(page.locator("#dims " + MARK)).toHaveText(/×/);
  });

  test("leaves a bare 'in' preposition alone", async ({ page }) => {
    // Nothing to convert here, so wait for the page to have settled first by
    // asserting on a sibling that does convert.
    await expect(page.locator("#inches " + MARK)).toHaveCount(1);
    await expect(page.locator("#preposition " + MARK)).toHaveCount(0);
    await expect(page.locator("#index " + MARK)).toHaveCount(0);
  });

  test("keeps the page's own punctuation and spacing around a conversion", async ({ page }) => {
    await expect(page.locator("#spacing " + MARK)).toHaveCount(2);
    const text = await visibleText(page, "#spacing");
    // The brackets and the colon are the page's, so they stay put and stay tight.
    expect(text).toMatch(/^Exactly \(\S+ (cm|mm)\) wide, or \S+ (cm|mm): the label\.$/);
  });
});

test.describe("axis-letter dimensions", () => {
  test.beforeEach(async ({ page }) => {
    await loadFixture(page, "swatches.html");
  });

  test("converts a size swatch written 36\"W x 18\"H", async ({ page }) => {
    await expect(page.locator("#sw1 " + MARK)).toHaveCount(2);
    expect(await visibleText(page, "#sw1")).toBe("91.4 cm W x 45.7 cm H");
  });

  test("converts every axis of a three-axis size", async ({ page }) => {
    await expect(page.locator("#sw2 " + MARK)).toHaveCount(3);
    expect(await visibleText(page, "#sw2")).toBe("91.4 cm L x 45.7 cm W x 10.2 cm D");
  });

  test("handles lowercase axis letters", async ({ page }) => {
    await expect(page.locator("#lower " + MARK)).toHaveCount(2);
    // 48 in is 1.2 m: the scale engine picks the reading with the fewest
    // digits, so it does not stay in cm the way the smaller sizes do.
    expect(await visibleText(page, "#lower")).toBe("Panel size 1.2 m w x 61 cm h fits most windows.");
  });

  test("keeps the axis letter, which is the page's text", async ({ page }) => {
    await expect(page.locator("#prose " + MARK)).toHaveCount(2);
    const text = await visibleText(page, "#prose");
    expect(text).toContain(" W x ");
    expect(text).toContain(" H ");
    expect(text).toBe("Choose the 1.8 m W x 91.4 cm H panel for a picture window.");
  });
});
