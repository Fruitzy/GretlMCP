import { spawn } from "node:child_process";
import { constants, existsSync, statSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

export type GretlRunOptions = {
  script: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  keepWorkspace?: boolean;
  workspaceRoot?: string;
  gretlCliPath?: string;
};

export type GretlCommandRunOptions = Omit<GretlRunOptions, "script"> & {
  commands: string[];
};

export type GretlScriptFileOptions = {
  scriptPath: string;
  timeoutSeconds?: number;
  safeMode?: boolean;
  workingDirectory?: string;
  scriptOpt?: number;
  gretlCliPath?: string;
};

export type GretlPackageAction =
  | "install"
  | "query"
  | "run-sample"
  | "unload"
  | "remove"
  | "index";

export type GretlPackageOptions = Omit<GretlRunOptions, "script" | "safeMode"> & {
  action: GretlPackageAction;
  packageName?: string;
  local?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  staging?: boolean;
};

export type GretlMakePackageOptions = Omit<GretlRunOptions, "script" | "safeMode"> & {
  packagePath: string;
  index?: boolean;
  translations?: boolean;
  quiet?: boolean;
};

export type GretlRunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  workspace: string;
  scriptPath: string;
  artifacts: GretlArtifact[];
};

export type GretlCliRunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  workingDirectory: string;
  scriptPath?: string;
  artifacts: GretlArtifact[];
};

export type GretlVersionResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type GretlArtifact = {
  path: string;
  name: string;
  sizeBytes: number;
};

export type GretlGuideLearningLevel = "beginner" | "intermediate" | "advanced";

export type GretlGuideStep = {
  id: string;
  title: string;
  cue: string;
  gretlAction: string;
  whyItMatters: string;
};

export type GretlGuideScriptOptions = {
  datasetPath?: string;
  dependentVariable?: string;
  independentVariables?: string[];
  includeConstant?: boolean;
  learningLevel?: GretlGuideLearningLevel;
};

export type GretlGuideScript = {
  script: string;
  guideSteps: GretlGuideStep[];
  teachingNotes: string[];
  commonProblems: string[];
  usesDemoData: boolean;
};

export type GretlGuideFinding = {
  severity: "info" | "warning" | "danger";
  code: string;
  message: string;
  guidance: string;
};

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const PACKAGE_ACTIONS = new Set<GretlPackageAction>([
  "install",
  "query",
  "run-sample",
  "unload",
  "remove",
  "index"
]);
const UNSAFE_LINE_PATTERNS: RegExp[] = [
  /^\s*!/,
  /^\s*shell\b/i,
  /^\s*system\b/i,
  /^\s*foreign\b/i,
  /^\s*open\s+["']?(?:[a-zA-Z]:[\\/]|\\\\|\/)/i,
  /^\s*(?:store|outfile)\s+["']?(?:[a-zA-Z]:[\\/]|\\\\|\/)/i
];

const GRETL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class GretlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GretlSafetyError";
  }
}

export function resolveGretlCli(explicitPath?: string): string {
  const envPath = process.env.GRETL_CLI ?? process.env.GRETLMCP_GRETCLI;
  const candidates = [
    explicitPath,
    envPath,
    localWindowsPortablePath(),
    "C:\\Program Files\\gretl\\gretlcli.exe",
    "C:\\Program Files (x86)\\gretl\\gretlcli.exe",
    "gretlcli"
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (looksLikePath(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? "gretlcli";
}

export async function assertGretlCliAvailable(gretlCliPath?: string): Promise<string> {
  const command = resolveGretlCli(gretlCliPath);
  if (!looksLikePath(command)) {
    return command;
  }

  await access(command, constants.X_OK);
  return command;
}

export function validateSafeScript(script: string): void {
  const lines = script.split(/\r?\n/);
  const unsafeLine = lines.find((line) =>
    UNSAFE_LINE_PATTERNS.some((pattern) => pattern.test(line))
  );

  if (unsafeLine) {
    throw new GretlSafetyError(
      `Safe mode blocked this Gretl command: ${unsafeLine.trim()}`
    );
  }
}

export async function runGretlScript(options: GretlRunOptions): Promise<GretlRunResult> {
  const safeMode = options.safeMode ?? true;
  if (safeMode) {
    validateSafeScript(options.script);
  }

  const timeoutSeconds = clampTimeout(options.timeoutSeconds);
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  await mkdir(workspaceRoot, { recursive: true });

  const workspace = join(
    workspaceRoot,
    `gretl-run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
  );
  await mkdir(workspace, { recursive: true });

  const scriptPath = join(workspace, "script.inp");
  await writeFile(scriptPath, normalizeScript(options.script), "utf8");

  const command = await assertGretlCliAvailable(options.gretlCliPath);
  const args = ["--english", "--quiet", "--batch", scriptPath];
  const result = await runProcess(command, args, workspace, timeoutSeconds);
  const artifacts = await collectArtifacts(workspace, scriptPath);

  if (!options.keepWorkspace && artifacts.length === 0) {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    workspace,
    scriptPath,
    artifacts
  };
}

export async function runGretlCommands(
  options: GretlCommandRunOptions
): Promise<GretlRunResult> {
  return runGretlScript({
    ...options,
    script: buildCommandsScript(options.commands)
  });
}

export async function runGretlScriptFile(
  options: GretlScriptFileOptions
): Promise<GretlCliRunResult> {
  const scriptPath = resolveExistingLocalFilePath(options.scriptPath, "Script file");
  const workingDirectory = resolveExistingDirectory(
    options.workingDirectory ?? dirname(scriptPath)
  );

  const safeMode = options.safeMode ?? true;
  if (safeMode) {
    validateSafeScript(await readFile(scriptPath, "utf8"));
  }

  const timeoutSeconds = clampTimeout(options.timeoutSeconds);
  const command = await assertGretlCliAvailable(options.gretlCliPath);
  const args = ["--english", "--quiet", "--batch"];
  if (options.scriptOpt !== undefined) {
    args.push(`--scriptopt=${options.scriptOpt}`);
  }
  args.push(scriptPath);

  const result = await runProcess(command, args, workingDirectory, timeoutSeconds);
  return {
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    workingDirectory,
    scriptPath,
    artifacts: []
  };
}

export async function runGretlPackage(
  options: GretlPackageOptions
): Promise<GretlRunResult> {
  return runGretlScript({
    ...options,
    script: buildPackageScript(options),
    safeMode: false,
    keepWorkspace: options.keepWorkspace ?? true
  });
}

export async function runGretlMakePackage(
  options: GretlMakePackageOptions
): Promise<GretlRunResult> {
  const packagePath = resolvePackageOutputPath(options.packagePath);
  const result = await runGretlScript({
    ...options,
    script: buildMakePackageScript({
      ...options,
      packagePath
    }),
    safeMode: false,
    keepWorkspace: options.keepWorkspace ?? true
  });

  const packageArtifacts = await collectPackageArtifacts(
    packagePath,
    options.index,
    options.translations
  );

  return {
    ...result,
    artifacts: mergeArtifacts(result.artifacts, packageArtifacts)
  };
}

export async function runGretlVersion(gretlCliPath?: string): Promise<GretlVersionResult> {
  const command = await assertGretlCliAvailable(gretlCliPath);
  const args = ["--version"];
  const result = await runProcess(command, args, process.cwd(), 15);

  return {
    command,
    args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function buildDatasetSummaryScript(datasetPath: string): string {
  return [
    `open ${quoteGretlPath(datasetPath)}`,
    "summary",
    "corr"
  ].join(EOL);
}

export function resolveExistingDatasetPath(datasetPath: string): string {
  return resolveExistingLocalFilePath(datasetPath, "Dataset file");
}

export function buildOlsScript(
  datasetPath: string,
  dependentVariable: string,
  independentVariables: string[],
  includeConstant = true
): string {
  assertGretlIdentifier(dependentVariable);
  for (const independentVariable of independentVariables) {
    assertGretlIdentifier(independentVariable);
  }

  const regressors = [
    includeConstant ? "const" : undefined,
    ...independentVariables
  ].filter(Boolean);

  return [
    `open ${quoteGretlPath(datasetPath)}`,
    `ols ${dependentVariable} ${regressors.join(" ")}`
  ].join(EOL);
}

export function buildGuideModeScript(
  options: GretlGuideScriptOptions = {}
): GretlGuideScript {
  const usesDemoData = !hasGuideDatasetInput(options);
  if (!usesDemoData) {
    assertCompleteGuideDatasetInput(options);
  }

  const includeConstant = options.includeConstant ?? true;
  const dependentVariable = usesDemoData ? "y" : options.dependentVariable!;
  const independentVariables = usesDemoData
    ? ["x1", "x2", "time"]
    : options.independentVariables!;

  assertGretlIdentifier(dependentVariable);
  for (const independentVariable of independentVariables) {
    assertGretlIdentifier(independentVariable);
  }

  const regressors = [
    includeConstant ? "const" : undefined,
    ...independentVariables
  ].filter(Boolean);
  const guideSteps = buildGuideSteps(usesDemoData);
  const teachingNotes = buildTeachingNotes(options.learningLevel ?? "beginner");
  const commonProblems = [
    "Wrong sample: observations can be silently dropped by missing values or active sample restrictions.",
    "Bad specification: residual tests often reveal nonlinearity, omitted variables, or wrong dynamics.",
    "Heteroskedasticity: standard errors can be misleading even when coefficients look reasonable.",
    "Autocorrelation: time-series models often need lags, dynamics, or different estimators.",
    "Multicollinearity: variables can overlap so much that individual coefficients become unstable.",
    "Influential observations: a small number of rows can dominate the fitted model."
  ];

  const lines = [
    "# GretlMCP native guide mode",
    "# The visible Gretl GUI runs this Hansl script directly; no screenshots or image scraping are used.",
    "# Follow the => guide cues in the script and output while Gretl executes each step.",
    printfLine("@@GRETLMCP_GUIDE_STEP|1|Orient to the data|Open data, check sample size, and inspect variables."),
    printfLine("=> Step 1/6: Orient to the data in Gretl. Look at the dataset window, sample range, and variable list."),
    ...buildGuideDataSetupLines(options, usesDemoData),
    "summary",
    "corr",
    printfLine("@@GRETLMCP_GUIDE_STEP|2|Estimate the baseline model|Fit OLS and read coefficient signs before trusting p-values."),
    printfLine("=> Step 2/6: Estimate the baseline OLS model. Ask: do signs and sizes make domain sense?"),
    `ols ${dependentVariable} ${regressors.join(" ")}`,
    printfLine("@@GRETLMCP_GUIDE_STEP|3|Check residual normality|Use normality as an outlier and small-sample warning, not as a pass/fail grade."),
    printfLine("=> Step 3/6: Check residual normality. If it fails, inspect outliers and transformations."),
    "modtest --normality --silent",
    "scalar gretlmcp_normality_p = $pvalue",
    "printf \"Normality test p-value = %.4f\\n\", gretlmcp_normality_p",
    "if gretlmcp_normality_p < 0.05",
    `  ${findingPrintf("warning", "nonnormal_residuals", "Residuals are not normally distributed.", "Inspect outliers, nonlinear transformations, or robust inference.")}`,
    "else",
    `  ${findingPrintf("info", "normality_not_rejected", "Residual normality was not rejected.", "Continue checking variance, dynamics, and specification.")}`,
    "endif",
    printfLine("@@GRETLMCP_GUIDE_STEP|4|Check variance and dynamics|White and autocorrelation tests flag common beginner mistakes."),
    printfLine("=> Step 4/6: Check heteroskedasticity and autocorrelation. These change how you trust standard errors."),
    "modtest --white --silent",
    "scalar gretlmcp_white_p = $pvalue",
    "printf \"White test p-value = %.4f\\n\", gretlmcp_white_p",
    "if gretlmcp_white_p < 0.05",
    `  ${findingPrintf("warning", "heteroskedasticity", "Residual variance changes across observations.", "Try robust standard errors, transformations, or a better variance model.")}`,
    "else",
    `  ${findingPrintf("info", "heteroskedasticity_not_rejected", "White test did not reject constant variance.", "Still check plots and domain-specific variance changes.")}`,
    "endif",
    "modtest 4 --autocorr --silent",
    "scalar gretlmcp_autocorr_p = $pvalue",
    "printf \"Autocorrelation test p-value = %.4f\\n\", gretlmcp_autocorr_p",
    "if gretlmcp_autocorr_p < 0.05",
    `  ${findingPrintf("warning", "autocorrelation", "Residuals are correlated over time.", "Add lags, model dynamics, or use a time-series estimator when appropriate.")}`,
    "else",
    `  ${findingPrintf("info", "autocorrelation_not_rejected", "Autocorrelation was not rejected at lag 4.", "Keep checking if the data frequency suggests other lags.")}`,
    "endif",
    printfLine("@@GRETLMCP_GUIDE_STEP|5|Check form and variable overlap|RESET and VIF show if the equation is hard to trust."),
    printfLine("=> Step 5/6: Check functional form and multicollinearity. These are common sources of confusing Gretl output."),
    "reset --silent",
    "scalar gretlmcp_reset_p = $pvalue",
    "printf \"RESET p-value = %.4f\\n\", gretlmcp_reset_p",
    "if gretlmcp_reset_p < 0.05",
    `  ${findingPrintf("warning", "reset_rejected", "RESET rejects the current functional form.", "Consider nonlinear terms, interactions, missing variables, or a different model family.")}`,
    "else",
    `  ${findingPrintf("info", "reset_not_rejected", "RESET did not reject the current functional form.", "This is not proof the model is right; it only removes one warning sign.")}`,
    "endif",
    "vif --quiet",
    "matrix gretlmcp_vif = $result",
    "scalar gretlmcp_max_vif = max(gretlmcp_vif)",
    "printf \"Maximum VIF = %.4f\\n\", gretlmcp_max_vif",
    "if gretlmcp_max_vif > 10",
    `  ${findingPrintf("warning", "high_multicollinearity", "One or more regressors have very high VIF.", "Remove redundant variables, combine measures, or interpret individual coefficients carefully.")}`,
    "elif gretlmcp_max_vif > 5",
    `  ${findingPrintf("warning", "moderate_multicollinearity", "Some regressors overlap strongly.", "Check whether the variables measure the same concept.")}`,
    "else",
    `  ${findingPrintf("info", "multicollinearity_low", "VIF values are not high.", "Coefficient instability from variable overlap is less likely here.")}`,
    "endif",
    printfLine("@@GRETLMCP_GUIDE_STEP|6|Check influential rows and choose next action|Do not stop at one model; decide what to fix or explain."),
    printfLine("=> Step 6/6: Check influential observations, then choose the next model improvement deliberately."),
    "leverage --save --overwrite --quiet",
    "scalar gretlmcp_max_influence = max(abs(influ))",
    "printf \"Maximum influence value = %.4f\\n\", gretlmcp_max_influence",
    "if gretlmcp_max_influence > 1",
    `  ${findingPrintf("warning", "influential_observations", "Influential observations may dominate the model.", "Inspect those rows in the Gretl data window before removing or explaining them.")}`,
    "else",
    `  ${findingPrintf("info", "influence_not_extreme", "No extreme influence value was detected.", "Still inspect unusual observations if the domain suggests data quality issues.")}`,
    "endif",
    printfLine("=> Guide complete: use the findings above as a learning checklist, not an automatic final answer."),
    "printf \"Model guide finished for dependent variable: " +
      escapeGretlString(dependentVariable) +
      "\\n\""
  ];

  return {
    script: lines.join(EOL),
    guideSteps,
    teachingNotes,
    commonProblems,
    usesDemoData
  };
}

export function parseGuideFindings(stdout: string): GretlGuideFinding[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("@@GRETLMCP_FINDING|"))
    .map((line) => {
      const [, severity, code, message, ...guidanceParts] = line.split("|");
      return {
        severity: normalizeGuideSeverity(severity),
        code: code || "unknown",
        message: message || "",
        guidance: guidanceParts.join("|")
      };
    });
}

export function buildHelpScript(commandName: string): string {
  assertGretlIdentifier(commandName);
  return `help ${commandName}`;
}

export function buildCapabilitiesScript(options?: {
  includeFunctions?: boolean;
  includePackageHelp?: boolean;
}): string {
  const includeFunctions = options?.includeFunctions ?? true;
  const includePackageHelp = options?.includePackageHelp ?? true;
  return [
    "help",
    includeFunctions ? "help functions" : undefined,
    includePackageHelp ? "help pkg" : undefined,
    includePackageHelp ? "help makepkg" : undefined
  ]
    .filter(Boolean)
    .join(EOL);
}

export function buildCommandsScript(commands: string[]): string {
  if (commands.length === 0) {
    throw new Error("At least one Gretl command is required.");
  }

  return commands
    .map((command) => {
      const trimmed = command.trim();
      if (!trimmed) {
        throw new Error("Gretl commands cannot be empty.");
      }
      return trimmed;
    })
    .join(EOL);
}

export function buildPackageScript(options: {
  action: GretlPackageAction;
  packageName?: string;
  local?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  staging?: boolean;
}): string {
  assertPackageAction(options.action);
  const packageName =
    options.action === "index" ? options.packageName ?? "addons" : options.packageName;

  if (!packageName) {
    throw new Error(`Package name is required for pkg ${options.action}.`);
  }

  const flags = [
    options.local ? "--local" : undefined,
    options.quiet ? "--quiet" : undefined,
    options.verbose ? "--verbose" : undefined,
    options.staging ? "--staging" : undefined
  ].filter(Boolean);

  return [`pkg ${options.action} ${quoteGretlArgument(packageName)}`, ...flags].join(" ");
}

export function buildMakePackageScript(options: {
  packagePath: string;
  index?: boolean;
  translations?: boolean;
  quiet?: boolean;
}): string {
  const packagePath = resolvePackageOutputPath(options.packagePath);
  const flags = [
    options.index ? "--index" : undefined,
    options.translations ? "--translations" : undefined,
    options.quiet ? "--quiet" : undefined
  ].filter(Boolean);

  return [`makepkg ${quoteGretlPath(packagePath)}`, ...flags].join(" ");
}

export function assertGretlIdentifier(value: string): void {
  if (!GRETL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid Gretl identifier: ${value}`);
  }
}

export function resolveExistingLocalFilePath(filePath: string, label = "File"): string {
  if (/[\r\n"]/.test(filePath)) {
    throw new Error(`${label} paths cannot contain quotes or line breaks.`);
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(filePath)) {
    throw new Error(`${label} paths must be local files, not URLs.`);
  }

  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isFile()) {
    throw new Error(`${label} path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

function assertPackageAction(action: GretlPackageAction): void {
  if (!PACKAGE_ACTIONS.has(action)) {
    throw new Error(`Unsupported Gretl package action: ${action}`);
  }
}

function hasGuideDatasetInput(options: GretlGuideScriptOptions): boolean {
  return Boolean(
    options.datasetPath ||
      options.dependentVariable ||
      options.independentVariables?.length
  );
}

function assertCompleteGuideDatasetInput(options: GretlGuideScriptOptions): void {
  if (!options.datasetPath || !options.dependentVariable || !options.independentVariables?.length) {
    throw new Error(
      "Guide mode needs datasetPath, dependentVariable, and at least one independentVariable together. Omit all three to use demo data."
    );
  }
}

function buildGuideDataSetupLines(
  options: GretlGuideScriptOptions,
  usesDemoData: boolean
): string[] {
  if (!usesDemoData) {
    return [`open ${quoteGretlPath(options.datasetPath!)}`];
  }

  return [
    "set seed 5252",
    "nulldata 180",
    "setobs 12 2010:01",
    "genr time",
    "series x1 = normal()",
    "series x2 = 0.95*x1 + normal()*0.15",
    "series e = normal() * (0.4 + abs(x1))",
    "series y = 1 + 0.5*x1 + 0.3*x2 + 0.02*time + e",
    printfLine("Demo data loaded: it intentionally contains overlap and changing variance so the guide has real problems to find.")
  ];
}

function buildGuideSteps(usesDemoData: boolean): GretlGuideStep[] {
  return [
    {
      id: "orient-data",
      title: "Orient to the data",
      cue: "=> Look at the Gretl data window, sample range, and variable list.",
      gretlAction: usesDemoData
        ? "Generate a demo dataset with known model problems."
        : "Open the provided local dataset.",
      whyItMatters:
        "Many Gretl mistakes start with the wrong active sample, missing values, or misunderstood variables."
    },
    {
      id: "baseline-ols",
      title: "Estimate the baseline model",
      cue: "=> Read coefficient signs and sizes before looking only at p-values.",
      gretlAction: "Run OLS for the selected dependent and independent variables.",
      whyItMatters:
        "A model can be statistically significant but still economically or logically wrong."
    },
    {
      id: "normality",
      title: "Check residual normality",
      cue: "=> Treat failure as a prompt to inspect outliers or transformations.",
      gretlAction: "Run Gretl residual normality diagnostics.",
      whyItMatters:
        "Non-normal residuals often reveal outliers, skew, or a model that misses important structure."
    },
    {
      id: "variance-dynamics",
      title: "Check variance and dynamics",
      cue: "=> White and autocorrelation tests explain why standard errors may be unreliable.",
      gretlAction: "Run White and autocorrelation tests.",
      whyItMatters:
        "Unreliable standard errors can make a user trust relationships that are not actually supported."
    },
    {
      id: "form-overlap",
      title: "Check form and variable overlap",
      cue: "=> RESET and VIF point to missing nonlinear structure or redundant regressors.",
      gretlAction: "Run RESET and VIF diagnostics.",
      whyItMatters:
        "This is where users often discover that the equation, not Gretl, is the problem."
    },
    {
      id: "influence-next-action",
      title: "Check influential rows and choose next action",
      cue: "=> Inspect influential observations before changing the model.",
      gretlAction: "Run leverage and influence diagnostics.",
      whyItMatters:
        "A few unusual rows can change the story; the user should learn whether to fix data or explain it."
    }
  ];
}

function buildTeachingNotes(level: GretlGuideLearningLevel): string[] {
  const notes = [
    "Gretl is the working surface: the generated script, output, and model windows are the guide.",
    "The arrow cues tell the user where to look next while the real Gretl workflow runs.",
    "Findings are teaching prompts. They do not automatically prove a model is wrong or right."
  ];

  if (level === "beginner") {
    return [
      ...notes,
      "Beginner rule: first understand the data and graph suspicious variables before changing commands."
    ];
  }

  if (level === "intermediate") {
    return [
      ...notes,
      "Intermediate rule: compare at least one alternative specification before trusting inference."
    ];
  }

  return [
    ...notes,
    "Advanced rule: connect every diagnostic warning to identification, estimator choice, or data-generating process assumptions."
  ];
}

function printfLine(text: string): string {
  return `printf "${escapeGretlString(text)}\\n"`;
}

function findingPrintf(
  severity: GretlGuideFinding["severity"],
  code: string,
  message: string,
  guidance: string
): string {
  return printfLine(`@@GRETLMCP_FINDING|${severity}|${code}|${message}|${guidance}`);
}

function escapeGretlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeGuideSeverity(value: string): GretlGuideFinding["severity"] {
  return value === "warning" || value === "danger" || value === "info"
    ? value
    : "info";
}

function resolveExistingDirectory(directoryPath: string): string {
  const resolvedPath = resolve(directoryPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Working directory does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`Working directory path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

function resolvePackageOutputPath(packagePath: string): string {
  if (/[\r\n"]/.test(packagePath)) {
    throw new Error("Package paths cannot contain quotes or line breaks.");
  }

  const resolvedPath = resolve(packagePath);
  const extension = extname(resolvedPath).toLowerCase();
  if (extension !== ".gfn" && extension !== ".zip") {
    throw new Error("Gretl package output path must end in .gfn or .zip.");
  }

  return resolvedPath;
}

function localWindowsPortablePath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    return undefined;
  }

  return join(userProfile, "tools", "gretl", "gretlcli.exe");
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes(sep) || /[a-zA-Z]:\\/.test(value);
}

function resolveWorkspaceRoot(workspaceRoot?: string): string {
  return resolve(
    workspaceRoot ??
      process.env.GRETLMCP_WORKSPACE_DIR ??
      join(process.cwd(), ".gretl-mcp-runs")
  );
}

function clampTimeout(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return Math.min(Math.floor(timeoutSeconds), MAX_TIMEOUT_SECONDS);
}

function normalizeScript(script: string): string {
  const trimmed = script.trim();
  return `${trimmed}${EOL}`;
}

function quoteGretlPath(path: string): string {
  if (/[\r\n"]/.test(path)) {
    throw new Error("Gretl paths cannot contain quotes or line breaks.");
  }

  return `"${path.replace(/\\/g, "/")}"`;
}

function quoteGretlArgument(value: string): string {
  if (/[\r\n"]/.test(value)) {
    throw new Error("Gretl arguments cannot contain quotes or line breaks.");
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value)) {
    return value;
  }

  if (/^[A-Za-z0-9_.+-]+$/.test(value)) {
    return value;
  }

  return quoteGretlPath(value);
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number
): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, timedOut, stdout, stderr });
    });
  });
}

async function collectArtifacts(workspace: string, scriptPath: string): Promise<GretlArtifact[]> {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
  const artifacts: GretlArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const path = join(entry.parentPath ?? workspace, entry.name);
    if (path === scriptPath) {
      continue;
    }

    const fileStat = await stat(path);
    artifacts.push({
      path,
      name: basename(path),
      sizeBytes: fileStat.size
    });
  }

  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectPackageArtifacts(
  packagePath: string,
  includeIndex?: boolean,
  includeTranslations?: boolean
): Promise<GretlArtifact[]> {
  const artifacts: GretlArtifact[] = [];
  const extension = extname(packagePath);
  const basenameWithoutExtension = packagePath.slice(0, -extension.length);
  const candidates = [
    packagePath,
    includeIndex ? `${basenameWithoutExtension}.xml` : undefined,
    includeTranslations ? `${basenameWithoutExtension}-i18n.c` : undefined
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) {
      continue;
    }

    artifacts.push({
      path: candidate,
      name: basename(candidate),
      sizeBytes: fileStat.size
    });
  }

  return artifacts;
}

function mergeArtifacts(
  primaryArtifacts: GretlArtifact[],
  secondaryArtifacts: GretlArtifact[]
): GretlArtifact[] {
  const byPath = new Map<string, GretlArtifact>();
  for (const artifact of [...primaryArtifacts, ...secondaryArtifacts]) {
    byPath.set(artifact.path, artifact);
  }

  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}
