// Checks GitHub for a newer Duckware and offers to install it. Updates are
// signed; the updater refuses anything not signed with Duckware's key.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { h } from "./dom";


export interface UpdateHooks {
  /** Gives the user a chance to save; resolves to false to call the update off. */
  beforeInstall(): Promise<boolean>;
}

/** Looks for an update and, if there is one, shows a bar offering it. Never throws. */
export async function offerUpdate(host: HTMLElement, hooks: UpdateHooks) {
  let update: Update | null;
  try {
    update = await check({ timeout: 20_000 });
  } catch (error) {
    // Offline, GitHub unreachable, or no release yet: try again next start.
    console.warn("Could not check for updates", error);
    return;
  }
  if (!update) return;

  const message = h("span", { class: "update-message" }, `Duckware ${update.version} is available.`);
  const install = h("button", { type: "button", class: "btn primary small" }, "Update and restart");
  const later = h("button", { type: "button", class: "btn subtle" }, "Later");
  const bar = h("div", { class: "update-bar", role: "status" }, message, install, later);
  later.addEventListener("click", () => bar.remove());
  install.addEventListener("click", () => void run());
  host.append(bar);

  async function run() {
    if (!(await hooks.beforeInstall())) return;
    install.disabled = later.disabled = true;
    let total = 0;
    let received = 0;
    message.textContent = "Downloading the update…";
    try {
      await update!.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total) message.textContent = `Downloading the update… ${Math.round((received / total) * 100)}%`;
        } else message.textContent = "Installing…";
      });
      // On Windows the installer closes Duckware and opens the new version itself;
      // this is only reached where that doesn't happen.
      await relaunch();
    } catch (error) {
      console.error("Update failed", error);
      // A failed signature check means the download is not a genuine Duckware update.
      message.textContent = /signature/i.test(String(error))
        ? "The update was not installed: it failed Duckware's safety check. Nothing was changed."
        : "The update could not be downloaded. Check your internet connection and try again.";
      install.disabled = later.disabled = false;
      install.textContent = "Try again";
    }
  }
}
