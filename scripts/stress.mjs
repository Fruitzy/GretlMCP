import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runRoot = await mkdtemp(join(tmpdir(), "gretl-mcp-stress-"));
const distIndex = resolve(repoRoot, "dist/index.js");
const gretlRoot = await resolveGretlRoot();
const fedstlPath = join(gretlRoot, "db", "fedstl.bin");
const abdataPath = join(gretlRoot, "data", "misc", "abdata.gdt");

await access(distIndex, constants.R_OK).catch(() => {
  throw new Error("dist/index.js not found. Run npm run build before npm run stress.");
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [distIndex],
  env: {
    ...process.env,
    GRETLMCP_OPEN_GUI: "false",
    GRETLMCP_WORKSPACE_DIR: runRoot
  }
});

const client = new Client({
  name: "gretl-mcp-stress",
  version: "0.2.0"
});

const results = [];

try {
  await client.connect(transport);

  await runToolCase("capabilities", "gretl_capabilities", {
    includeFunctions: false,
    includePackageHelp: true,
    displayInGretl: false
  }, ["Valid gretl commands", "makepkg"]);

  await runScriptCase("06-nls-logistic", nlsLogisticScript(), [
    "Bad-start numerical NLS",
    "Good-start analytic NLS",
    "Good-start numerical NLS",
    "Summary statistics"
  ]);

  await runScriptCase("07-mixed-frequency-compaction", mixedFrequencyScript(), [
    "Compaction coefficient comparison",
    "unrate_spread_m1"
  ], { safeMode: false });

  await runScriptCase("08-panel-tournament", panelTournamentScript(), [
    "Panel tournament coefficient on w",
    "manual-FE"
  ], { safeMode: false });

  await runScriptCase("09-garch-volatility", garchVolatilityScript(), [
    "GARCH backtest slope",
    "Summary statistics"
  ], { expectArtifacts: ["garch_variance.png"] });

  await runForeignCase();

  await runScriptCase("11-iv-simulation", ivSimulationScript(), [
    "IV is not magic",
    "First-stage F"
  ]);

  await runReproducibleProjectCase();
} finally {
  await client.close();
}

const failed = results.filter((result) => result.status === "failed");
console.log(JSON.stringify({ ok: failed.length === 0, runRoot, results }, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}

async function runToolCase(name, toolName, args, requiredText) {
  try {
    const response = await client.callTool({ name: toolName, arguments: args });
    const payload = parsePayload(response);
    assertPayloadOk(payload);
    assertIncludes(payload.stdout ?? JSON.stringify(payload), requiredText);
    results.push({ name, status: "passed" });
  } catch (error) {
    results.push({ name, status: "failed", error: errorMessage(error) });
  }
}

async function runScriptCase(name, script, requiredText, options = {}) {
  try {
    const response = await client.callTool({
      name: "gretl_run_script",
      arguments: {
        script,
        timeoutSeconds: 120,
        safeMode: options.safeMode ?? true,
        keepWorkspace: true,
        displayInGretl: false
      }
    });
    const payload = parsePayload(response);
    assertPayloadOk(payload);
    assertIncludes(payload.stdout, requiredText);

    for (const artifactName of options.expectArtifacts ?? []) {
      if (!payload.artifacts?.some((artifact) => artifact.name === artifactName)) {
        throw new Error(`Missing artifact ${artifactName}`);
      }
    }

    results.push({
      name,
      status: "passed",
      workspace: payload.workspace,
      artifacts: payload.artifacts ?? []
    });
  } catch (error) {
    results.push({ name, status: "failed", error: errorMessage(error) });
  }
}

async function runForeignCase() {
  const python = await commandWorks("python", ["--version"]);
  const rscript = await commandWorks("Rscript", ["--version"]);
  const octave = await commandWorks("octave", ["--version"]);

  if (!python && !rscript && !octave) {
    results.push({
      name: "10-foreign-integration",
      status: "skipped",
      reason: "No working Python, Rscript, or Octave executable found on PATH."
    });
    return;
  }

  const language = python ? "Python" : rscript ? "R" : "Octave";
  const body =
    language === "Python"
      ? "print('foreign Python bridge reached from Gretl')"
      : language === "R"
        ? "print('foreign R bridge reached from Gretl')"
        : "disp('foreign Octave bridge reached from Gretl')";

  await runScriptCase("10-foreign-integration", [
    "nulldata 8",
    "series x = normal()",
    `foreign language=${language}`,
    body,
    "end foreign"
  ].join("\n"), [`foreign ${language}`], { safeMode: false });
}

async function runReproducibleProjectCase() {
  const project = join(runRoot, "reproducible-project");
  await mkdir(join(project, "data"), { recursive: true });
  await mkdir(join(project, "output"), { recursive: true });

  const mainScript = reproducibleProjectScript(project);
  const mainPath = join(project, "main.inp");
  await writeFile(mainPath, mainScript, "utf8");
  await writeFile(
    join(project, "README.md"),
    [
      "# Reproducible Gretl Project",
      "",
      "Run `main.inp` from top to bottom to regenerate data, model output, and graphs.",
      "Switches at the top of the script control robust standard errors, logs, and sample years.",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    const response = await client.callTool({
      name: "gretl_run_script_file",
      arguments: {
        scriptPath: mainPath,
        timeoutSeconds: 120,
        safeMode: false,
        displayInGretl: false
      }
    });
    const payload = parsePayload(response);
    assertPayloadOk(payload);
    assertIncludes(payload.stdout, ["Reproducible project completed"]);

    const expectedFiles = [
      "data/simulated.csv",
      "output/model-output.txt",
      "output/fit.png",
      "output/fit.pdf",
      "output/final-report.txt"
    ];

    for (const file of expectedFiles) {
      await access(join(project, file), constants.R_OK);
    }

    results.push({ name: "12-reproducible-project", status: "passed", project });
  } catch (error) {
    results.push({ name: "12-reproducible-project", status: "failed", error: errorMessage(error), project });
  }
}

function parsePayload(response) {
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return JSON.parse(text);
}

function assertPayloadOk(payload) {
  if (!payload.ok) {
    throw new Error(payload.error ?? payload.stderr ?? payload.stdout ?? "Gretl tool returned ok=false");
  }
}

function assertIncludes(text, required) {
  for (const needle of required) {
    if (!text.includes(needle)) {
      throw new Error(`Expected output to include ${JSON.stringify(needle)}`);
    }
  }
}

function commandWorks(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    child.once("error", () => resolvePromise(false));
    child.once("close", (code) => resolvePromise(code === 0));
  });
}

async function resolveGretlRoot() {
  const fromCli = process.env.GRETL_CLI ? dirname(process.env.GRETL_CLI) : undefined;
  const candidates = [
    process.env.GRETL_HOME,
    fromCli,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "tools", "gretl") : undefined,
    "C:\\Program Files\\gretl",
    "C:\\Program Files (x86)\\gretl"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "db", "fedstl.bin"), constants.R_OK);
      await access(join(candidate, "data", "misc", "abdata.gdt"), constants.R_OK);
      return candidate;
    } catch {
      // Try the next Gretl installation candidate.
    }
  }

  throw new Error(
    "Could not find Gretl sample data. Set GRETL_HOME or GRETL_CLI to a Gretl installation."
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function q(path) {
  return `"${path.replace(/\\/g, "/")}"`;
}

function nlsLogisticScript() {
  return [
    "set seed 12345",
    "nulldata 80",
    "genr time",
    "series trend = time",
    "series y = 100 / (1 + exp(-(-3 + 0.09*trend))) + normal()*2",
    "scalar L = 20",
    "scalar a = 3",
    "scalar b = -0.01",
    "set stopwatch",
    "nls y = L / (1 + exp(-(a + b*trend)))",
    "  params L a b",
    "end nls --quiet",
    "scalar bad_elapsed = $stopwatch",
    "series yhat_bad = $yhat",
    "printf \"Bad-start numerical NLS: L=%.4f a=%.4f b=%.4f elapsed=%.4f\\n\", L, a, b, bad_elapsed",
    "scalar L = max(y) * 1.1",
    "series logit_y = log(L/y - 1)",
    "ols logit_y const trend --quiet",
    "scalar a = -$coeff(const)",
    "scalar b = -$coeff(trend)",
    "set stopwatch",
    "nls y = L / (1 + exp(-(a + b*trend)))",
    "  deriv L = 1 / (1 + exp(-(a + b*trend)))",
    "  deriv a = L * exp(-(a + b*trend)) / (1 + exp(-(a + b*trend)))^2",
    "  deriv b = L * trend * exp(-(a + b*trend)) / (1 + exp(-(a + b*trend)))^2",
    "end nls --quiet",
    "scalar good_elapsed = $stopwatch",
    "series yhat_good_deriv = $yhat",
    "printf \"Good-start analytic NLS: L=%.4f a=%.4f b=%.4f elapsed=%.4f\\n\", L, a, b, good_elapsed",
    "scalar L = max(y) * 1.1",
    "ols logit_y const trend --quiet",
    "scalar a = -$coeff(const)",
    "scalar b = -$coeff(trend)",
    "set stopwatch",
    "nls y = L / (1 + exp(-(a + b*trend)))",
    "  params L a b",
    "end nls --quiet",
    "scalar good_num_elapsed = $stopwatch",
    "series yhat_good_num = $yhat",
    "printf \"Good-start numerical NLS: L=%.4f a=%.4f b=%.4f elapsed=%.4f\\n\", L, a, b, good_num_elapsed",
    "series fit_gap = yhat_good_deriv - yhat_good_num",
    "summary fit_gap"
  ].join("\n");
}

function mixedFrequencyScript() {
  return [
    `open ${q(fedstlPath)}`,
    "setobs 4 2010:1",
    "smpl ; 2024:4",
    "data unrate --compact=average --name=unrate_avg",
    "data unrate --compact=first --name=unrate_first",
    "data unrate --compact=last --name=unrate_last",
    "data unrate --compact=sum --name=unrate_sum",
    "data unrate --compact=spread --name=unrate_spread",
    "data fedfunds --compact=last --name=rate_last",
    "series gdp_growth = 3 - 0.25*unrate_avg + 0.015*rate_last + normal()*0.15",
    "ols gdp_growth const unrate_avg rate_last --quiet",
    "scalar b_avg = $coeff(unrate_avg)",
    "ols gdp_growth const unrate_first rate_last --quiet",
    "scalar b_first = $coeff(unrate_first)",
    "ols gdp_growth const unrate_last rate_last --quiet",
    "scalar b_last = $coeff(unrate_last)",
    "ols gdp_growth const unrate_sum rate_last --quiet",
    "scalar b_sum = $coeff(unrate_sum)",
    "printf \"Compaction coefficient comparison: average=%.4f first=%.4f last=%.4f sum=%.4f\\n\", b_avg, b_first, b_last, b_sum",
    "summary unrate_spread_m1 unrate_spread_m2 unrate_spread_m3"
  ].join("\n");
}

function panelTournamentScript() {
  return [
    `open ${q(abdataPath)}`,
    "ols n const w k ys --quiet",
    "scalar pooled_b_w = $coeff(w)",
    "panel n const w k ys --fixed-effects --quiet",
    "scalar fe_b_w = $coeff(w)",
    "panel n const w k ys --random-effects --quiet",
    "scalar re_b_w = $coeff(w)",
    "series n_lag = n(-1)",
    "panel n const n_lag w k ys --fixed-effects --quiet",
    "scalar dyn_b_lag = $coeff(n_lag)",
    "diff n w k ys",
    "ols d_n const d_w d_k d_ys --quiet",
    "scalar fd_b_w = $coeff(d_w)",
    "list unit_dummies = dummify(unit)",
    "ols n const w k ys unit_dummies --quiet",
    "scalar manual_fe_b_w = $coeff(w)",
    "printf \"Panel tournament coefficient on w: pooled=%.4f FE=%.4f RE=%.4f FD=%.4f manual-FE=%.4f dynamic-lag=%.4f\\n\", pooled_b_w, fe_b_w, re_b_w, fd_b_w, manual_fe_b_w, dyn_b_lag"
  ].join("\n");
}

function garchVolatilityScript() {
  return [
    "set seed 2468",
    "nulldata 500",
    "genr time",
    "series ret = normal() * (0.5 + 1.2*(time > 250))",
    "arch 4 ret const time --quiet",
    "garch 1 1 ; ret --quiet",
    "series ht = $h",
    "series absret_next = abs(ret(+1))",
    "series high_vol = ht > quantile(ht, 0.75)",
    "series future_large = absret_next > quantile(absret_next, 0.75)",
    "ols future_large const high_vol --quiet",
    "scalar backtest_b = $coeff(high_vol)",
    "gnuplot ht --time-series --with-lines --output=garch_variance.png { set title 'GARCH conditional variance stress test'; set ylabel 'conditional variance'; set key off; }",
    "printf \"GARCH backtest slope high_vol -> next large abs return: %.4f\\n\", backtest_b",
    "summary ht"
  ].join("\n");
}

function ivSimulationScript() {
  return [
    "set seed 31415",
    "nulldata 1000",
    "series z = normal()",
    "series z2 = z + normal()*0.5",
    "series v = normal()",
    "series u = 0.7*v + normal()",
    "series x = 0.8*z + v",
    "series y = 1 + 2*x + u",
    "series zweak = 0.05*z + normal()",
    "series zinvalid = z + 0.8*u",
    "ols y const x --quiet",
    "scalar b_ols = $coeff(x)",
    "ols x const z --quiet",
    "scalar first_valid = $Fstat",
    "tsls y const x ; const z --quiet",
    "scalar b_iv_valid = $coeff(x)",
    "ols x const zweak --quiet",
    "scalar first_weak = $Fstat",
    "tsls y const x ; const zweak --quiet",
    "scalar b_iv_weak = $coeff(x)",
    "tsls y const x ; const zinvalid --quiet",
    "scalar b_iv_invalid = $coeff(x)",
    "tsls y const x ; const z z2 zinvalid --quiet",
    "matrix sargan = $sargan",
    "printf \"IV is not magic: OLS=%.4f valid-IV=%.4f weak-IV=%.4f invalid-IV=%.4f\\n\", b_ols, b_iv_valid, b_iv_weak, b_iv_invalid",
    "printf \"First-stage F: valid=%.4f weak=%.4f\\n\", first_valid, first_weak",
    "print sargan"
  ].join("\n");
}

function reproducibleProjectScript(project) {
  return [
    `set workdir ${q(project)}`,
    "set seed 98765",
    "nulldata 100",
    "setobs 4 2000:1",
    "# Project switches: edit these and rerun the script top to bottom.",
    "scalar use_robust = 1",
    "scalar use_logs = 1",
    "scalar start_year = 2005",
    "scalar end_year = 2024",
    "genr time",
    "series year = 2000 + floor((time - 1) / 4)",
    "series x = 10 + 0.2*time + normal()",
    "series y = exp(1 + 0.08*x + normal()*0.05)",
    "if use_logs == 1",
    "  series dep = log(y)",
    "  series reg = x",
    "else",
    "  series dep = y",
    "  series reg = x",
    "endif",
    "smpl year >= start_year && year <= end_year --restrict",
    "store data/simulated.csv y x dep reg --omit-obs",
    "outfile output/model-output.txt --quiet",
    "  if use_robust == 1",
    "    ols dep const reg --robust",
    "  else",
    "    ols dep const reg",
    "  endif",
    "end outfile",
    "gnuplot dep reg --fit=linear --output=output/fit.png { set title 'Reproducible Gretl project fit'; }",
    "gnuplot dep reg --fit=linear --output=output/fit.pdf { set title 'Reproducible Gretl project fit'; }",
    "outfile output/final-report.txt --quiet",
    "  printf \"Final report\\n\"",
    "  printf \"use_robust=%g use_logs=%g sample=%g-%g\\n\", use_robust, use_logs, start_year, end_year",
    "  printf \"All data, model output, and graphs were generated by main.inp.\\n\"",
    "end outfile",
    "printf \"Reproducible project completed in %s\\n\", $workdir"
  ].join("\n");
}
