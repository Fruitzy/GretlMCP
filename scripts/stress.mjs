import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runRoot = await mkdtemp(join(tmpdir(), "gretl-mcp-stress-"));
const distIndex = resolve(repoRoot, "dist/index.js");
const gretlRoot = await resolveGretlRoot();
const fedstlPath = join(gretlRoot, "db", "fedstl.bin");
const abdataPath = join(gretlRoot, "data", "misc", "abdata.gdt");
const greeneConsumptionPath = join(gretlRoot, "data", "greene", "greene11_3.gdt");
const externalRuntimePath = await resolveExternalRuntimePath();

if (externalRuntimePath) {
  prependProcessPath(dirname(externalRuntimePath));
}

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

  await runScriptCase("01-macro-forecasting-pipeline", macroForecastingScript(), [
    "Macro forecasting pipeline",
    "Expanding-window RMSE",
    "ARIMA model estimated",
    "VAR model estimated"
  ], { safeMode: false });

  await runScriptCase("02-structural-break-detection", structuralBreakScript(), [
    "Structural break detection",
    "Endogenous break search",
    "Baseline CUSUM"
  ], { safeMode: false, expectArtifacts: ["cusum.png", "cusumsq.png", "rolling_coeff.png"] });

  await runScriptCase("03-monte-carlo-ols-failure", monteCarloScript(), [
    "Monte Carlo OLS failure table",
    "homoskedastic",
    "measurement_error",
    "heavy_tail"
  ]);

  await runScriptCase("04-textbook-result-spec-curve", textbookSpecCurveScript(), [
    "Textbook replication and stress test",
    "Specification curve"
  ], { safeMode: false, expectArtifacts: ["spec_curve.png"] });

  await runScriptCase("05-diagnostic-engine", diagnosticEngineScript(), [
    "Automated diagnostic engine",
    "Model risk score",
    "Model probably invalid because"
  ]);

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

async function resolveExternalRuntimePath() {
  const commands = [
    { command: "python", args: ["--version"] },
    { command: "Rscript", args: ["--version"] },
    { command: "octave", args: ["--version"] }
  ];

  for (const candidate of commands) {
    if (await commandWorks(candidate.command, candidate.args)) {
      return undefined;
    }
  }

  for (const pythonPath of windowsPythonCandidates()) {
    try {
      await access(pythonPath, constants.X_OK);
      if (await commandWorks(pythonPath, ["--version"])) {
        return pythonPath;
      }
    } catch {
      // Try the next common user-scoped Python install path.
    }
  }

  return undefined;
}

function windowsPythonCandidates() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
    return [];
  }

  return ["Python313", "Python312", "Python311", "Python310"].map((versionDir) =>
    join(process.env.LOCALAPPDATA, "Programs", "Python", versionDir, "python.exe")
  );
}

function prependProcessPath(directory) {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const existing = currentPath.split(delimiter).filter(Boolean);

  if (existing.some((entry) => entry.toLowerCase() === directory.toLowerCase())) {
    return;
  }

  process.env[pathKey] = [directory, ...existing].join(delimiter);
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
      await access(join(candidate, "data", "greene", "greene11_3.gdt"), constants.R_OK);
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

function macroForecastingScript() {
  return [
    `open ${q(fedstlPath)}`,
    "setobs 12 2010:01",
    "smpl ; 2024:12",
    "data unrate cpiaucsl fedfunds indpro",
    "series infl = 1200 * (log(cpiaucsl) - log(cpiaucsl(-1)))",
    "series ip_growth = 1200 * (log(indpro) - log(indpro(-1)))",
    "series dunrate = unrate - unrate(-1)",
    "series drate = fedfunds - fedfunds(-1)",
    "adf 12 infl --c --quiet",
    "adf 12 ip_growth --c --quiet",
    "smpl 2011:02 2020:12",
    "ols infl const infl(-1) dunrate(-1) drate(-1) ip_growth(-1) --quiet",
    "fcast 2021:01 2024:12 1 fc_expanding --recursive --quiet",
    "arima 1 0 1 ; infl --quiet",
    "printf \"ARIMA model estimated: AIC=%.4f\\n\", $aic",
    "var 2 infl dunrate drate ip_growth --quiet",
    "printf \"VAR model estimated for transformed macro system\\n\"",
    "smpl 2021:01 2024:12",
    "series fc_naive = infl(-1)",
    "series err_expanding = infl - fc_expanding",
    "series err_naive = infl - fc_naive",
    "series hit_expanding = (infl * fc_expanding) > 0",
    "scalar rmse_expanding = sqrt(mean(err_expanding^2))",
    "scalar mae_expanding = mean(abs(err_expanding))",
    "scalar dir_expanding = mean(hit_expanding)",
    "scalar rmse_naive = sqrt(mean(err_naive^2))",
    "printf \"Macro forecasting pipeline\\n\"",
    "printf \"Expanding-window RMSE=%.4f MAE=%.4f directional accuracy=%.4f naive RMSE=%.4f\\n\", rmse_expanding, mae_expanding, dir_expanding, rmse_naive",
    "printf \"Model-selection conclusion: compare expanding OLS against naive, ARIMA, and VAR diagnostics before choosing production model.\\n\""
  ].join("\n");
}

function structuralBreakScript() {
  return [
    `open ${q(fedstlPath)}`,
    "setobs 12 2000:01",
    "smpl ; 2024:12",
    "data unrate cpiaucsl fedfunds",
    "genr time",
    "series infl = 1200 * (log(cpiaucsl) - log(cpiaucsl(-1)))",
    "ols infl const unrate fedfunds --quiet",
    "cusum --plot=cusum.png",
    "printf \"Baseline CUSUM completed\\n\"",
    "cusum --squares --plot=cusumsq.png",
    "chow 2020:03 --quiet",
    "scalar best_ssr = 1.0e100",
    "scalar best_break = 0",
    "series roll_b = NA",
    "loop i=80..250 --quiet",
    "  smpl 1 i",
    "  ols infl const unrate fedfunds --quiet",
    "  scalar bi = $coeff(unrate)",
    "  smpl full",
    "  roll_b[i] = bi",
    "  series split = time >= i",
    "  series split_unrate = split * unrate",
    "  series split_rate = split * fedfunds",
    "  ols infl const unrate fedfunds split split_unrate split_rate --quiet",
    "  if $ess < best_ssr",
    "    scalar best_ssr = $ess",
    "    scalar best_break = i",
    "  endif",
    "endloop",
    "gnuplot roll_b --time-series --with-lines --output=rolling_coeff.png { set title 'Rolling unemployment coefficient'; set key off; }",
    "printf \"Structural break detection\\n\"",
    "printf \"Endogenous break search: best observation index=%g SSR=%.4f\\n\", best_break, best_ssr"
  ].join("\n");
}

function monteCarloScript() {
  return [
    "set seed 4242",
    "nulldata 120",
    "scalar reps = 1000",
    "matrix out = zeros(6, 5)",
    "strings names = defarray(\"homoskedastic\", \"heteroskedastic\", \"autocorrelated\", \"endogeneity\", \"measurement_error\", \"heavy_tail\")",
    "loop c=1..6 --quiet",
    "  scalar sum_b = 0",
    "  scalar sum_b2 = 0",
    "  scalar sum_sqerr = 0",
    "  scalar reject = 0",
    "  scalar cover = 0",
    "  loop r=1..1000 --quiet",
    "    series xtrue = normal()",
    "    series x = xtrue",
    "    series e = normal()",
    "    if c == 2",
    "      series e = normal() * (0.5 + abs(xtrue))",
    "    elif c == 3",
    "      series e = normal()",
    "      series e = 0.65*e(-1) + normal()",
    "    elif c == 4",
    "      series v = normal()",
    "      series x = xtrue + v",
    "      series e = 0.8*v + normal()",
    "    elif c == 5",
    "      series x = xtrue + normal()*0.8",
    "    elif c == 6",
    "      series e = normal() * (1 + 5*(uniform() < 0.05))",
    "    endif",
    "    series y = 1 + xtrue + e",
    "    ols y const x --quiet",
    "    scalar b = $coeff(x)",
    "    scalar se = $stderr(x)",
    "    scalar t = (b - 1) / se",
    "    scalar sum_b += b",
    "    scalar sum_b2 += b^2",
    "    scalar sum_sqerr += (b - 1)^2",
    "    scalar reject += abs(t) > 1.96",
    "    scalar cover += (b - 1.96*se <= 1) && (b + 1.96*se >= 1)",
    "  endloop",
    "  scalar mean_b = sum_b / reps",
    "  out[c,1] = mean_b - 1",
    "  out[c,2] = sum_b2/reps - mean_b^2",
    "  out[c,3] = sqrt(sum_sqerr / reps)",
    "  out[c,4] = reject / reps",
    "  out[c,5] = cover / reps",
    "endloop",
    "printf \"Monte Carlo OLS failure table\\n\"",
    "printf \"case bias variance rmse rejection coverage\\n\"",
    "loop c=1..6 --quiet",
    "  printf \"%s %.4f %.4f %.4f %.4f %.4f\\n\", names[c], out[c,1], out[c,2], out[c,3], out[c,4], out[c,5]",
    "endloop"
  ].join("\n");
}

function textbookSpecCurveScript() {
  return [
    `open ${q(greeneConsumptionPath)}`,
    "ols C const Y --quiet",
    "scalar base_b = $coeff(Y)",
    "scalar base_se = $stderr(Y)",
    "series lC = log(C)",
    "series lY = log(Y)",
    "matrix specs = zeros(6, 2)",
    "specs[1,1] = 1",
    "specs[1,2] = base_b",
    "ols C const Y --robust --quiet",
    "specs[2,1] = 2",
    "specs[2,2] = $coeff(Y)",
    "ols lC const lY --quiet",
    "specs[3,1] = 3",
    "specs[3,2] = $coeff(lY)",
    "smpl 1 20",
    "ols C const Y --quiet",
    "specs[4,1] = 4",
    "specs[4,2] = $coeff(Y)",
    "smpl 21 36",
    "ols C const Y --quiet",
    "specs[5,1] = 5",
    "specs[5,2] = $coeff(Y)",
    "smpl full",
    "series outlier = C > quantile(C, 0.95)",
    "smpl outlier == 0 --restrict",
    "ols C const Y --quiet",
    "specs[6,1] = 6",
    "specs[6,2] = $coeff(Y)",
    "smpl full",
    "gnuplot 2 1 --matrix=specs --with-lines --output=spec_curve.png { set title 'Specification curve: income coefficient'; set xlabel 'specification'; set ylabel 'coefficient'; set key off; }",
    "printf \"Textbook replication and stress test\\n\"",
    "printf \"Base Greene consumption coefficient on Y=%.6f SE=%.6f\\n\", base_b, base_se",
    "printf \"Specification curve created with 6 plausible variants\\n\""
  ].join("\n");
}

function diagnosticEngineScript() {
  return [
    "set seed 5252",
    "nulldata 180",
    "setobs 12 2010:01",
    "genr time",
    "series x1 = normal()",
    "series x2 = 0.95*x1 + normal()*0.15",
    "series e = normal() * (0.4 + abs(x1))",
    "series y = 1 + 0.5*x1 + 0.3*x2 + 0.02*time + e",
    "function scalar diagnostic_engine(series yvar, list X)",
    "  ols yvar const X --quiet",
    "  scalar risk = 0",
    "  string reasons = \"\"",
    "  modtest --normality --silent",
    "  if $pvalue < 0.05",
    "    scalar risk += 15",
    "    string reasons += \" nonnormal_residuals\"",
    "  endif",
    "  modtest --white --silent",
    "  if $pvalue < 0.05",
    "    scalar risk += 20",
    "    string reasons += \" heteroskedasticity\"",
    "  endif",
    "  modtest 4 --autocorr --silent",
    "  if $pvalue < 0.05",
    "    scalar risk += 20",
    "    string reasons += \" autocorrelation\"",
    "  endif",
    "  reset --silent",
    "  if $pvalue < 0.05",
    "    scalar risk += 20",
    "    string reasons += \" RESET_rejected\"",
    "  endif",
    "  vif --quiet",
    "  matrix v = $result",
    "  if max(v) > 10",
    "    scalar risk += 15",
    "    string reasons += \" multicollinearity\"",
    "  endif",
    "  leverage --save --overwrite --quiet",
    "  if max(abs(influ)) > 1",
    "    scalar risk += 10",
    "    string reasons += \" influential_observations\"",
    "  endif",
    "  if strlen(reasons) == 0",
    "    string reasons = \" none\"",
    "  endif",
    "  ols yvar const X --robust --quiet",
    "  printf \"Automated diagnostic engine\\n\"",
    "  printf \"Model probably invalid because:%s\\n\", reasons",
    "  printf \"Model risk score = %.1f\\n\", risk",
    "  return risk",
    "end function",
    "list X = x1 x2 time",
    "scalar risk_score = diagnostic_engine(y, X)"
  ].join("\n");
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
