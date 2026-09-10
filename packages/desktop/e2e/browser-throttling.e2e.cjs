const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const electron = require("electron");

// Chromium can recreate profile files during shutdown. The parent owns cleanup
// after Electron exits, including failed assertions and capture timeouts.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-browser-throttling-profile-"));
try {
  const result = spawnSync(
    electron,
    [
      "--no-sandbox",
      path.join(__dirname, "browser-throttling.electron.cjs"),
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, PASEO_BROWSER_THROTTLING_PROFILE_DIR: profile },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
