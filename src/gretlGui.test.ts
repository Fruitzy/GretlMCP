import { describe, expect, it } from "vitest";
import { resolveGretlGui, runGretlGuiVersion } from "./gretlGui.js";

describe("Gretl GUI helpers", () => {
  it("finds the Gretl GUI executable", () => {
    const resolved = resolveGretlGui();
    expect(resolved).toMatch(/gretl(?:\.exe)?$/i);
  });

  it("reads the Gretl GUI version without launching an interactive session", async () => {
    const result = await runGretlGuiVersion(undefined, {
      timeoutMs: process.env.CI ? 1_500 : 10_000
    });

    if (result.timedOut) {
      expect(process.env.CI).toBeTruthy();
      expect(result.stderr).toContain("timed out");
      return;
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gretl version");
  });
});
