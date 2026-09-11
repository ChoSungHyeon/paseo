import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import pino from "pino";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("metadata and archive cannot overtake the exact-state send lane", async () => {
  let starts = 0;
  const handle = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: () => {
        starts++;
      },
    }),
  });
  const cwd = await mkdtemp(path.join(tmpdir(), "guard-races-"));
  const manager = handle.daemon.agentManager;
  const storage = handle.daemon.agentStorage;
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: undefined,
    });
    await manager.flush();
    const guard = () => ({
      expectedAgentId: agent.id,
      expectedUpdatedAt: manager.getAgent(agent.id)!.updatedAt.toISOString(),
      expectedStatus: "idle" as const,
      expectedArchivedAt: null,
    });
    const send = (expected = guard()) =>
      sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: agent.id,
        prompt: "guarded race",
        guard: expected,
        logger: pino({ level: "silent" }),
      });
    const previous = guard();
    const entered = gate();
    const release = gate();
    const applySnapshot = storage.applySnapshot.bind(storage);
    const spy = vi.spyOn(storage, "applySnapshot").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return applySnapshot(...args);
    });
    const metadata = manager.updateAgentMetadata(agent.id, {
      title: "new title",
      labels: { observed: "new" },
    });
    await entered.promise;
    const rejected = expect(send(previous)).rejects.toThrow("updated_at_mismatch");
    release.resolve();
    await metadata;
    await rejected;
    spy.mockRestore();
    expect(starts).toBe(0);
    expect(Date.parse(guard().expectedUpdatedAt)).toBeGreaterThan(
      Date.parse(previous.expectedUpdatedAt),
    );

    const effectEntered = gate();
    const effectRelease = gate();
    let archived = false;
    const accepted = manager.runGuardedAgentMessageSend(agent.id, guard(), async () => {
      effectEntered.resolve();
      await effectRelease.promise;
      expect((await storage.get(agent.id))?.archivedAt).toBeFalsy();
      return "effect";
    });
    await effectEntered.promise;
    const archive = manager.archiveAgent(agent.id).then(() => {
      archived = true;
      return undefined;
    });
    await Promise.resolve();
    expect(archived).toBe(false);
    effectRelease.resolve();
    await expect(accepted).resolves.toBe("effect");
    await archive;
    const record = await storage.get(agent.id);
    expect(record?.archivedAt).toBeTruthy();
    await expect(send(previous)).rejects.toThrow("archived");
    expect((await storage.get(agent.id))?.archivedAt).toBe(record?.archivedAt);
    expect(starts).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await handle.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
