import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  agentId: z.string(),
  state: z.enum(["pending", "completed"]),
});
type Receipt = z.infer<typeof ReceiptSchema>;

/** One daemon-owned request journal, shared by all of its socket sessions. */
export class AgentRequests {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly operations = new Map<
    string,
    { controllers: Set<AbortController>; initialized: Promise<void>; unknown: boolean }
  >();
  private readonly operationWrites = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  /** Runtime cancellation belongs to the same journal as idempotent create/send receipts. */
  async run<T>(
    context: { key: string; deadlineAt?: string } | undefined,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!context) return operation();
    let active = this.operations.get(context.key);
    if (!active) {
      const previousWrite = this.operationWrites.get(context.key);
      active = {
        controllers: new Set(),
        unknown: false,
        initialized: (async () => {
          await previousWrite;
          if (await this.wasInterrupted(context.key))
            throw new Error("agent_request_outcome_unknown");
        })(),
      };
      this.operations.set(context.key, active);
    }
    const operationState = active;
    const controller = new AbortController();
    const controllers = active.controllers;
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let started = false;
    let recorded = false;
    try {
      await active.initialized;
      const remaining =
        context.deadlineAt === undefined ? undefined : Date.parse(context.deadlineAt) - Date.now();
      if (
        (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) ||
        (await this.wasCanceled(context.key))
      ) {
        throw new Error("agent_request_canceled");
      }
      controller.signal.throwIfAborted();
      if (remaining !== undefined)
        timer = setTimeout(() => controller.abort(new Error("agent_request_canceled")), remaining);
      await this.recordOperationState(context.key);
      recorded = true;
      controller.signal.throwIfAborted();
      started = true;
      const operationKey = digest(["operation", context.key]);
      const previous = this.pending.get(operationKey) ?? Promise.resolve();
      const tracked = previous
        .catch(() => undefined)
        .then(() => {
          controller.signal.throwIfAborted();
          return operation(controller.signal);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === "agent_request_outcome_unknown")
            operationState.unknown = true;
          throw error;
        })
        .finally(async () => {
          controllers.delete(controller);
          if (controllers.size === 0) this.operations.delete(context.key);
          await this.recordOperationState(context.key, operationState.unknown);
          if (this.pending.get(operationKey) === tracked) this.pending.delete(operationKey);
        });
      this.pending.set(operationKey, tracked);
      return await Promise.race([
        tracked,
        new Promise<never>((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) controller.signal.removeEventListener("abort", abort);
      if (controller.signal.aborted) await this.recordCancellation(context.key);
      if (!started) {
        controllers.delete(controller);
        if (controllers.size === 0) this.operations.delete(context.key);
        if (recorded) await this.recordOperationState(context.key);
      }
    }
  }

  async cancel(key: string): Promise<void> {
    // Persist before acknowledging: a delayed request or a new socket must also be fenced.
    await this.recordCancellation(key);
    for (const controller of this.operations.get(key)?.controllers ?? []) {
      controller.abort(new Error("agent_request_canceled"));
    }
  }

  async control(
    context: { key: string; deadlineAt?: string } | undefined,
    request: unknown,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    await this.run(context, async () => {
      if (!context) {
        await operation();
        return;
      }
      const file = path.join(this.directory, `control-${digest(context.key)}.json`);
      const fingerprint = digest(request);
      try {
        const receipt = z
          .object({ fingerprint: z.string() })
          .parse(JSON.parse(await readFile(file, "utf8")));
        if (receipt.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await operation();
      await writeJsonFileAtomic(file, { fingerprint });
    });
  }

  async cancelAndSettle(key: string): Promise<void> {
    await this.cancel(key);
    await this.pending.get(digest(["operation", key]))?.catch(() => undefined);
    await this.operationWrites.get(key);
    if (await this.wasInterrupted(key)) throw new Error("agent_request_outcome_unknown");
  }

  async cancelOperation(
    key: string,
    creationKey: string,
  ): Promise<{
    agentId: string | null;
    outcome: "settled" | "pending" | "unknown";
  }> {
    await this.cancel(key);
    return this.inspectOperation(key, creationKey);
  }

  async inspectOperation(
    key: string,
    creationKey: string,
  ): Promise<{
    agentId: string | null;
    outcome: "settled" | "pending" | "unknown";
  }> {
    await this.operationWrites.get(key);
    const active = this.operations.has(key);
    const receipt = await readReceipt(
      path.join(this.directory, `${digest(["create", creationKey])}.json`),
    );
    let outcome: "pending" | "unknown" | "settled" = "settled";
    if (receipt?.state === "pending" || (await this.wasInterrupted(key))) outcome = "unknown";
    if (active) outcome = "pending";
    return { agentId: receipt?.agentId ?? null, outcome };
  }

  private recordOperationState(key: string, unknown = false): Promise<void> {
    const previous = this.operationWrites.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() =>
        writeJsonFileAtomic(path.join(this.directory, `operation-${digest(key)}.json`), {
          state: unknown || this.operations.has(key) ? "pending" : "settled",
        }),
      );
    this.operationWrites.set(key, write);
    void write
      .finally(() => {
        if (this.operationWrites.get(key) === write) this.operationWrites.delete(key);
      })
      .catch(() => undefined);
    return write;
  }

  private async wasInterrupted(key: string): Promise<boolean> {
    try {
      const state = z
        .object({ state: z.enum(["pending", "settled"]) })
        .parse(
          JSON.parse(
            await readFile(path.join(this.directory, `operation-${digest(key)}.json`), "utf8"),
          ),
        );
      return state.state === "pending";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private recordCancellation(key: string): Promise<void> {
    return writeJsonFileAtomic(path.join(this.directory, `canceled-${digest(key)}.json`), true);
  }

  private async wasCanceled(key: string): Promise<boolean> {
    try {
      await readFile(path.join(this.directory, `canceled-${digest(key)}.json`));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  create(input: {
    key: string;
    request: unknown;
    findAgent: (agentId: string) => Promise<boolean>;
    create: (agentId: string) => Promise<void>;
  }): Promise<string> {
    return this.execute(["create", input.key], input.request, {
      agentId: randomUUID(),
      recover: input.findAgent,
      run: input.create,
      retrySafe: async (agentId) => !(await input.findAgent(agentId)),
    });
  }

  async send(input: {
    agentId: string;
    messageId: string;
    request: unknown;
    send: () => Promise<void>;
    prepare?: () => Promise<void>;
  }): Promise<void> {
    await this.execute(["send", input.agentId, input.messageId], input.request, {
      agentId: input.agentId,
      // A provider call can take effect before the daemon records its outcome.
      // Never repeat that call merely because a process died in this window.
      recover: async () => false,
      run: input.send,
      prepare: input.prepare,
    });
  }

  private execute(
    identity: string[],
    request: unknown,
    operation: {
      agentId: string;
      recover: (agentId: string) => Promise<boolean>;
      run: (agentId: string) => Promise<void>;
      prepare?: (() => Promise<void>) | undefined;
      retrySafe?: (agentId: string) => Promise<boolean>;
    },
  ): Promise<string> {
    const key = digest(identity);
    const fingerprint = digest(request);
    const previous = this.pending.get(key);
    // Serialize even conflicting requests: each caller validates its own fingerprint.
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.executeOnce(key, fingerprint, operation),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async executeOnce(
    key: string,
    fingerprint: string,
    operation: {
      agentId: string;
      recover: (agentId: string) => Promise<boolean>;
      run: (agentId: string) => Promise<void>;
      prepare?: (() => Promise<void>) | undefined;
      retrySafe?: (agentId: string) => Promise<boolean>;
    },
  ): Promise<string> {
    const file = path.join(this.directory, `${key}.json`);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return existing.agentId;
      if (!(await operation.recover(existing.agentId))) {
        throw new Error("agent_request_outcome_unknown");
      }
      await writeJsonFileAtomic(file, { ...existing, state: "completed" });
      return existing.agentId;
    }
    await operation.prepare?.();
    const receipt: Receipt = { fingerprint, agentId: operation.agentId, state: "pending" };
    await writeJsonFileAtomic(file, receipt);
    try {
      await operation.run(receipt.agentId);
    } catch (error) {
      // Keyed creation has no initial prompt. Once its normal cleanup finished,
      // absence of an agent confirms that retrying cannot duplicate one.
      if (await operation.retrySafe?.(receipt.agentId)) await rm(file, { force: true });
      throw error;
    }
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
    return receipt.agentId;
  }
}

async function readReceipt(file: string): Promise<Receipt | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
