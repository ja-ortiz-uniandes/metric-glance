// Prices split across elements. The point of these is the text AROUND the
// price: rewriting the price must not eat the page's own spacing.

const { test, expect } = require("@playwright/test");
const { loadFixture, MARK, visibleText, rawVisibleText } = require("../helpers");

test.beforeEach(async ({ page }) => {
  await loadFixture(page, "split-price.html");
});

test("rounds a split price with no visible decimal point", async ({ page }) => {
  await expect(page.locator("#tight " + MARK)).toHaveText("$13");
  expect(await visibleText(page, "#tight")).toBe("Price: $13 today.");
});

test("keeps the spaces the wrapper itself holds", async ({ page }) => {
  await expect(page.locator("#spaced " + MARK)).toHaveText("$13");
  // Not whitespace-collapsed: the space on each side has to actually be there.
  const text = await rawVisibleText(page, "#spaced");
  expect(text).toMatch(/Now\s+\$13\s+each\./);
  expect(text).not.toMatch(/Now\$13/);
  expect(text).not.toMatch(/\$13each/);
});

test("leaves a price that needs no rounding completely alone", async ({ page }) => {
  await expect(page.locator("#spaced " + MARK)).toHaveCount(1); // page has settled
  await expect(page.locator("#whole " + MARK)).toHaveCount(0);
  const text = await visibleText(page, "#whole");
  expect(text).toContain("13");
  expect(text).not.toContain("14");
});

test("still rounds a contiguous price through the text pass", async ({ page }) => {
  await expect(page.locator("#contiguous " + MARK)).toHaveText("$2");
  expect(await visibleText(page, "#contiguous")).toBe("Just $2 for one.");
});

test("never converts the offscreen copy in place", async ({ page }) => {
  await expect(page.locator("#tight " + MARK)).toHaveCount(1);
  await expect(page.locator(".a-offscreen " + MARK)).toHaveCount(0);
  // The offscreen copy is the page's own markup and must survive untouched.
  await expect(page.locator("#tight .a-offscreen")).toHaveText("$12.77");
});
