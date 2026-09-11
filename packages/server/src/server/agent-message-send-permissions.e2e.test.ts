import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { CodexAppServerAgentSession } from "./agent/providers/codex-app-server-agent.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { asInternals } from "./test-utils/class-mocks.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "./agent/agent-prompt.js";

test("guarded and ordinary sends preserve the same restrictive Codex permission request", async () => {
  const logger = pino({ level: "silent" });
  const cwd = await mkdtemp(path.join(tmpdir(), "guard-permissions-"));
  const turns: Record<string, unknown>[] = [];
  const clients = createTestAgentClients();
  let session!: CodexAppServerAgentSession;
  clients.codex.createSession = async (config) => {
    session = new CodexAppServerAgentSession(
      config,
      null,
      logger,
      () => {
        throw new Error("Must not spawn a real provider");
      },
      {},
      false,
      false,
      false,
    );
    const internals = asInternals<{
      connected: boolean;
      currentThreadId: string;
      client: { request: (method: string, params: Record<string, unknown>) => Promise<unknown> };
      handleNotification: (method: string, params: unknown) => void;
    }>(session);
    internals.connected = true;
    internals.currentThreadId = "fixture-thread";
    internals.client = {
      request: async (method, params) => {
        if (method === "turn/start") turns.push(params);
        return {};
      },
    };
    return session;
  };
  const daemon = await createTestPaseoDaemon({ agentClients: clients });
  try {
    const manager = daemon.daemon.agentManager;
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd,
        modeId: "full-access",
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        networkAccess: false,
        webSearch: false,
      },
      undefined,
      { workspaceId: undefined },
    );
    const configBefore = structuredClone(agent.config);
    for (const guarded of [false, true]) {
      const current = manager.getAgent(agent.id)!;
      await sendPromptToAgent({
        agentManager: manager,
        agentStorage: daemon.daemon.agentStorage,
        agentId: agent.id,
        prompt: "check permissions",
        logger,
        ...(guarded
          ? {
              guard: {
                expectedAgentId: agent.id,
                expectedUpdatedAt: current.updatedAt.toISOString(),
                expectedStatus: "idle" as const,
                expectedArchivedAt: null,
              },
            }
          : {}),
      });
      await waitForAgentRunStartWithTimeout(manager, agent.id);
      asInternals<{ handleNotification(method: string, params: unknown): void }>(
        session,
      ).handleNotification("turn/completed", {
        threadId: "fixture-thread",
        turn: { id: "fixture-turn", status: "completed", error: null },
      });
      await expect.poll(() => manager.getAgent(agent.id)?.lifecycle).toBe("idle");
      await expect.poll(() => manager.hasInFlightRun(agent.id)).toBe(false);
    }
    expect(turns[0]).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
    });
    expect(turns[1]).toEqual(turns[0]);
    expect(agent.config).toEqual(configBefore);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
