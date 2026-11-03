// Writes latest.json, the file installed copies of Duckware read to find out
// whether there is a newer version, and where and how to verify it.
//   node scripts/update-manifest.mjs <installer.sig> <download url> <out file> [platform]
// The platform is windows-x86_64 unless given (linux-x86_64 for the AppImage); an existing
// out file for the same version keeps its other platforms, so one file serves both systems.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [signatureFile, url, out, platform = "windows-x86_64"] = process.argv.slice(2);
if (!signatureFile || !url || !out) {
  console.error("usage: node scripts/update-manifest.mjs <installer.exe.sig> <download url> <out file>");
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

/** What's new, for the update offer: the release commit's first line, without "Duckware 1.2.3: " in front. */
function whatsNew() {
  try {
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, encoding: "utf8" }).trim();
    const text = subject.replace(/^Duckware \d+\.\d+\.\d+:?\s*/i, "");
    if (text) return text[0].toUpperCase() + text.slice(1);
  } catch {
    // Not a git checkout: just the version.
  }
  return `Duckware ${version}`;
}

const earlier = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const manifest = {
  version,
  notes: whatsNew(),
  pub_date: new Date().toISOString(),
  platforms: {
    ...(earlier?.version === version ? earlier.platforms : {}),
    [platform]: {
      signature: readFileSync(signatureFile, "utf8").trim(),
      url,
    },
  },
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${out} for version ${version}`);
