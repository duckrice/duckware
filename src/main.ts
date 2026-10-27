// The Duckware launcher: one icon on the taskbar, a tile for each app.
// Clicking a tile (or pressing its number) opens it and closes the launcher;
// an app that isn't installed yet is downloaded and installed from its tile,
// and one with a newer release offers the update. Below: recent documents.

import "./styles.css";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./dom";
import { offerUpdate } from "./updates";

const APPS = [
  { name: "DuckWriter", what: "Write documents, open Word files and PDFs", icon: "duckwriter.png", color: "#22d3ee", opens: ["docx", "docm", "dotx", "dotm", "doc", "rtf", "odt"] },
  { name: "Duckument", what: "Sign, fill in and edit PDFs", icon: "duckument.png", color: "#f59e0b", opens: ["pdf"] },
  { name: "DuckNotes", what: "Notes for lectures, with drawing", icon: "ducknotes.png", color: "#a78bfa", opens: [] as string[] },
  { name: "DuckSheets", what: "Spreadsheets, open and save Excel files", icon: "ducksheets.png", color: "#4ade80", opens: ["xlsx", "xlsm", "csv"] },
];

type State = "installed" | "missing" | "installing" | "failed";

interface Recent {
  path: string;
  app: number;
  time: number;
}

const tiles = h("div", { class: "tiles" });
const recentList = h("ul", { class: "recent-list" });
const autostart = h("input", { type: "checkbox" });
const footer = h("footer", {}, h("label", { class: "autostart" }, autostart, "Start with Windows"));
const search = h("input", { type: "search", class: "recent-search", placeholder: "search…", "aria-label": "Search recent documents" }) as HTMLInputElement;
const updateAll = h("button", { type: "button", class: "update-all", hidden: true, onclick: () => void updateEverything() });
document.getElementById("app")!.append(updateAll, tiles, h("section", { class: "recent" }, h("div", { class: "recent-head" }, h("h2", {}, "~/recent"), search), recentList), footer);

let states: State[] = [];
/** Installed versions ("" when unknown), and the latest released ones. */
let versions: (string | null)[] = [];
let latest: (string | null)[] = [];
/** What's new in each latest release, as its update says. */
let notes: string[] = [];
const errors: string[] = [];

/** Whether version a is older than b ("1.2.0" < "1.10.0"). */
function older(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

function updateFor(index: number): string | null {
  const have = versions[index];
  const newest = latest[index];
  return states[index] === "installed" && have && newest && older(have, newest) ? newest : null;
}

function tile(index: number): HTMLElement {
  const { name, what, icon } = APPS[index];
  const state = states[index];
  const update = updateFor(index);
  const text = { installed: what, missing: "Install", installing: versions[index] ? "Updating…" : "Installing…", failed: `${errors[index]} Click for the download page.` }[state];
  const button = h(
    "button",
    {
      type: "button",
      class: `tile ${state}`,
      disabled: state === "installing",
      title: { installed: `Open ${name} (${index + 1})`, missing: `Download and install ${name}`, installing: text, failed: `Open ${name}'s download page` }[state],
      onclick: () => void open(index),
    },
    h("img", { src: icon, alt: "" }),
    h("strong", {}, name),
    h("span", { class: "tile-text" }, text),
    state === "installed" && versions[index] && h("small", { class: "version" }, `v${versions[index]}`),
  );
  const updateButton = update && h("button", { type: "button", class: "update-app", title: `Download and install ${name} ${update}`, onclick: () => void installApp(index) }, `update → v${update}`);
  // What the update brings, unless it only says its own name and version.
  const news = update && notes[index] && !/^\S+ [\d.]+$/.test(notes[index]) ? h("small", { class: "whats-new", title: notes[index] }, `new: ${notes[index]}`) : null;
  return h("div", { class: "tile-wrap", style: `--c: ${APPS[index].color}` }, button, updateButton, news);
}

function show() {
  tiles.replaceChildren(...APPS.map((_, i) => tile(i)));
  const waiting = APPS.map((_, i) => i).filter((i) => updateFor(i));
  updateAll.hidden = waiting.length < 2;
  updateAll.textContent = `update all (${waiting.length}) →`;
}

/** Updates every app that has a newer release, one after another. */
async function updateEverything() {
  for (const i of APPS.map((_, i) => i).filter((i) => updateFor(i))) await installApp(i);
}

// ---- recent documents: pinned ones first, and a search box ----
let recentFiles: Recent[] = [];
const PINS = "duckware.pinned";
const pinned = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(PINS) ?? "[]");
  } catch {
    return [];
  }
};
function togglePin(path: string) {
  const now = pinned();
  try {
    localStorage.setItem(PINS, JSON.stringify(now.includes(path) ? now.filter((p) => p !== path) : [...now, path]));
  } catch {
    // Without storage, pins just don't stick.
  }
  showRecent(recentFiles);
}

function showRecent(all: Recent[]) {
  recentFiles = all;
  const pins = pinned();
  const query = search.value.trim().toLowerCase();
  const recent = all.filter((r) => !query || r.path.toLowerCase().includes(query)).sort((a, b) => Number(pins.includes(b.path)) - Number(pins.includes(a.path)));
  const when = (time: number) => {
    const date = new Date(time);
    return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString();
  };
  recentList.replaceChildren(
    ...recent.map(({ path, app, time }) => {
      const cut = path.lastIndexOf("\\");
      return h(
        "li",
        {},
        h(
          "button",
          { type: "button", class: "recent-file", title: `Open in ${APPS[app].name}: ${path}`, onclick: () => void invoke("launch", { index: app, file: path }).catch(console.error) },
          h("img", { src: APPS[app].icon, alt: APPS[app].name }),
          h("span", { class: "file-name" }, path.slice(cut + 1)),
          h("span", { class: "file-folder" }, path.slice(0, cut)),
          h("span", { class: "file-time" }, when(time)),
        ),
        h("button", { type: "button", class: `pin${pins.includes(path) ? " on" : ""}`, title: pins.includes(path) ? "Unpin" : "Pin to the top", "aria-label": pins.includes(path) ? "Unpin" : "Pin to the top", onclick: () => togglePin(path) }, pins.includes(path) ? "★" : "☆"),
      );
    }),
  );
  if (!recent.length) recentList.append(h("li", { class: "empty" }, query ? "Nothing matches." : "Documents you open in Word, Excel, PDF readers or Duckware show up here."));
}

async function open(index: number) {
  const state = states[index];
  if (state === "installing") return;
  try {
    if (state === "installed") await invoke("launch", { index });
    else if (state === "failed") await invoke("download", { index });
    else await installApp(index);
  } catch (error) {
    console.error(error);
  }
}

/** Installs a missing app, or updates an installed one, from its latest release. */
async function installApp(index: number) {
  states[index] = "installing";
  show();
  try {
    await invoke("install", { index });
    // What was installed is the latest release (if the lookup found it).
    states[index] = "installed";
    versions[index] = latest[index] ?? "";
  } catch (error) {
    states[index] = "failed";
    errors[index] = String(error);
  }
  show();
}

async function start() {
  versions = await invoke<(string | null)[]>("apps");
  states = versions.map((v) => (v === null ? "missing" : "installed"));
  show();
  tiles.querySelector<HTMLButtonElement>(".tile.installed")?.focus();
  search.addEventListener("input", () => showRecent(recentFiles));
  // A document dropped on the launcher opens in the app for it.
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    for (const file of event.payload.paths) {
      const ext = file.split(".").pop()?.toLowerCase() ?? "";
      const app = APPS.findIndex((a) => a.opens.includes(ext));
      if (app >= 0 && states[app] === "installed") void invoke("launch", { index: app, file }).catch(console.error);
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.target === search) return;
    const n = Number(event.key);
    if (n >= 1 && n <= APPS.length) void open(n - 1);
    else if (event.key === "Escape") void getCurrentWindow().close();
  });

  autostart.checked = await invoke<boolean>("autostart", {});
  autostart.addEventListener("change", async () => {
    try {
      autostart.checked = await invoke<boolean>("autostart", { on: autostart.checked });
    } catch (error) {
      autostart.checked = !autostart.checked;
      console.error(error);
    }
  });
  footer.append(h("span", { class: "launcher-version" }, `duckware v${await getVersion()}`));

  // These go online or look through Windows' recent files: show the tiles first.
  void invoke<Recent[]>("recent").then(showRecent);
  void invoke<([string, string] | null)[]>("latest").then((found) => {
    latest = found.map((f) => f?.[0] ?? null);
    notes = found.map((f) => f?.[1] ?? "");
    show();
  });
  void offerUpdate(footer, { beforeInstall: async () => true });
}

void start();
