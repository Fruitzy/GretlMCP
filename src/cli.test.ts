import { describe, expect, it } from "vitest";
import { helpText, parseCliArgs } from "./cli.js";

describe("CLI", () => {
  it("parses no arguments as server run mode", () => {
    expect(parseCliArgs([])).toEqual({ action: "run" });
  });

  it("parses gretl CLI and workspace options", () => {
    expect(
      parseCliArgs([
        "--gretl-cli",
        "C:\\tools\\gretl\\gretlcli.exe",
        "--gretl-gui=C:\\tools\\gretl\\gretl.exe",
        "--workspace=tmp"
      ])
    ).toEqual({
      action: "run",
      gretlCliPath: "C:\\tools\\gretl\\gretlcli.exe",
      gretlGuiPath: "C:\\tools\\gretl\\gretl.exe",
      workspaceRoot: "tmp"
    });
  });

  it("parses help and version actions", () => {
    expect(parseCliArgs(["--help"])).toEqual({ action: "help" });
    expect(parseCliArgs(["--version"])).toEqual({ action: "version" });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseCliArgs(["--bad"])).toThrow("Unknown argument");
  });

  it("prints useful help text", () => {
    expect(helpText()).toContain("--gretl-cli");
    expect(helpText()).toContain("--gretl-gui");
    expect(helpText()).toContain("GRETL_CLI");
  });
});
