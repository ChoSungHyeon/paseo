import { expect, type Page, type TestInfo } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace, waitForTabBar } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

async function breakWorkspaceLayout(page: Page, workspaceId: string) {
  const workspaceKey = `${getServerId()}:${workspaceId}`;
  await page.evaluate(
    ({ key, workspaceId: failingWorkspaceId }) => {
      // Inject a render failure without a production crash switch or changing stored data.
      const metro = Reflect.get(globalThis, "__r");
      const modules = metro.getModules() as Map<number, { verboseName?: string }>;
      const entry = [...modules].find(([, module]) =>
        module.verboseName?.endsWith("/stores/workspace-layout-store.ts"),
      );
      if (!entry) throw new Error("Workspace layout module is not loaded");
      const store = metro(entry[0]).useWorkspaceLayoutStore;
      const state = store.getState();
      const layout = state.layoutByWorkspace[key];
      const originalRoot = layout.root;
      Object.defineProperty(layout, "root", {
        get() {
          if (window.location.href.includes(failingWorkspaceId)) {
            throw new Error("Workspace layout recovery regression");
          }
          return originalRoot;
        },
      });
      try {
        store.setState({ layoutByWorkspace: { ...state.layoutByWorkspace } });
      } catch (error) {
        // Persistence also reads the poisoned layout after notifying React subscribers.
        if (!(error instanceof Error) || error.message !== "Workspace layout recovery regression") {
          throw error;
        }
      }
    },
    { key: workspaceKey, workspaceId },
  );
  await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toBeVisible();
}

async function reloadFromError(page: Page) {
  await page.getByRole("button", { name: "Reload", exact: true }).click();
}

async function captureRecoveryScreen(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("Reload escapes a broken workspace without deleting saved layouts", async ({
  page,
}, testInfo) => {
  const broken = await seedWorkspace({ repoPrefix: "recovery-broken-", title: "Broken workspace" });
  const healthy = await seedWorkspace({
    repoPrefix: "recovery-healthy-",
    title: "Healthy workspace",
  });
  try {
    await gotoWorkspace(page, broken.workspaceId);
    const savedLayout = await page.evaluate(() => localStorage.getItem("workspace-layout-state"));
    const rememberedWorkspace = await page.evaluate(() =>
      localStorage.getItem("paseo:last-workspace-route-selection"),
    );
    expect(savedLayout).not.toBeNull();
    expect(rememberedWorkspace).not.toBeNull();
    await breakWorkspaceLayout(page, broken.workspaceId);
    await captureRecoveryScreen(page, testInfo, "error-screen");
    await reloadFromError(page);
    await expect(page).toHaveURL(/\/open-project$/);
    await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
    await captureRecoveryScreen(page, testInfo, "recovered-picker");
    expect(await page.evaluate(() => localStorage.getItem("workspace-layout-state"))).toBe(
      savedLayout,
    );
    expect(
      await page.evaluate(() => localStorage.getItem("paseo:last-workspace-route-selection")),
    ).toBe(rememberedWorkspace);
    await page.getByRole("button", { name: healthy.workspaceName, exact: true }).click();
    await waitForTabBar(page);
    await breakWorkspaceLayout(page, healthy.workspaceId);
    await reloadFromError(page);
    await expect(page).toHaveURL(/\/open-project$/);
    await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
  } finally {
    await broken.cleanup();
    await healthy.cleanup();
  }
});

test.describe("compact error recovery", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Reload remains reachable and returns to the picker", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "recovery-compact-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await breakWorkspaceLayout(page, workspace.workspaceId);
      await captureRecoveryScreen(page, testInfo, "compact-error-screen");
      await reloadFromError(page);
      await expect(page).toHaveURL(/\/open-project$/);
      await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
      await captureRecoveryScreen(page, testInfo, "compact-recovered-picker");
    } finally {
      await workspace.cleanup();
    }
  });
});
