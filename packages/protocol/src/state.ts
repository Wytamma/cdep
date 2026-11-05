import { fail, ok, type Result } from "./errors.js";
import type { TransferEvent, TransferState } from "./types.js";

/**
 * v0.1 transfer state machine.
 *
 *   CONNECTED → CAPABILITIES_DISCOVERED → OFFERED → ACCEPTED → TRANSFERRING → IMPORTED
 *
 * Any non-terminal state may fail, time out, or be cancelled. IMPORTED and the
 * four failure states are terminal.
 */
const TRANSITIONS: Readonly<
  Record<TransferState, Readonly<Partial<Record<TransferEvent, TransferState>>>>
> = {
  CONNECTED: {
    DISCOVER: "CAPABILITIES_DISCOVERED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
    TIMEOUT: "TIMED_OUT",
  },
  CAPABILITIES_DISCOVERED: {
    OFFER: "OFFERED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
    TIMEOUT: "TIMED_OUT",
  },
  OFFERED: {
    ACCEPT: "ACCEPTED",
    REJECT: "REJECTED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
    TIMEOUT: "TIMED_OUT",
  },
  ACCEPTED: {
    TRANSFER_START: "TRANSFERRING",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
    TIMEOUT: "TIMED_OUT",
  },
  TRANSFERRING: {
    TRANSFER_COMPLETE: "IMPORTED",
    FAIL: "FAILED",
    CANCEL: "CANCELLED",
    TIMEOUT: "TIMED_OUT",
  },
  IMPORTED: {},
  REJECTED: {},
  FAILED: {},
  CANCELLED: {},
  TIMED_OUT: {},
};

export const TERMINAL_STATES: readonly TransferState[] = [
  "IMPORTED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
];

export function isTerminalState(state: TransferState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function nextState(state: TransferState, event: TransferEvent): TransferState | undefined {
  return TRANSITIONS[state][event];
}

export function transition(state: TransferState, event: TransferEvent): Result<TransferState> {
  const next = TRANSITIONS[state][event];
  if (!next) {
    return fail("TRANSFER_STATE_INVALID", `Illegal transition ${state} → ${event}`, {
      state,
      event,
      terminal: isTerminalState(state),
    });
  }
  return ok(next);
}
