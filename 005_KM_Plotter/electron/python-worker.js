// One owned, pipe-only Python worker per app session; no HTTP server or host installs.
const { spawn } = require("child_process");
const readline = require("readline");

function createPythonWorker(python, script, { timeoutMs = 180000 } = {}) {
  let child = null;
  let sequence = 0;
  const pending = new Map();
  function fail(message) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, error: message });
    }
    pending.clear();
  }
  function stop(message = "The analysis worker was stopped.") {
    const owned = child;
    child = null;
    if (owned) { owned.stdin.end(); owned.kill(); }
    fail(message);
  }
  function start() {
    if (child) return child;
    const owned = spawn(python, [script, "--serve"], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = owned;
    let stderr = "";
    owned.stderr.on("data", c => { stderr = (stderr + c.toString()).slice(-8000); });
    readline.createInterface({ input: owned.stdout }).on("line", line => {
      try {
        const reply = JSON.parse(line);
        const item = pending.get(reply.id);
        if (!item) return;
        clearTimeout(item.timer); pending.delete(reply.id); item.resolve(reply.result);
      } catch { /* Non-protocol stdout cannot satisfy a request. */ }
    });
    owned.stdin.on("error", error => { if (child === owned) fail(error.message); });
    owned.on("error", error => { if (child === owned) { child = null; fail(`Could not start Python: ${error.message}`); } });
    owned.on("close", () => { if (child === owned) { child = null; fail(stderr.trim() || "The analysis worker exited."); } });
    return owned;
  }
  function run(job) {
    return new Promise(resolve => {
      const owned = start();
      const id = ++sequence;
      const timer = setTimeout(() => { stop("The analysis timed out. Try fewer grouping variables or a smaller input."); }, timeoutMs);
      pending.set(id, { resolve, timer });
      owned.stdin.write(JSON.stringify({ id, job }) + "\n");
    });
  }
  return { run, stop, get pid() { return child?.pid ?? null; } };
}
module.exports = { createPythonWorker };
