const { spawn } = require("node:child_process");
const net = require("node:net");

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = Number(address?.port || 0);
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 12000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${url}: ${lastError?.message || "unreachable"}`);
}

function startNodeService({ cwd, script = "server.js", env = {} }) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  async function stop() {
    if (child.exitCode != null || child.killed) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_error) {}
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch (_error) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  return {
    child,
    stop,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

module.exports = {
  findFreePort,
  waitForHttp,
  startNodeService,
  readJson,
};
