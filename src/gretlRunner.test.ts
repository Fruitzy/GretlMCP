import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GretlSafetyError,
  buildDatasetSummaryScript,
  buildOlsScript,
  resolveExistingDatasetPath,
  resolveGretlCli,
  runGretlScript,
  runGretlVersion,
  validateSafeScript
} from "./gretlRunner.js";

describe("Gretl runner", () => {
  it("finds the local portable Gretl path on this Windows setup", () => {
    const resolved = resolveGretlCli();
    expect(resolved).toMatch(/gretlcli(?:\.exe)?$/i);
  });

  it("blocks shell-like commands in safe mode", () => {
    expect(() => validateSafeScript("nulldata 10\n! echo nope")).toThrow(
      GretlSafetyError
    );
  });

  it("builds reusable dataset summary scripts", () => {
    expect(buildDatasetSummaryScript("C:\\data\\sample.csv")).toContain("summary");
  });

  it("builds OLS scripts with constants by default", () => {
    expect(buildOlsScript("sample.gdt", "y", ["x1", "x2"])).toContain(
      "ols y const x1 x2"
    );
  });

  it("rejects invalid OLS variable names", () => {
    expect(() => buildOlsScript("sample.gdt", "y", ["x1\nshell"])).toThrow(
      "Invalid Gretl identifier"
    );
  });

  it("rejects URL dataset paths for helper tools", () => {
    expect(() => resolveExistingDatasetPath("https://example.com/data.csv")).toThrow(
      "local files"
    );
  });

  it("rejects missing dataset paths for helper tools", () => {
    expect(() => resolveExistingDatasetPath("missing-data-file.csv")).toThrow(
      "does not exist"
    );
  });

  it("reads the Gretl version", async () => {
    const result = await runGretlVersion();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gretl version");
  });

  it("runs a simple Gretl script when gretlcli is available", async () => {
    const result = await runGretlScript({
      script: "nulldata 12\nseries x = normal()\nsummary x",
      timeoutSeconds: 20,
      safeMode: true,
      keepWorkspace: false
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Summary statistics/i);
  });

  it("can summarize a CSV through Gretl", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gretl-mcp-test-"));
    try {
      const csvPath = join(tempDir, "sample.csv");
      await writeFile(csvPath, "y,x\n1,2\n2,3\n3,5\n4,7\n", "utf8");

      const result = await runGretlScript({
        script: buildDatasetSummaryScript(csvPath),
        timeoutSeconds: 20,
        safeMode: false,
        keepWorkspace: false
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("corr(y, x)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
