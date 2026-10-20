import type { WakeTarget } from "../types.ts";

/** A persisted Pi session the provider can reopen, as listed by the host (read-only catalog entry). */
export interface WakeCandidate {
  piSessionId: string;
  cwd: string;
  name?: string;
  archived: boolean;
  modified?: string;
  messageCount?: number;
}

export type WakeErrorCode =
  | "unavailable"   // the host cannot be reached or is not configured: nothing was sent
  | "unsupported"   // the host answered in a way this provider does not understand (private API drift)
  | "not_found"     // the host has no such session in that directory
  | "archived"      // the session is archived and read-only
  | "rejected"      // the host refused the request
  | "timeout"       // the request may have been accepted; the outcome is unknown
  | "server_error"; // the host failed while handling it; the outcome is unknown

/**
 * `definitive` means the host certainly did not act on the wake, so the held message can be withdrawn.
 * A non-definitive error leaves the outcome unknown: the session may still open and receive the message.
 */
export class WakeError extends Error {
  readonly code: WakeErrorCode;
  readonly definitive: boolean;
  constructor(code: WakeErrorCode, message: string) {
    super(message);
    this.name = "WakeError";
    this.code = code;
    this.definitive = code !== "timeout" && code !== "server_error";
  }
}

/**
 * Reopens a persisted Pi session so it can receive a message held for it in the broker mailbox.
 * Implementations must be fail-closed: any doubt about the host becomes a WakeError.
 */
export interface WakeProvider {
  readonly id: string;
  /** Read-only catalog of the sessions persisted in a directory. Must not load or modify any session. */
  list(cwd: string, signal?: AbortSignal): Promise<WakeCandidate[]>;
  /**
   * Ask the host to reopen the session and run the internal `/intercom-wake <messageId>` command in it.
   * Resolves when the host accepted the request, which does not mean the message was delivered.
   */
  wake(target: WakeTarget, messageId: string, signal?: AbortSignal): Promise<void>;
  /** Short diagnostic description of the host (for example its version), for the audit and status output. */
  describe?(): string | undefined;
}

export type WakeProviderFactory = (options: { sessiondSocket?: string; sessiondUrl?: string }) => WakeProvider;

const factories = new Map<string, WakeProviderFactory>();

export function registerWakeProvider(id: string, factory: WakeProviderFactory): void {
  factories.set(id, factory);
}

export function createWakeProvider(id: string, options: { sessiondSocket?: string; sessiondUrl?: string }): WakeProvider | undefined {
  return factories.get(id)?.(options);
}

/** The internal command the woken session runs; kept here so the sender and the receiver agree on it. */
export const WAKE_COMMAND = "intercom-wake";
export const WAKE_COMMAND_PROMPT = (messageId: string): string => `/${WAKE_COMMAND} ${messageId}`;
/** Message ids are broker-opaque strings; the wake prompt only carries ones that are safe to put in a command line. */
export const SAFE_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
