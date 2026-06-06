import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GretlSafetyError,
  buildCapabilitiesScript,
  buildCommandsScript,
  buildDatasetSummaryScript,
  buildGuideModeScript,
  buildOlsScript,
  buildMakePackageScript,
  buildPackageScript,
  parseGuideFindings,
  resolveExistingDatasetPath,
  resolveGretlCli,
  runGretlCommands,
  runGretlScript,
  runGretlScriptFile,
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

  it("builds command and capability scripts for raw Gretl access", () => {
    const commandScript = buildCommandsScript([" nulldata 10 ", "summary"]);
    expect(commandScript).toContain("nulldata 10");
    expect(commandScript).toContain("summary");
    expect(
      buildCapabilitiesScript({ includeFunctions: false, includePackageHelp: false })
    ).toBe("help");
  });

  it("builds OLS scripts with constants by default", () => {
    expect(buildOlsScript("sample.gdt", "y", ["x1", "x2"])).toContain(
      "ols y const x1 x2"
    );
  });

  it("builds native guide mode scripts for demo OLS diagnostics", () => {
    const guide = buildGuideModeScript();

    expect(guide.usesDemoData).toBe(true);
    expect(guide.guideSteps).toHaveLength(6);
    expect(guide.commonProblems).toContain(
      "Heteroskedasticity: standard errors can be misleading even when coefficients look reasonable."
    );
    expect(guide.script).toContain("GretlMCP native guide mode");
    expect(guide.script).toContain("modtest --white --silent");
    expect(guide.script).toContain("leverage --save --overwrite --quiet");
    expect(guide.script).toContain("@@GRETLMCP_FINDING|warning|heteroskedasticity");
  });

  it("builds native guide mode scripts for user datasets", () => {
    const guide = buildGuideModeScript({
      datasetPath: "sample.gdt",
      dependentVariable: "y",
      independentVariables: ["x1", "x2"],
      learningLevel: "advanced"
    });

    expect(guide.usesDemoData).toBe(false);
    expect(guide.script).toContain("open \"sample.gdt\"");
    expect(guide.script).toContain("ols y const x1 x2");
    expect(guide.teachingNotes.at(-1)).toContain("identification");
  });

  it("rejects partial guide mode dataset inputs", () => {
    expect(() =>
      buildGuideModeScript({
        datasetPath: "sample.gdt",
        dependentVariable: "y"
      })
    ).toThrow("Guide mode needs datasetPath");
  });

  it("parses guide mode diagnostic findings", () => {
    expect(
      parseGuideFindings(
        [
          "ignored",
          "@@GRETLMCP_FINDING|warning|heteroskedasticity|Residual variance changes.|Try robust standard errors.",
          "@@GRETLMCP_FINDING|info|reset_not_rejected|RESET did not reject.|Keep checking."
        ].join("\n")
      )
    ).toEqual([
      {
        severity: "warning",
        code: "heteroskedasticity",
        message: "Residual variance changes.",
        guidance: "Try robust standard errors."
      },
      {
        severity: "info",
        code: "reset_not_rejected",
        message: "RESET did not reject.",
        guidance: "Keep checking."
      }
    ]);
  });

  it("builds package management scripts", () => {
    expect(
      buildPackageScript({ action: "query", packageName: "armax", quiet: true })
    ).toBe("pkg query armax --quiet");
    expect(buildPackageScript({ action: "index" })).toBe("pkg index addons");
    expect(
      buildMakePackageScript({ packagePath: "example.gfn", index: true })
    ).toContain("makepkg");
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

  it("runs raw Gretl command lines", async () => {
    const result = await runGretlCommands({
      commands: ["nulldata 8", "series x = normal()", "summary x"],
      timeoutSeconds: 20,
      safeMode: true,
      keepWorkspace: false
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Summary statistics/i);
  });

  it("runs an existing Gretl script file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gretl-mcp-script-file-"));
    try {
      const scriptPath = join(tempDir, "sample.inp");
      await writeFile(
        scriptPath,
        "nulldata 8\nseries x = normal()\nsummary x\n",
        "utf8"
      );

      const result = await runGretlScriptFile({
        scriptPath,
        timeoutSeconds: 20,
        safeMode: true
      });

      expect(result.exitCode).toBe(0);
      expect(result.workingDirectory).toBe(tempDir);
      expect(result.stdout).toMatch(/Summary statistics/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
