const { execFileSync } = require("node:child_process");
const path = require("node:path");

const files = [
  "scripts/ops-doctor.js",
  "scripts/verify-dual-stack.js",
  "scripts/capacity-benchmark.js",
  "agent/server.js",
  "dashboard/server.js",
  "dashboard/public/app.js",
  "dashboard/public/config-page.js",
  "dashboard/lib/api-utils.js",
  "notify-bridge/server.js",
  "tests/helpers/service-process.js",
  "tests/unit/dashboard-api-utils.test.js",
  "tests/integration/agent.api.test.js",
  "tests/integration/dashboard.api.test.js",
  "tests/integration/notify-bridge.api.test.js",
  "tests/e2e/dashboard-regression.spec.js",
  "playwright.config.js",
];

let hasError = false;
for (const file of files) {
  const fullPath = path.join(process.cwd(), file);
  try {
    execFileSync(process.execPath, ["--check", fullPath], { stdio: "pipe" });
    process.stdout.write(`OK  ${file}\n`);
  } catch (error) {
    hasError = true;
    process.stderr.write(`ERR ${file}\n`);
    if (error?.stderr) process.stderr.write(String(error.stderr));
  }
}

if (hasError) {
  process.exit(1);
}
