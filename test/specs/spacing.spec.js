// Spacing that actually renders.
//
// These assertions are geometric on purpose. A space can be present in the DOM
// and still render at zero width: a flex container generates no item for a
// whitespace-only text node, and trims the edge whitespace of the anonymous
// items either side of it. Asserting on textContent would pass while the page
// visibly read "61 cmW x30.5 cmH", which is exactly the bug that got here.

const { test, expect } = require("@playwright/test");
const { loadFixture, MARK } = require("../helpers");

// Every whitespace-only text node that actually separates a converted value
// from visible text, with the width it occupies on screen.
//
// A gap with nothing but whitespace beyond it is skipped: that is the page's own
// leading or trailing space, which a flex container drops with or without us,
// and is not ours to account for.
async function gapWidths(page, selector) {
  return page.locator(selector).evaluate((el) => {
    const out = [];
    el.querySelectorAll(".mg-converted").forEach((span) => {
      for (const dir of ["previousSibling", "nextSibling"]) {
        const n = span[dir];
        if (!n || n.nodeType !== Node.TEXT_NODE) continue;
        if (/\S/.test(n.nodeValue || "")) continue; // real text, not a gap
        let beyond = n[dir];
        while (beyond && !/\S/.test(beyond.textContent || "")) beyond = beyond[dir];
        if (!beyond) continue; // separates nothing
        const r = document.createRange();
        r.selectNodeContents(n);
        out.push({
          dir,
          codePoint: (n.nodeValue || "").codePointAt(0),
          width: Math.round(r.getBoundingClientRect().width * 100) / 100,
        });
      }
    });
    return out;
  });
}

// The horizontal distance between each converted value and the text right after
// it, as rendered.
async function separations(page, selector) {
  return page.locator(selector).evaluate((el) => {
    const out = [];
    el.querySelectorAll(".mg-converted").forEach((span) => {
      let n = span.nextSibling;
      while (n && !(n.nodeType === Node.TEXT_NODE && /\S/.test(n.nodeValue || ""))) n = n.nextSibling;
      if (!n) return;
      const r = document.createRange();
      r.selectNodeContents(n);
      const a = span.getBoundingClientRect();
      const b = r.getBoundingClientRect();
      out.push({ value: span.textContent, next: (n.nodeValue || "").trim().slice(0, 6), gap: Math.round((b.left - a.right) * 100) / 100 });
    });
    return out;
  });
}

test.describe("inside a flex container", () => {
  test.beforeEach(async ({ page }) => {
    await loadFixture(page, "swatches.html");
    await expect(page.locator("#sw3 " + MARK)).toHaveCount(2);
  });

  test("the inserted gap occupies real width", async ({ page }) => {
    const gaps = await gapWidths(page, "#sw3");
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g.width, "gap of U+" + g.codePoint.toString(16) + " renders at zero width").toBeGreaterThan(0);
    }
  });

  test("uses a no-break space, which a flex container does not discard", async ({ page }) => {
    const gaps = await gapWidths(page, "#sw3");
    for (const g of gaps) expect(g.codePoint).toBe(0x00a0);
  });

  test("the value does not touch the axis letter after it", async ({ page }) => {
    const seps = await separations(page, "#sw3");
    expect(seps.length).toBeGreaterThan(0);
    for (const s of seps) {
      expect(s.gap, JSON.stringify(s.value) + " touches " + JSON.stringify(s.next)).toBeGreaterThan(1);
    }
  });
});

test.describe("in ordinary text", () => {
  test.beforeEach(async ({ page }) => {
    await loadFixture(page, "swatches.html");
    await expect(page.locator("#prose " + MARK)).toHaveCount(2);
  });

  test("uses a plain space, so the line can still wrap there", async ({ page }) => {
    const gaps = await gapWidths(page, "#prose");
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g.codePoint, "a no-break space in prose would stop the line wrapping").toBe(0x0020);
      expect(g.width).toBeGreaterThan(0);
    }
  });

  test("the value does not touch the word after it", async ({ page }) => {
    const seps = await separations(page, "#prose");
    for (const s of seps) expect(s.gap).toBeGreaterThan(1);
  });
});
