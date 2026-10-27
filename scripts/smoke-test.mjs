// Drives the built launcher over the DevTools protocol: the tiles show which
// apps are installed and their versions, clicking one opens or installs it,
// updates and recent documents are offered, and Start with Windows works.
// Test copies never really start apps or the browser.
//   npm run tauri build -- --no-bundle && npm run smoke [-- --screenshot=file.png]
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
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

// Only DuckWriter "installed": the launcher stands in (test copies never start
// apps), so it has the launcher's version, older than the "latest" one below.
const apps = join(work, "apps");
mkdirSync(join(apps, "DuckWriter"), { recursive: true });
copyFileSync(exe, join(apps, "DuckWriter", "duckwriter.exe"));
mkdirSync(join(apps, "DuckSheets"), { recursive: true });
copyFileSync(exe, join(apps, "DuckSheets", "ducksheets.exe"));
const sheet = join(work, "Budget.xlsx");
writeFileSync(sheet, "");
// Recent files: one to show, one that's gone, one no app opens.
const doc = join(work, "Lecture notes.docx");
writeFileSync(doc, "");
writeFileSync(join(work, "notes.txt"), "");
const recent = [`1700000000000|${doc}`, `1650000000000|${sheet}`, `1600000000000|${join(work, "gone.docx")}`, `1500000000000|${join(work, "notes.txt")}`].join("\n");
const env = { DUCKWARE_APPS_DIR: apps, DUCKWARE_TEST_LATEST: "99.0.0,99.0.0,,99.0.0", DUCKWARE_TEST_RECENT: recent };
// Test copies keep "start with Windows" in a key of their own.
const testRun = "HKCU\\Software\\Duckware\\TestRun";
const registered = () => spawnSync("reg", ["query", testRun, "/v", "Duckware"], { stdio: "ignore" }).status === 0;
const clearRun = () => spawnSync("reg", ["delete", "HKCU\\Software\\Duckware", "/f"], { stdio: "ignore" });
clearRun();

await session(9701, env, async ({ evaluate, ipc, errors }) => {
  const tiles = await evaluate(`[...document.querySelectorAll(".tile")].map((t) => [t.querySelector("strong").textContent, t.classList.contains("missing")])`);
  check("a tile for each app", JSON.stringify(tiles?.map((t) => t[0])) === JSON.stringify(["DuckWriter", "Duckument", "DuckNotes", "DuckSheets"]), JSON.stringify(tiles));
  check("installed apps open, others offer a download", JSON.stringify(tiles?.map((t) => t[1])) === JSON.stringify([false, true, true, false]), JSON.stringify(tiles));
  for (let i = 0; i < 40 && !(await evaluate(`!!(document.querySelector(".update-app") && document.querySelector(".recent-file"))`)); i++) await sleep(150);
  const version = await evaluate(`document.querySelector(".tile .version")?.textContent`);
  check("an installed app shows its version", /^v\d+\.\d+\.\d+$/.test(version ?? ""), version);
  const badges = await evaluate(`[...document.querySelectorAll(".tile-wrap")].map((w) => w.querySelector(".update-app")?.textContent ?? "")`);
  check("and offers its update; apps not installed don't", JSON.stringify(badges) === JSON.stringify(["update → v99.0.0", "", "", "update → v99.0.0"]), JSON.stringify(badges));
  const files = await evaluate(`[...document.querySelectorAll(".recent-file")].map((b) => [b.querySelector(".file-name").textContent, b.querySelector("img").alt])`);
  check("recent documents: only ones that exist and an app opens", JSON.stringify(files) === JSON.stringify([["Lecture notes.docx", "DuckWriter"], ["Budget.xlsx", "DuckSheets"]]), JSON.stringify(files));

  check("two updates waiting: an update-all button", (await evaluate(`document.querySelector(".update-all").hidden ? "" : document.querySelector(".update-all").textContent`)) === "update all (2) →");
  const names = () => evaluate(`[...document.querySelectorAll(".recent-file .file-name")].map((n) => n.textContent).join()`);
  await evaluate(`document.querySelectorAll(".pin")[1].click()`);
  check("a pinned document goes to the top", (await names()) === "Budget.xlsx,Lecture notes.docx", await names());
  await evaluate(`(() => { const s = document.querySelector(".recent-search"); s.value = "lect"; s.dispatchEvent(new Event("input")); })()`);
  check("search filters recent documents", (await names()) === "Lecture notes.docx", await names());
  await evaluate(`(() => { const s = document.querySelector(".recent-search"); s.value = ""; s.dispatchEvent(new Event("input")); })()`);
  await evaluate(`document.querySelectorAll(".pin")[0].click()`);
  check("and unpinning puts it back", (await names()) === "Lecture notes.docx,Budget.xlsx", await names());

  const calls = () => ipc.filter(([cmd]) => cmd === "launch" || cmd === "install").map(([cmd, body]) => [cmd, JSON.parse(body)]);
  await evaluate(`document.querySelectorAll(".tile")[0].click()`);
  await evaluate(`document.querySelectorAll(".tile")[2].click()`);
  await evaluate(`document.querySelector(".recent-file").click()`);
  await sleep(500);
  const made = calls().map(([cmd, args]) => `${cmd} ${args.index}${args.file ? " " + args.file : ""}`);
  check("clicking DuckWriter opens it, DuckNotes installs it, a recent file opens in its app", JSON.stringify(made) === JSON.stringify(["launch 0", "install 2", `launch 0 ${doc}`]), JSON.stringify(made));
  check("and DuckNotes' tile is then an app to open", await evaluate(`document.querySelectorAll(".tile")[2].classList.contains("installed")`));

  await evaluate(`document.querySelector(".update-app").click()`);
  for (let i = 0; i < 40 && (await evaluate(`!!document.querySelector(".tile.installing")`)); i++) await sleep(150);
  check("the update button installs the latest release", JSON.stringify(calls().at(-1)) === JSON.stringify(["install", { index: 0 }]), JSON.stringify(calls().at(-1)));
  const after = await evaluate(`[document.querySelector(".tile .version")?.textContent, document.querySelectorAll(".update-app").length].join()`);
  check("and the tile then has that version", after === "v99.0.0,1", after);
  check("one update left: no update-all button", await evaluate(`document.querySelector(".update-all").hidden`));

  const box = `document.querySelector(".autostart input")`;
  check("not started with Windows at first", (await evaluate(`${box}.checked`)) === false);
  await evaluate(`${box}.click()`);
  for (let i = 0; i < 40 && !(registered() && (await evaluate(`${box}.checked`))); i++) await sleep(150);
  const ticked = [registered(), await evaluate(`${box}.checked`)].join();
  check("ticking Start with Windows registers the launcher", ticked === "true,true", ticked);
  await evaluate(`${box}.click()`);
  for (let i = 0; i < 40 && (registered() || (await evaluate(`${box}.checked`))); i++) await sleep(150);
  const unticked = [registered(), await evaluate(`${box}.checked`)].join();
  check("and unticking removes it", unticked === "false,false", unticked);
  check("no errors", errors.length === 0, errors.join("; "));
});

clearRun();

// With the apps really installed on this computer, for a picture of it.
if (shot) {
  await session(9702, {}, async ({ send, evaluate }) => {
    // Recent files and the latest versions take a few seconds to look up.
    for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector(".recent-file")`)); i++) await sleep(150);
    await sleep(4000);
    const { result } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot, Buffer.from(result.data, "base64"));
  });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
