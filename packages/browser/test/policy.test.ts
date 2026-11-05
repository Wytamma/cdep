import { describe, expect, it } from "vitest";
import { CdepException } from "@cdep/protocol";
import {
  assertPeerOrigin,
  assertTransferTarget,
  isLoopbackHost,
  isTransportAllowedByPolicy,
} from "../src/policy.js";

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof CdepException ? error.code : "not-a-cdep-error";
  }
}

describe("transport policy", () => {
  it("allows HTTPS anywhere", () => {
    expect(isTransportAllowedByPolicy(new URL("https://treeviewer.example"))).toBe(true);
    expect(isTransportAllowedByPolicy(new URL("https://treeviewer.example:8443/app"))).toBe(true);
  });

  it("allows plain HTTP only on loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(isLoopbackHost(new URL(`http://${host}:5182/app`).hostname)).toBe(true);
      expect(isTransportAllowedByPolicy(new URL(`http://${host}:5182/app`))).toBe(true);
    }
    expect(isTransportAllowedByPolicy(new URL("http://treeviewer.example"))).toBe(false);
    expect(isTransportAllowedByPolicy(new URL("http://127.0.0.2:5182"))).toBe(false);
    expect(isTransportAllowedByPolicy(new URL("ftp://localhost"))).toBe(false);
  });

  it("rejects plain HTTP on a public host with HTTPS_REQUIRED", () => {
    expect(codeOf(() => assertTransferTarget("http://treeviewer.example"))).toBe("HTTPS_REQUIRED");
  });

  it("rejects malformed and relative destinations", () => {
    expect(codeOf(() => assertTransferTarget("/relative/path"))).toBe("TARGET_URL_INVALID");
    expect(codeOf(() => assertTransferTarget("not a url"))).toBe("TARGET_URL_INVALID");
  });

  it("rejects credentials in destination URLs", () => {
    expect(codeOf(() => assertTransferTarget("https://user:pass@treeviewer.example"))).toBe(
      "TARGET_URL_INVALID",
    );
  });

  it("accepts loopback destinations for development", () => {
    const url = assertTransferTarget("http://localhost:5182/app?x=1");
    expect(url.origin).toBe("http://localhost:5182");
    expect(url.pathname).toBe("/app");
  });
});

describe("peer origins", () => {
  it("accepts normalized HTTPS and loopback origins", () => {
    expect(assertPeerOrigin("https://treeviewer.example")).toBe("https://treeviewer.example");
    expect(assertPeerOrigin("http://127.0.0.1:5181")).toBe("http://127.0.0.1:5181");
  });

  it.each([
    ["opaque origin", "null"],
    ["origin with a path", "https://treeviewer.example/app"],
    ["public http origin", "http://treeviewer.example"],
    ["garbage", "not-an-origin"],
  ])("rejects %s", (_name, origin) => {
    expect(codeOf(() => assertPeerOrigin(origin))).toMatch(/ORIGIN_MISMATCH|HTTPS_REQUIRED/);
  });
});
