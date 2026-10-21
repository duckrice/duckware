// Drives the built launcher over the DevTools protocol: the tiles show which
// apps are installed, and clicking one asks to open it (or its download page).
// Test copies never really start apps or the browser.
//   npm run tauri build -- --no-bundle && npm run smoke [-- --screenshot=file.png]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "src-tauri", "target", "release", "duckware.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), "duckware-smoke-"));
const shot = process.argv.find((a) => a.startsWith("--screenshot="))?.split("=")[1];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
};

async function session(port, env, run) {
  const child = spawn(exe, [], {
    env: { ...process.env, ...env, DUCKWARE_TEST_OFFSCREEN: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, `profile-${port}`) },
    stdio: "ignore",
  });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {
      // Not listening yet.
    }
  }
  if (!target) throw new Error("The launcher did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 1;
  const pending = new Map();
  const ipc = [];
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
    else if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && m.params.request.url.includes("ipc.localhost")) ipc.push([m.params.request.url.split("/").pop(), m.params.request.postData]);
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send("Runtime.enable");
  await send("Network.enable");
  for (let i = 0; i < 40 && !(await evaluate(`document.querySelectorAll(".tile").length === 4`)); i++) await sleep(150);
  try {
    await run({ evaluate, ipc, errors, send });
  } finally {
    ws.close();
    child.kill();
  }
}

// Only DuckWriter "installed": an empty stand-in, as test copies never start it.
const apps = join(work, "apps");
mkdirSync(join(apps, "DuckWriter"), { recursive: true });
writeFileSync(join(apps, "DuckWriter", "duckwriter.exe"), "");

await session(9701, { DUCKWARE_APPS_DIR: apps }, async ({ evaluate, ipc, errors }) => {
  const tiles = await evaluate(`[...document.querySelectorAll(".tile")].map((t) => [t.querySelector("strong").textContent, t.classList.contains("missing")])`);
  check("a tile for each app", JSON.stringify(tiles?.map((t) => t[0])) === JSON.stringify(["DuckWriter", "Duckument", "DuckNotes", "DuckSheets"]), JSON.stringify(tiles));
  check("installed apps open, others offer a download", JSON.stringify(tiles?.map((t) => t[1])) === JSON.stringify([false, true, true, true]), JSON.stringify(tiles));
  await evaluate(`document.querySelectorAll(".tile")[0].click()`);
  await evaluate(`document.querySelectorAll(".tile")[2].click()`);
  await sleep(500);
  const calls = ipc.filter(([cmd]) => cmd !== "installed").map(([cmd, body]) => `${cmd} ${JSON.parse(body).index}`);
  check("clicking DuckWriter opens it, clicking DuckNotes installs it", JSON.stringify(calls) === JSON.stringify(["launch 0", "install 2"]), JSON.stringify(calls));
  check("and its tile is then an app to open", await evaluate(`document.querySelectorAll(".tile")[2].classList.contains("installed")`));
  check("no errors", errors.length === 0, errors.join("; "));
});

// With the apps really installed on this computer, for a picture of it.
if (shot) {
  await session(9702, {}, async ({ send }) => {
    await sleep(500);
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot, Buffer.from(result.data, "base64"));
  });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
