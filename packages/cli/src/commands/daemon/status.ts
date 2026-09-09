import { Command } from "commander";
import {
  readDaemonInstance,
  readPersistedConfig,
  resolveConfigFromPersisted,
  daemonLogPath,
  isSameDaemonInstance,
  DaemonInstanceError,
} from "@getpaseo/server";
import { connectToDaemon, buildDaemonConnectionCommandError } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { describeDaemonTarget } from "../../utils/daemon-target.js";

export function daemonStatusCommand(): Command {
  return addJsonAndDaemonHostOptions(
    new Command("status").description("Observe the selected daemon and its published endpoint"),
  ).action(withOutput(runStatusCommand));
}

export async function runStatusCommand(options: CommandOptions, _command: Command) {
  const target = options.daemonTarget;
  const instance = target.kind === "instance" ? await readDaemonInstance(target.home) : null;
  const local =
    target.kind === "instance"
      ? localStatus(target.home, instance)
      : { host: describeDaemonTarget(target) };
  let connectedDaemon = "not_probed";
  let note: string | undefined;
  let live: Record<string, unknown> = {};
  if (target.kind === "endpoint" || instance?.listen) {
    try {
      const client = await connectToDaemon({
        target,
        instance: instance ?? undefined,
        timeout: 1_500,
      });
      try {
        const status = await client.getDaemonStatus({ timeout: 1_500 });
        const current = target.kind === "instance" ? await readDaemonInstance(target.home) : null;
        if (instance && (!current || !isSameDaemonInstance(instance, current)))
          throw new DaemonInstanceError(
            "DAEMON_REPLACED",
            "Supervisor exited or was replaced during status observation.",
          );
        live = {
          serverId: client.getLastServerInfoMessage()?.serverId ?? null,
          daemonVersion: status.version,
          workerPid: status.pid,
          daemonNode: status.nodePath,
          providers: status.providers,
          relay: status.relay,
        };
        connectedDaemon = "reachable";
      } finally {
        await client.close();
      }
    } catch (error) {
      const failure = buildDaemonConnectionCommandError({ target, error });
      if (target.kind === "endpoint") throw failure;
      connectedDaemon = "unreachable";
      if (failure.code === "AUTH_REQUIRED") connectedDaemon = "auth_required";
      if (failure.code === "AUTH_FAILED") connectedDaemon = "auth_failed";
      note = failure.message;
    }
  }
  const data: Record<string, unknown> = { ...local, ...live, connectedDaemon, note };
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "daemon",
      columns: [],
      renderHuman: () =>
        Object.entries(data)
          .filter(([, value]) => value !== undefined)
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`,
          )
          .join("\n"),
    },
  };
}

function localStatus(home: string, instance: Awaited<ReturnType<typeof readDaemonInstance>>) {
  const config = resolveConfigFromPersisted(
    home,
    readPersistedConfig(home, { defaultsIfMissing: true }),
    { env: {} },
  );
  let localDaemon = "stopped";
  if (instance) localDaemon = instance.listen ? "running" : "not_ready";
  return {
    home,
    pid: instance?.pid ?? null,
    startedAt: instance?.startedAt ?? null,
    listen: instance?.listen ?? null,
    hostname: instance?.hostname ?? null,
    configuredListen: config.listen,
    localDaemon,
    desktopManaged: instance?.desktopManaged === true,
    logPath: daemonLogPath(home),
  };
}
