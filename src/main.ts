// The Duckware launcher: one icon on the taskbar, a tile for each app.
// Clicking a tile (or pressing its number) opens it and closes the launcher;
// an app that isn't installed yet is downloaded and installed from its tile.

import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const APPS = [
  { name: "DuckWriter", what: "Write documents, open Word files and PDFs", icon: "duckwriter.svg" },
  { name: "Duckument", what: "Sign, fill in and edit PDFs", icon: "duckument.svg" },
  { name: "DuckNotes", what: "Notes for lectures, with drawing", icon: "ducknotes.svg" },
  { name: "DuckSheets", what: "Spreadsheets, open and save Excel files", icon: "ducksheets.svg" },
];

type State = "installed" | "missing" | "installing" | "failed";

const app = document.getElementById("app")!;
let states: State[] = [];

function tile(index: number): HTMLButtonElement {
  const { name, what, icon } = APPS[index];
  const state = states[index];
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tile ${state}`;
  button.disabled = state === "installing";
  button.title = { installed: `Open ${name} (${index + 1})`, missing: `Download and install ${name}`, installing: `Installing ${name}…`, failed: `Open ${name}'s download page` }[state];
  const img = document.createElement("img");
  img.src = icon;
  img.alt = "";
  const title = document.createElement("strong");
  title.textContent = name;
  const text = document.createElement("span");
  text.className = "tile-text";
  text.textContent = { installed: what, missing: "Install", installing: "Installing…", failed: button.dataset.error ?? "" }[state];
  button.append(img, title, text);
  button.addEventListener("click", () => void open(index));
  return button;
}

function show() {
  app.replaceChildren(...APPS.map((_, i) => tile(i)));
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

async function installApp(index: number) {
  states[index] = "installing";
  show();
  try {
    await invoke("install", { index });
    states = (await invoke<boolean[]>("installed")).map((yes) => (yes ? "installed" : "missing"));
    // Installed in the test copy only as far as the request goes; elsewhere it's there now.
    if (states[index] !== "installed") states[index] = "installed";
    show();
  } catch (error) {
    states[index] = "failed";
    show();
    const text = app.children[index]?.querySelector(".tile-text");
    if (text) text.textContent = `${String(error)} Click for the download page.`;
  }
}

async function start() {
  states = (await invoke<boolean[]>("installed")).map((yes) => (yes ? "installed" : "missing"));
  show();
  app.querySelector<HTMLButtonElement>(".tile.installed")?.focus();
  window.addEventListener("keydown", (event) => {
    const n = Number(event.key);
    if (n >= 1 && n <= APPS.length) void open(n - 1);
    else if (event.key === "Escape") void getCurrentWindow().close();
  });
}

void start();
