// Playwright config for the content-script tests.
//
// Chromium only, and deliberately so: these tests do not load the packaged
// add-on (Chromium no longer runs MV2 extensions at all). They inject
// extension/converter.js into a fixture page, which is possible because the
// script falls back to `start()` with default settings when no extension API
// is present. What that buys is a real engine with real layout, which is the
// only way to test hit-testing (elementFromPoint, getBoundingClientRect) and
// Range-based text replacement.
//
// Not covered here, by design: manifest.json, background.js, mg-uploader.js.
// Those still need a manual run in Firefox.

const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
