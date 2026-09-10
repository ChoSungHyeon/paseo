// Run with the repository Electron after npm run build:main.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app, BrowserWindow, nativeImage } = require("electron");
const { preparePaseoBrowserWebContents } = require("../dist/features/browser-webviews/index.js");
const { adaptWebContents } = require("../dist/features/browser-automation/ipc.js");
const { executeAutomationCommand } = require("../dist/features/browser-automation/service.js");

const output =
  process.env.PASEO_BROWSER_THROTTLING_ARTIFACT_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), "paseo-browser-throttling-"));
fs.mkdirSync(output, { recursive: true });
const profile = process.env.PASEO_BROWSER_THROTTLING_PROFILE_DIR;
assert.ok(profile, "Run through test:e2e:browser-throttling so the launcher owns profile cleanup");
app.setPath("userData", profile);
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const measurements = [];
// The existing full-page repetition bug (#3196) is independently reproducible.
// Keep its strict pixel assertion available without conflating it with throttling.
const captureModes = process.argv.includes("--full-page") ? [false, true] : [false];

function pageUrl(html) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

async function openParkedBrowser() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    skipTaskbar: true,
    webPreferences: { webviewTag: true },
  });
  const attached = new Promise((resolve) =>
    win.webContents.once("did-attach-webview", (_event, guest) => {
      preparePaseoBrowserWebContents(guest);
      resolve(guest);
    }),
  );
  await win.loadURL(
    pageUrl(
      '<div id="parking" style="position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:1;pointer-events:none"></div>',
    ),
  );
  const url = pageUrl(
    `<style>html,body{margin:0;width:640px}section{height:480px}#top{background:rgb(255,0,0)}#bottom{background:rgb(0,0,255)}</style><section id="top">TOP</section><section id="bottom">BOTTOM</section><script>window.frameCount=0;function tick(){window.frameCount++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`,
  );
  await win.webContents.executeJavaScript(
    `new Promise(resolve => { const view = document.createElement('webview'); view.addEventListener('dom-ready', () => resolve(), { once: true }); view.style.cssText='display:inline-flex;width:640px;height:480px'; view.src=${JSON.stringify(url)}; document.getElementById('parking').appendChild(view); })`,
  );
  const guest = await attached;
  win.showInactive();
  return { win, guest };
}

async function expectBrowserToAnimate(guest) {
  const start = await guest.executeJavaScript("window.frameCount");
  assert.equal(typeof start, "number", "Animation fixture must be loaded before sampling");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await guest.executeJavaScript("window.frameCount")) > start + 2) return;
    await delay(50);
  }
  assert.fail("Browser did not resume animation after restoring the window");
}

async function expectHiddenBrowserToIdle(win, guest, label) {
  win.hide();
  await delay(500); // Allow the compositor to consume the visibility change before sampling.
  const start = await guest.executeJavaScript("window.frameCount");
  await delay(1000); // Measure a fixed interval; this is the behavior under test.
  const frames = (await guest.executeJavaScript("window.frameCount")) - start;
  measurements.push({ label, frames, backgroundThrottling: guest.getBackgroundThrottling() });
  fs.writeFileSync(path.join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
  assert.equal(frames, 0, `${label}: hidden browser continues animating`);
}

function browserRegistry(guest) {
  const contents = adaptWebContents(guest);
  return {
    getTabContents: () => contents,
    getBrowserWorkspaceId: () => "fixture",
    listRegisteredBrowserIds: () => ["preview"],
    listRegisteredBrowserIdsForWorkspace: () => ["preview"],
    getWorkspaceActiveBrowserId: () => "preview",
  };
}

function expectPixel(image, x, y, rgb) {
  const { width } = image.getSize();
  const offset = (y * width + x) * 4;
  const bitmap = image.toBitmap();
  assert.deepEqual(
    [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]],
    rgb,
    `Incorrect page content at ${x},${y}`,
  );
}

async function expectFreshScreenshots(guest, label) {
  // Mutate while backgrounded: successful capture must show fresh pixels, not a cached frame.
  await guest.executeJavaScript("document.getElementById('top').style.background='rgb(0,255,0)'");
  for (const fullPage of captureModes) {
    const response = await executeAutomationCommand(
      {
        requestId: label,
        workspaceId: "fixture",
        command: { command: "screenshot", args: { browserId: "preview", fullPage } },
      },
      browserRegistry(guest),
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    const image = nativeImage.createFromBuffer(Buffer.from(response.result.dataBase64, "base64"));
    fs.writeFileSync(
      path.join(output, `${label}-${fullPage ? "full-page" : "viewport"}.png`),
      image.toPNG(),
    );
    assert.deepEqual(image.getSize(), { width: 640, height: fullPage ? 960 : 480 });
    expectPixel(image, 320, 240, [0, 255, 0]);
    if (fullPage) expectPixel(image, 320, 720, [0, 0, 255]);
  }
  await guest.executeJavaScript("document.getElementById('top').style.background='rgb(255,0,0)'");
}

async function verifyBrowserLifecycle() {
  const { win, guest } = await openParkedBrowser();
  try {
    await expectBrowserToAnimate(guest);
    await expectHiddenBrowserToIdle(win, guest, "before-capture");
    await expectFreshScreenshots(guest, "hidden");
    await expectHiddenBrowserToIdle(win, guest, "after-capture");
    win.showInactive();
    await expectBrowserToAnimate(guest);
    await expectFreshScreenshots(guest, "parked");
    const destroyed = new Promise((resolve) => guest.once("destroyed", resolve));
    await win.webContents.executeJavaScript("document.querySelector('webview').remove()");
    await destroyed;
    console.log(
      `PASS hidden browser idles; fresh screenshot pixels; restore and close. Artifacts: ${output}`,
    );
  } finally {
    win.destroy();
  }
}

setTimeout(() => {
  console.error("Browser throttling regression timed out");
  app.exit(1);
}, 30000);
app
  .whenReady()
  .then(verifyBrowserLifecycle)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
