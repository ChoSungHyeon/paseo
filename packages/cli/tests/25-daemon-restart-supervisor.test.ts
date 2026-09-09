#!/usr/bin/env npx tsx

/**
 * Regression: app-style restart requests must trigger supervised worker restart
 * (worker PID changes) while keeping the daemon healthy.
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import { tryConnectToDaemon } from "../src/utils/client.ts";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

const pollIntervalMs = 100;
const testEnv = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? "0",
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? "0",
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? "0",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface DaemonStatus {
  localDaemon: string | null;
  pid: number | null;
  workerPid: number | null;
}

async function readDaemonStatus(paseoHome: string): Promise<DaemonStatus> {
  const result =
    await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon status --home ${paseoHome} --json`.nothrow();
  if (result.exitCode !== 0) {
    return { localDaemon: null, pid: null, workerPid: null };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      localDaemon?: unknown;
      pid?: unknown;
      workerPid?: number;
    };
    const localDaemon = typeof parsed.localDaemon === "string" ? parsed.localDaemon : null;
    const pid =
      typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
        ? parsed.pid
        : null;
    return { localDaemon, pid, workerPid: parsed.workerPid ?? null };
  } catch {
    return { localDaemon: null, pid: null, workerPid: null };
  }
}

async function readCapturedSupervisorLogs(paseoHome: string, recentLogs: string): Promise<string> {
  const durableLogs = await readFile(join(paseoHome, "daemon.log"), "utf8").catch(() => "");
  return `${recentLogs}\n${durableLogs}`;
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  async function poll(): Promise<void> {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(pollIntervalMs);
    return poll();
  }

  return poll();
}

console.log("=== Daemon Restart (supervisor regression) ===\n");

const port = await getAvailablePort();
const paseoHome = await mkdtemp(join(tmpdir(), "paseo-restart-supervisor-"));
const cliRoot = join(import.meta.dirname, "..");
const host = `127.0.0.1:${port}`;

let supervisorProcess: ChildProcess | null = null;
let recentSupervisorLogs = "";

try {
  console.log("Test 1: start supervisor-entrypoint in dev mode with isolated PASEO_HOME");

  supervisorProcess = spawn(
    process.execPath,
    ["--import", "tsx", "../server/scripts/supervisor-entrypoint.ts", "--dev"],
    {
      cwd: cliRoot,
      env: {
        ...process.env,
        ...testEnv,
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: host,
        PASEO_RELAY_ENABLED: "false",
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  supervisorProcess.stdout?.on("data", (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000);
  });
  supervisorProcess.stderr?.on("data", (chunk) => {
    recentSupervisorLogs = (recentSupervisorLogs + chunk.toString()).slice(-8000);
  });

  await waitFor(
    async () => {
      const status = await readDaemonStatus(paseoHome);
      return (
        status.localDaemon === "running" && status.pid !== null && isProcessRunning(status.pid)
      );
    },
    120000,
    "daemon did not become running in time",
  );

  const statusBeforeRestart = await readDaemonStatus(paseoHome);
  const supervisorPid = statusBeforeRestart.pid;
  assert.strictEqual(
    statusBeforeRestart.localDaemon,
    "running",
    "daemon should be running before restart",
  );
  assert(supervisorPid !== null, "supervisor pid should exist once daemon starts");
  assert(isProcessRunning(supervisorPid), "supervisor process should be running");
  const workerPidBeforeRestart = statusBeforeRestart.workerPid;
  assert(workerPidBeforeRestart !== null, "supervisor should have a worker process before restart");
  assert(
    isProcessRunning(workerPidBeforeRestart),
    "worker process should be running before restart",
  );
  console.log(
    `✓ daemon running with supervisor ${supervisorPid} and worker ${workerPidBeforeRestart}\n`,
  );

  console.log("Test 2: app-style restart request should restart worker and keep daemon healthy");
  const client = await tryConnectToDaemon({ target: { kind: "endpoint", host }, timeout: 5000 });
  assert(client, "daemon client should connect");
  try {
    const restartAck = await client.restartServer("settings_update");
    assert.strictEqual(
      restartAck.status,
      "restart_requested",
      "restart request should be acknowledged",
    );
  } finally {
    await client?.close().catch(() => undefined);
  }

  await waitFor(
    async () => {
      const workerPid = (await readDaemonStatus(paseoHome)).workerPid;
      return (
        workerPid !== null && workerPid !== workerPidBeforeRestart && isProcessRunning(workerPid)
      );
    },
    20000,
    "worker pid did not change after restart request",
  );

  const workerPidAfterRestart = (await readDaemonStatus(paseoHome)).workerPid;
  assert(workerPidAfterRestart !== null, "worker process should exist after restart");
  assert.notStrictEqual(
    workerPidAfterRestart,
    workerPidBeforeRestart,
    "worker pid should change after restart",
  );

  const statusAfterRestart = await readDaemonStatus(paseoHome);
  assert.strictEqual(
    statusAfterRestart.localDaemon,
    "running",
    "daemon should stay running after restart",
  );
  assert.strictEqual(
    statusAfterRestart.pid,
    supervisorPid,
    "supervisor pid should remain stable across restart",
  );
  const capturedSupervisorLogs = await readCapturedSupervisorLogs(paseoHome, recentSupervisorLogs);
  assert(
    capturedSupervisorLogs.includes('"msg":"Worker requested restart"') &&
      capturedSupervisorLogs.includes('"reason":"settings_update"'),
    `restart should log lifecycle restart reason from daemon worker, logs:\n${capturedSupervisorLogs}`,
  );
  assert(
    capturedSupervisorLogs.includes('"msg":"Supervisor requesting graceful worker shutdown"'),
    `restart should log the graceful worker shutdown request, logs:\n${capturedSupervisorLogs}`,
  );
  assert(
    capturedSupervisorLogs.includes("Server closed"),
    `restart should run daemon cleanup before replacing the worker, logs:\n${capturedSupervisorLogs}`,
  );
  console.log("✓ app-style restart keeps daemon healthy and restarts worker\n");
} finally {
  if (supervisorProcess?.pid && isProcessRunning(supervisorProcess.pid)) {
    supervisorProcess.kill("SIGTERM");
    await waitFor(
      () => !isProcessRunning(supervisorProcess!.pid ?? -1),
      5000,
      "supervisor cleanup timed out",
    ).catch(() => {
      supervisorProcess?.kill("SIGKILL");
    });
  }

  await $`PASEO_HOME=${paseoHome} PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=${testEnv.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD} PASEO_DICTATION_ENABLED=${testEnv.PASEO_DICTATION_ENABLED} PASEO_VOICE_MODE_ENABLED=${testEnv.PASEO_VOICE_MODE_ENABLED} npx paseo daemon stop --home ${paseoHome} --force`.nothrow();
  await rm(paseoHome, { recursive: true, force: true });
}

if (recentSupervisorLogs.trim().length === 0) {
  console.log("(no supervisor logs captured)");
}

console.log("=== Supervisor restart regression test passed ===");
