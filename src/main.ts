// The Duckware launcher: one icon on the taskbar, a tile for each app.
// Clicking a tile (or pressing its number) opens it and closes the launcher.

import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const APPS = [
  { name: "DuckWriter", what: "Write documents, open Word files and PDFs", icon: "duckwriter.svg" },
  { name: "Duckument", what: "Sign, fill in and edit PDFs", icon: "duckument.svg" },
  { name: "DuckNotes", what: "Notes for lectures, with drawing", icon: "ducknotes.svg" },
  { name: "DuckSheets", what: "Spreadsheets, open and save Excel files", icon: "ducksheets.svg" },
];

const app = document.getElementById("app")!;

function tile(index: number, installed: boolean): HTMLButtonElement {
  const { name, what, icon } = APPS[index];
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tile${installed ? "" : " missing"}`;
  button.title = installed ? `Open ${name} (${index + 1})` : `${name} isn't installed: download it`;
  const img = document.createElement("img");
  img.src = icon;
  img.alt = "";
  const title = document.createElement("strong");
  title.textContent = name;
  const text = document.createElement("span");
  text.textContent = installed ? what : "Get it";
  button.append(img, title, text);
  button.addEventListener("click", () => void open(index, installed));
  return button;
}

async function open(index: number, installed: boolean) {
  try {
    await invoke(installed ? "launch" : "download", { index });
  } catch (error) {
    console.error(error);
  }
}

async function start() {
  const installed = await invoke<boolean[]>("installed");
  app.replaceChildren(...APPS.map((_, i) => tile(i, installed[i])));
  app.querySelector<HTMLButtonElement>(".tile:not(.missing)")?.focus();
  window.addEventListener("keydown", (event) => {
    const n = Number(event.key);
    if (n >= 1 && n <= APPS.length) void open(n - 1, installed[n - 1]);
    else if (event.key === "Escape") void getCurrentWindow().close();
  });
}

void start();
