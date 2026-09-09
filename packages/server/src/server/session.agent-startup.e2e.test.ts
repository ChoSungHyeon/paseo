import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";

const Envelope = z.object({
  type: z.literal("session"),
  message: z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) }),
});

function exchange(
  socket: WebSocket,
  frame: unknown,
  accepts: (type: string, payload: Record<string, unknown>) => boolean,
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Daemon response missing"));
    }, 10_000);
    const receive = (data: WebSocket.RawData) => {
      const parsed = Envelope.safeParse(JSON.parse(data.toString()));
      if (parsed.success && accepts(parsed.data.message.type, parsed.data.message.payload)) {
        cleanup();
        resolve(parsed.data.message.payload);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", receive);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify(frame));
  });
}
function request(socket: WebSocket, message: Record<string, unknown>) {
  const requestId = randomUUID();
  return exchange(
    socket,
    { type: "session", message: { ...message, requestId } },
    (_type, payload) => payload["requestId"] === requestId,
  );
}
async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const info = await exchange(
    socket,
    { type: "hello", clientId: randomUUID(), clientType: "browser", protocolVersion: 1 },
    (_type, payload) => payload["status"] === "server_info",
  );
  expect(info["features"]).toMatchObject({ agentRequestCancellation: true });
  return socket;
}

test("socket cancellation settles a held create, disposes its late provider session, and fences a reconnect replay", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let creates = 0;
  let closes = 0;
  const provider = createTestAgentClient("codex", {
    beforeCreateSession: async () => {
      creates++;
      started();
      await gate;
    },
    closeSession: async () => {
      closes++;
    },
  });
  const host = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  let socket = await connect(host.port);
  const key = randomUUID();
  const creationKey = randomUUID();
  const config = { provider: "codex", cwd: host.paseoHome };
  const operation = { key, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  try {
    const unkeyed = await request(socket, {
      type: "create_agent_request",
      config,
      operation,
      initialPrompt: "must not launch",
    });
    expect(unkeyed).toMatchObject({ status: "agent_create_failed" });
    expect(creates).toBe(0);
    const creation = request(socket, {
      type: "create_agent_request",
      config,
      idempotencyKey: creationKey,
      operation,
    });
    await entered;
    const canceled = await request(socket, {
      type: "agent.requests.cancel.request",
      key,
      creationKey,
    });
    expect(["pending", "settled"]).toContain(canceled["outcome"]);
    expect(await creation).not.toMatchObject({ status: "agent_created" });
    release();
    await expect.poll(() => closes).toBe(1);
    await expect
      .poll(() => request(socket, { type: "agent.requests.inspect.request", key, creationKey }))
      .toMatchObject({ outcome: "settled", agentId: null });
    expect(host.daemon.agentManager.listAgents()).toEqual([]);

    socket.close();
    socket = await connect(host.port);
    const replay = await request(socket, {
      type: "create_agent_request",
      config,
      idempotencyKey: creationKey,
      operation,
    });
    expect(replay).not.toMatchObject({ status: "agent_created" });
    expect(creates).toBe(1);
    const next = await request(socket, {
      type: "create_agent_request",
      config,
      idempotencyKey: creationKey,
      operation: { ...operation, key: randomUUID() },
    });
    expect(next).toMatchObject({ status: "agent_created" });
    const repeated = await request(socket, {
      type: "create_agent_request",
      config,
      idempotencyKey: creationKey,
      operation: { ...operation, key: randomUUID() },
    });
    expect(repeated["agentId"]).toBe(next["agentId"]);
    expect(creates).toBe(2);
    expect(host.daemon.agentManager.listAgents()).toHaveLength(1);
  } finally {
    release();
    socket.close();
    await host.close();
  }
}, 30_000);

test("expiry during provider send settles the socket caller and retains cleanup ownership until cancellation finishes", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let turns = 0;
  const provider = createTestAgentClient("codex", {
    beforeStartTurn: async () => {
      entered();
      await gate;
    },
    onStartTurn: () => {
      turns++;
    },
  });
  const host = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  const socket = await connect(host.port);
  const creationKey = randomUUID();
  const key = randomUUID();
  try {
    const created = await request(socket, {
      type: "create_agent_request",
      config: { provider: "codex", cwd: host.paseoHome },
      idempotencyKey: creationKey,
    });
    const agentId = z.string().parse(created["agentId"]);
    const messageId = randomUUID();
    const operation = { key, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    const sending = request(socket, {
      type: "send_agent_message_request",
      agentId,
      messageId,
      text: "hello",
      operation,
    });
    await started;
    await request(socket, { type: "agent.requests.cancel.request", key, creationKey });
    expect(await sending).not.toMatchObject({ accepted: true });
    // The provider has not acknowledged start. Cancellation cannot claim this work settled yet.
    expect(
      await request(socket, { type: "agent.requests.inspect.request", key, creationKey }),
    ).toMatchObject({ outcome: "pending", agentId });
    release();
    await expect
      .poll(() => request(socket, { type: "agent.requests.inspect.request", key, creationKey }))
      .toMatchObject({ outcome: "settled", agentId });
    expect(host.daemon.agentManager.hasInFlightRun(agentId)).toBe(false);
    await request(socket, {
      type: "send_agent_message_request",
      agentId,
      messageId,
      text: "hello",
      operation,
    });
    expect(turns).toBe(1);
    const next = await request(socket, {
      type: "send_agent_message_request",
      agentId,
      messageId: randomUUID(),
      text: "next",
      operation: { ...operation, key: randomUUID() },
    });
    expect(next).toMatchObject({ accepted: true });
    expect(turns).toBe(2);
  } finally {
    release();
    socket.close();
    await host.close();
  }
}, 30_000);

test("a delayed duplicate archive acknowledgement cannot archive a restored continuation again", async () => {
  const host = await createTestPaseoDaemon({
    agentClients: { codex: createTestAgentClient("codex") },
  });
  const socket = await connect(host.port);
  try {
    const created = await request(socket, {
      type: "create_agent_request",
      config: { provider: "codex", cwd: host.paseoHome },
      idempotencyKey: randomUUID(),
    });
    const workspaceId = z.object({ workspaceId: z.string() }).parse(created["agent"]).workspaceId;
    const archive = {
      type: "archive_workspace_request",
      workspaceId,
      operation: { key: randomUUID() },
    };
    expect(await request(socket, archive)).toMatchObject({ error: null });
    expect(
      await request(socket, { type: "workspace.recovery.restore.request", workspaceId }),
    ).toMatchObject({ error: null });
    expect(await request(socket, archive)).toMatchObject({ error: null });
    expect(
      await request(socket, { type: "workspace.recovery.inspect.request", workspaceId }),
    ).toMatchObject({ state: { kind: "unavailable", reason: "workspace_not_archived" } });
  } finally {
    socket.close();
    await host.close();
  }
}, 30_000);
