import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { hostname } from "os";
import { isAbsolute } from "path";
import { getIntercomDirPath } from "./broker/paths.ts";
import { defaultMachineName } from "./cross-machine-envelope.ts";

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const INTERCOM_SCOPE_ID_ENV = "PI_INTERCOM_SCOPE_ID";

export function getAskTimeoutMs(): number {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PI_INTERCOM_ASK_TIMEOUT_MS must be a positive integer number of milliseconds");
  }
  return value;
}

export function getIntercomScopeId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const scopeId = env[INTERCOM_SCOPE_ID_ENV]?.trim();
  return scopeId ? scopeId : undefined;
}

/** Sets this process's broker routing scope. Children launched afterwards inherit it. */
export function setIntercomScopeId(scopeId: string | undefined): void {
  if (scopeId) process.env[INTERCOM_SCOPE_ID_ENV] = scopeId;
  else delete process.env[INTERCOM_SCOPE_ID_ENV];
}

export type InboundTriggerPolicy = "always" | "replies" | "never";
export type BusyDeliveryPolicy = "steer" | "human-first";

export interface CrossMachineConfig {
  /** Name peers use for this host in their Herdr saved-machine lists. */
  machineName: string;
  /** Command invoked through SSH on remote machines. */
  remoteCommand: string;
}

export interface WakeConfig {
  /** Master switch. Off by default: waking loads a persisted session and runs its extensions. */
  enabled: boolean;
  /** Registered wake provider id; `pi-web-sessiond` is the only built-in. */
  provider: string;
  /** Absolute directories whose sessions may be woken. Empty means none. */
  allowCwds: string[];
  /** `always` asks the user before every wake (and blocks without UI); `never` skips the dialog for allowlisted directories. */
  confirm: "always" | "never";
  /**
   * Asking before `spawn` creates a session in another project. `always` (default) asks every time, trusted senders
   * included, and blocks without a UI; `trusted` lets /wake-trust senders skip the dialog; `never` never asks.
   */
  spawnConfirm: "always" | "trusted" | "never";
  /** At most this many sessions created by `spawn` per spawnWindowMs, across all senders. */
  spawnMax: number;
  spawnWindowMs: number;
  /** At most this many `archive` actions per spawnWindowMs. Archiving always asks the user; this is not configurable. */
  archiveMax: number;
  /** A wake with the same target and text inside this window is refused. */
  dedupMs: number;
  perTargetMax: number;
  perTargetWindowMs: number;
  globalMax: number;
  globalWindowMs: number;
  /** Time allowed for the daemon catalog read. */
  listTimeoutMs: number;
  /** Time allowed for the daemon to accept the wake prompt. */
  wakeTimeoutMs: number;
  /** Time to wait for the woken session's receipt before reporting the delivery as unconfirmed. */
  deliveryTimeoutMs: number;
  /** Time `/intercom-wake` waits, inside the woken session, for the held message to arrive. */
  receiveTimeoutMs: number;
  auditMaxEntries: number;
  auditRetentionDays: number;
  /** Lifetime of a /wake-trust grant, in days. */
  trustDays: number;
  /** Explicit endpoint of the PI WEB session daemon; falls back to PI_WEB_SESSIOND_SOCKET / PI_WEB_SESSIOND_URL. Never guessed. */
  sessiondSocket?: string;
  sessiondUrl?: string;
}

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (e.g. "npx" or "bun") */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** Controls whether inbound broker messages may automatically trigger a model turn */
  inboundTrigger: InboundTriggerPolicy;

  /** Delivery priority for peers arriving during interactive agent runs */
  busyDelivery: BusyDeliveryPolicy;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;

  /** Optional stable intercom session ID for restart-stable addressing */
  stableId?: string;
  
  /** Enable/disable intercom (default: true) */
  enabled: boolean;
  
  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;

  /** Cross-machine discovery and SSH relay settings. */
  crossMachine: CrossMachineConfig;

  /** Opt-in wake of persisted but unloaded sessions (see docs/session-waker). */
  wake: WakeConfig;
}

export const defaultWakeConfig = (): WakeConfig => ({
  enabled: false,
  provider: "pi-web-sessiond",
  allowCwds: [],
  confirm: "always",
  spawnConfirm: "always",
  spawnMax: 5,
  spawnWindowMs: 60 * 60_000,
  archiveMax: 10,
  dedupMs: 10 * 60_000,
  perTargetMax: 3,
  perTargetWindowMs: 10 * 60_000,
  globalMax: 10,
  globalWindowMs: 60 * 60_000,
  listTimeoutMs: 5_000,
  wakeTimeoutMs: 15_000,
  deliveryTimeoutMs: 30_000,
  receiveTimeoutMs: 15_000,
  auditMaxEntries: 1000,
  auditRetentionDays: 30,
  trustDays: 30,
});

function parseWakeConfig(value: unknown): WakeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"wake" must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const wake = defaultWakeConfig();
  const known = new Set<string>(Object.keys(wake).concat(["sessiondSocket", "sessiondUrl"]));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`"wake.${key}" is not a known setting`);
  }
  const bool = (key: "enabled") => {
    if (Object.hasOwn(raw, key)) {
      if (typeof raw[key] !== "boolean") throw new Error(`"wake.${key}" must be a boolean`);
      wake[key] = raw[key] as boolean;
    }
  };
  const positive = (key: "dedupMs" | "perTargetMax" | "perTargetWindowMs" | "globalMax" | "globalWindowMs" | "listTimeoutMs" | "wakeTimeoutMs" | "deliveryTimeoutMs" | "receiveTimeoutMs" | "auditMaxEntries" | "auditRetentionDays" | "trustDays" | "spawnMax" | "spawnWindowMs" | "archiveMax") => {
    if (Object.hasOwn(raw, key)) {
      const n = raw[key];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new Error(`"wake.${key}" must be a positive integer`);
      wake[key] = n;
    }
  };
  bool("enabled");
  if (Object.hasOwn(raw, "provider")) {
    if (typeof raw.provider !== "string" || !raw.provider.trim()) throw new Error(`"wake.provider" must be a non-empty string`);
    wake.provider = raw.provider.trim();
  }
  if (Object.hasOwn(raw, "allowCwds")) {
    if (!Array.isArray(raw.allowCwds) || !raw.allowCwds.every((cwd) => typeof cwd === "string" && isAbsolute(cwd))) {
      throw new Error(`"wake.allowCwds" must be an array of absolute directory paths`);
    }
    wake.allowCwds = raw.allowCwds as string[];
  }
  if (Object.hasOwn(raw, "confirm")) {
    if (raw.confirm !== "always" && raw.confirm !== "never") throw new Error(`"wake.confirm" must be "always" or "never"`);
    wake.confirm = raw.confirm;
  }
  if (raw.spawnConfirm !== undefined) {
    if (raw.spawnConfirm !== "always" && raw.spawnConfirm !== "trusted" && raw.spawnConfirm !== "never") throw new Error(`"wake.spawnConfirm" must be "always", "trusted" or "never"`);
    wake.spawnConfirm = raw.spawnConfirm;
  }
  for (const key of ["dedupMs", "perTargetMax", "perTargetWindowMs", "globalMax", "globalWindowMs", "listTimeoutMs", "wakeTimeoutMs", "deliveryTimeoutMs", "receiveTimeoutMs", "auditMaxEntries", "auditRetentionDays", "trustDays", "spawnMax", "spawnWindowMs", "archiveMax"] as const) positive(key);
  for (const key of ["sessiondSocket", "sessiondUrl"] as const) {
    if (Object.hasOwn(raw, key)) {
      if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) throw new Error(`"wake.${key}" must be a non-empty string`);
      wake[key] = (raw[key] as string).trim();
    }
  }
  return wake;
}

export function getConfigPath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "config.json");
}

const defaults: IntercomConfig = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  inboundTrigger: "always",
  busyDelivery: "steer",
  enabled: true,
  replyHint: true,
  crossMachine: {
    machineName: defaultMachineName(hostname()),
    remoteCommand: "pi-intercom",
  },
  wake: defaultWakeConfig(),
};

export function loadConfig(): IntercomConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...defaults, crossMachine: { ...defaults.crossMachine }, wake: defaultWakeConfig() };
  }
  
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config: IntercomConfig = {
      ...defaults,
      crossMachine: { ...defaults.crossMachine },
      wake: defaultWakeConfig(),
    };

    if (Object.hasOwn(parsedConfig, "wake")) {
      config.wake = parseWakeConfig(parsedConfig.wake);
    }

    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }

    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs: string[] = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }

    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }

    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }

    if (Object.hasOwn(parsedConfig, "inboundTrigger")) {
      if (
        parsedConfig.inboundTrigger !== "always"
        && parsedConfig.inboundTrigger !== "replies"
        && parsedConfig.inboundTrigger !== "never"
      ) {
        throw new Error(`"inboundTrigger" must be "always", "replies", or "never"`);
      }
      config.inboundTrigger = parsedConfig.inboundTrigger;
    }

    if (Object.hasOwn(parsedConfig, "busyDelivery")) {
      if (parsedConfig.busyDelivery !== "steer" && parsedConfig.busyDelivery !== "human-first") {
        throw new Error(`"busyDelivery" must be "steer" or "human-first"`);
      }
      config.busyDelivery = parsedConfig.busyDelivery;
    }

    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }

    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }

    if (Object.hasOwn(parsedConfig, "stableId")) {
      if (typeof parsedConfig.stableId !== "string") {
        throw new Error(`"stableId" must be a string`);
      }
      const stableId = parsedConfig.stableId.trim();
      if (!stableId) {
        throw new Error(`"stableId" must not be empty`);
      }
      config.stableId = stableId;
    }

    if (Object.hasOwn(parsedConfig, "crossMachine")) {
      const value = parsedConfig.crossMachine;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`"crossMachine" must be an object`);
      }
      const crossMachine = value as Record<string, unknown>;
      if (Object.hasOwn(crossMachine, "machineName")) {
        if (typeof crossMachine.machineName !== "string" || !crossMachine.machineName.trim()) {
          throw new Error(`"crossMachine.machineName" must be a non-empty string`);
        }
        config.crossMachine.machineName = crossMachine.machineName.trim();
      }
      if (Object.hasOwn(crossMachine, "remoteCommand")) {
        if (typeof crossMachine.remoteCommand !== "string" || !crossMachine.remoteCommand.trim()) {
          throw new Error(`"crossMachine.remoteCommand" must be a non-empty string`);
        }
        config.crossMachine.remoteCommand = crossMachine.remoteCommand.trim();
      }
    }

    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load intercom config at ${configPath}: ${message}`, { cause: error });
  }
}
