import { describe, expect, it } from "vitest";
import {
  isTerminalState,
  nextState,
  TERMINAL_STATES,
  transition,
  type TransferEvent,
  type TransferState,
} from "../src/index.js";

describe("transfer state machine", () => {
  it("walks the approved happy path", () => {
    let state: TransferState = "CONNECTED";
    const events: TransferEvent[] = [
      "DISCOVER",
      "OFFER",
      "ACCEPT",
      "TRANSFER_START",
      "TRANSFER_COMPLETE",
    ];
    for (const event of events) {
      const result = transition(state, event);
      expect(result.ok).toBe(true);
      if (result.ok) state = result.value;
    }
    expect(state).toBe("IMPORTED");
    expect(isTerminalState(state)).toBe(true);
  });

  it("never skips approval", () => {
    expect(nextState("CAPABILITIES_DISCOVERED", "TRANSFER_START")).toBeUndefined();
    expect(nextState("OFFERED", "TRANSFER_START")).toBeUndefined();
    expect(nextState("CONNECTED", "ACCEPT")).toBeUndefined();
  });

  it.each(["FAILED", "CANCELLED", "TIMED_OUT"] as const)(
    "allows every non-terminal stage to end in %s",
    (terminal) => {
      const event: TransferEvent =
        terminal === "FAILED" ? "FAIL" : terminal === "CANCELLED" ? "CANCEL" : "TIMEOUT";
      for (const state of [
        "CONNECTED",
        "CAPABILITIES_DISCOVERED",
        "OFFERED",
        "ACCEPTED",
        "TRANSFERRING",
      ] as const) {
        expect(nextState(state, event)).toBe(terminal);
      }
    },
  );

  it("only allows rejection while an offer is pending", () => {
    expect(nextState("OFFERED", "REJECT")).toBe("REJECTED");
    for (const state of ["CONNECTED", "CAPABILITIES_DISCOVERED", "ACCEPTED", "TRANSFERRING"] as const) {
      expect(nextState(state, "REJECT")).toBeUndefined();
    }
  });

  it("refuses transitions out of terminal states", () => {
    for (const state of TERMINAL_STATES) {
      const result = transition(state, "CANCEL");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("TRANSFER_STATE_INVALID");
    }
  });

  it("reports the attempted transition in the error", () => {
    const result = transition("OFFERED", "TRANSFER_COMPLETE");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toMatchObject({ state: "OFFERED", event: "TRANSFER_COMPLETE" });
    }
  });
});
