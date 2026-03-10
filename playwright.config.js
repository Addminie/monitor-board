const { defineConfig } = require("@playwright/test");
const channel = process.env.CI ? undefined : "chrome";

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  workers: 1,
  use: {
    headless: true,
    channel,
    viewport: { width: 1600, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
});
