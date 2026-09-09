import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentRequests, AgentRequestError } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new AgentRequests(directory) };
}

test("concurrent and reconstructed creates return the same durable agent", async () => {
  const { requests, directory } = await fixture();
  const agents = new Set<string>();
  let creations = 0;
  const input = {
    key: "create-1",
    request: { provider: "test", cwd: "/project" },
    findAgent: async (id: string) => agents.has(id),
    create: async (id: string) => {
      creations++;
      agents.add(id);
    },
  };
  const ids = await Promise.all([requests.create(input), requests.create(input)]);
  expect(ids[0]).toBe(ids[1]);
  expect(await new AgentRequests(directory).create(input)).toBe(ids[0]);
  expect(creations).toBe(1);
});

test("recovers creation when the agent was persisted before acknowledgement failed", async () => {
  const { requests, directory } = await fixture();
  const agents = new Set<string>();
  const input = {
    key: "lost-create",
    request: {},
    findAgent: async (id: string) => agents.has(id),
    create: async (id: string) => {
      agents.add(id);
      throw new Error("acknowledgement lost");
    },
  };
  await expect(requests.create(input)).rejects.toThrow("acknowledgement lost");
  expect(await new AgentRequests(directory).create(input)).toBe([...agents][0]);
  expect(agents.size).toBe(1);
});

test("reusing a create key with different configuration is a conflict", async () => {
  const { requests } = await fixture();
  const input = {
    key: "key",
    request: { model: "a" },
    findAgent: async () => true,
    create: async () => {},
  };
  await requests.create(input);
  await expect(requests.create({ ...input, request: { model: "b" } })).rejects.toThrow(
    "agent_request_key_conflict",
  );
});

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new AgentRequests(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new AgentRequests(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("a creation failure with no stored agent can be retried", async () => {
  const { requests } = await fixture();
  let available = false;
  const input = {
    key: "unavailable",
    request: {},
    findAgent: async () => false,
    create: async () => {
      if (!available) throw new Error("provider unavailable");
    },
  };
  await expect(requests.create(input)).rejects.toThrow("provider unavailable");
  available = true;
  await expect(requests.create(input)).resolves.toEqual(expect.any(String));
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new AgentRequests(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("canceling startup rejects its waiter and fences later phases and retries", async () => {
  const { requests, directory } = await fixture();
  const context = { key: "arrival", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = requests.run(context, async (signal) => {
    if (!signal) throw new Error("missing operation signal");
    entered();
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });
  const failed = expect(pending).rejects.toThrow("agent_request_canceled");
  await started;
  await requests.cancel(context.key);
  await failed;
  let sent = false;
  await expect(
    new AgentRequests(directory).run(context, async () => {
      sent = true;
    }),
  ).rejects.toThrow("agent_request_canceled");
  expect(sent).toBe(false);
  expect(await requests.run({ ...context, key: "other-arrival" }, async () => "ok")).toBe("ok");
});

test("an expired startup deadline cannot launch even without a cancel frame", async () => {
  const { requests } = await fixture();
  let launched = false;
  await expect(
    requests.run({ key: "expired", deadlineAt: "2000-01-01T00:00:00.000Z" }, async () => {
      launched = true;
    }),
  ).rejects.toThrow("agent_request_canceled");
  expect(launched).toBe(false);
});

test("a noncooperative operation leaves explicit pending cleanup without trapping cancel callers", async () => {
  const { requests } = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = requests.run(
    { key: "hung", deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    async () => {
      entered();
      await gate;
    },
  );
  const failed = expect(pending).rejects.toThrow("agent_request_canceled");
  await started;
  expect(await requests.cancelOperation("hung", "conversation")).toEqual({
    agentId: null,
    outcome: "pending",
  });
  await failed;
  release();
  await expect
    .poll(() => requests.cancelOperation("hung", "conversation"))
    .toEqual({ agentId: null, outcome: "settled" });
});

test("a reconstructed journal reports interrupted startup as unknown and never launches a canceled phase", async () => {
  const { requests, directory } = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = { key: "interrupted", deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const pending = requests.run(context, async () => {
    entered();
    await gate;
  });
  await started;
  const restarted = new AgentRequests(directory);
  const replays = await Promise.allSettled([
    restarted.run(context, async () => "must not launch"),
    restarted.run(context, async () => "must not launch"),
  ]);
  expect(replays).toEqual([
    { status: "rejected", reason: new AgentRequestError("agent_request_outcome_unknown") },
    { status: "rejected", reason: new AgentRequestError("agent_request_outcome_unknown") },
  ]);
  expect(await restarted.cancelOperation(context.key, "conversation")).toEqual({
    agentId: null,
    outcome: "unknown",
  });
  await expect(restarted.run(context, async () => "must not run")).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  release();
  await pending;
});

test("a live deadline settles a hung waiter without a cancel frame and preserves late cleanup", async () => {
  const { directory } = await fixture();
  let expire!: () => void;
  const now = Date.parse("2026-09-09T00:00:00Z");
  const requests = new AgentRequests(directory, {
    now: () => now,
    schedule(callback, delayMs) {
      expect(delayMs).toBe(120_000);
      expire = callback;
      return () => {};
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = requests.run(
    { key: "deadline", deadlineAt: new Date(now + 120_000).toISOString() },
    async () => {
      enter();
      await gate;
    },
  );
  const rejected = expect(pending).rejects.toThrow("agent_request_canceled");
  await entered;
  expire();
  await rejected;
  expect(await requests.inspectOperation("deadline", "conversation")).toMatchObject({
    outcome: "pending",
  });
  await expect(requests.run({ key: "deadline" }, async () => "must not launch")).rejects.toThrow(
    "agent_request_canceled",
  );
  release();
  await requests.cancelAndSettle("deadline");
  expect(await requests.inspectOperation("deadline", "conversation")).toMatchObject({
    outcome: "settled",
  });
  expect(await requests.run({ key: "next" }, async () => "ready")).toBe("ready");
});

test("retransmitted phases serialize while other operation keys continue", async () => {
  const { requests } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const order: string[] = [];
  const first = requests.run({ key: "arrival" }, async () => {
    order.push("first");
    entered();
    await gate;
    order.push("settled");
  });
  await started;
  const second = requests.run({ key: "arrival" }, async () => {
    order.push("second");
  });
  await requests.run({ key: "other" }, async () => {
    order.push("other");
  });
  expect(order).toEqual(["first", "other"]);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "other", "settled", "second"]);
});

test("successful control receipts survive restart and reject changed targets", async () => {
  const { requests, directory } = await fixture();
  let archives = 0;
  const action = async () => {
    archives++;
  };
  await requests.control({ key: "cleanup" }, { workspaceId: "one" }, action);
  const restarted = new AgentRequests(directory);
  await restarted.control({ key: "cleanup" }, { workspaceId: "one" }, action);
  expect(archives).toBe(1);
  await expect(
    restarted.control({ key: "cleanup" }, { workspaceId: "two" }, action),
  ).rejects.toThrow("agent_request_key_conflict");
});

test("refused provider cancellation remains unknown after restart", async () => {
  const { requests, directory } = await fixture();
  await expect(
    requests.run({ key: "refused" }, async () => {
      throw new AgentRequestError("agent_request_outcome_unknown");
    }),
  ).rejects.toThrow("agent_request_outcome_unknown");
  expect(
    await new AgentRequests(directory).inspectOperation("refused", "conversation"),
  ).toMatchObject({ outcome: "unknown" });
});
