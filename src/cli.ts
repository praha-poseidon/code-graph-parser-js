#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReactCodeGraphParser } from "./parser/react-code-graph-parser.js";
import type { ParseRequest } from "./model/process-protocol.js";
import { toGraphDelta } from "./model/process-protocol.js";

interface CliArgs {
  project?: string;
  out?: string;
  rules?: string;
  serRule?: string[];
  serRuleText?: string[];
  traceRule?: string[];
  traceRuleText?: string[];
  externalValues?: string;
  staticExtractBuiltin?: boolean;
  staticExtractPreset?: boolean | string[];
  noLegacyEndpointInference?: boolean;
  tsconfig?: string;
  projectName?: string;
  request?: string;
  stdio?: boolean;
  delta?: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.stdio || args.request) {
    await runProcessProtocol(args);
    return;
  }

  if (!args.project) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const projectRoot = path.resolve(args.project);
  const rulesDir = args.rules ? path.resolve(args.rules) : defaultRulesDir();
  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot,
    projectName: args.projectName,
    tsConfigPath: args.tsconfig ? path.resolve(args.tsconfig) : undefined,
    endpointRulesDir: rulesDir,
    ruleSources: args.serRule?.map((rule) => path.resolve(rule)),
    ruleTexts: args.serRuleText,
    traceRuleSources: args.traceRule?.map((rule) => path.resolve(rule)),
    traceRuleTexts: args.traceRuleText,
    externalValuesFile: args.externalValues ? path.resolve(args.externalValues) : undefined,
    staticExtractBuiltinRules: args.staticExtractBuiltin,
    staticExtractPresetRules: args.staticExtractPreset,
    legacyEndpointInference: !args.noLegacyEndpointInference
  });

  const payload = JSON.stringify(args.delta
    ? toGraphDelta({ graph: result.graph, request: requestFromArgs(args, projectRoot), projectName: resultProjectName(args, projectRoot), projectRoot })
    : result.graph, null, 2);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), `${payload}\n`, "utf8");
  } else {
    process.stdout.write(`${payload}\n`);
  }

  process.stderr.write(
    `Parsed ${result.stats.files} files, ` +
      `${result.stats.units} units, ${result.stats.functions} functions, ` +
      `${result.stats.endpoints} endpoints, ${result.stats.relationships} relationships.\n`
  );
}

function parseArgs(argv: string[]): CliArgs {
  const output: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--project" || arg === "-p") && next) {
      output.project = next;
      index += 1;
    } else if ((arg === "--out" || arg === "-o") && next) {
      output.out = next;
      index += 1;
    } else if (arg === "--rules" && next) {
      output.rules = next;
      index += 1;
    } else if (arg === "--ser-rule" && next) {
      output.serRule = [...output.serRule ?? [], next];
      index += 1;
    } else if (arg === "--ser-rule-text" && next) {
      output.serRuleText = [...output.serRuleText ?? [], next];
      index += 1;
    } else if (arg === "--trace-rule" && next) {
      output.traceRule = [...output.traceRule ?? [], next];
      index += 1;
    } else if (arg === "--trace-rule-text" && next) {
      output.traceRuleText = [...output.traceRuleText ?? [], next];
      index += 1;
    } else if (arg === "--external-values" && next) {
      output.externalValues = next;
      index += 1;
    } else if (arg === "--static-extract-builtin") {
      output.staticExtractBuiltin = true;
    } else if (arg === "--static-extract-preset") {
      if (next && !next.startsWith("-")) {
        output.staticExtractPreset = [...presetArray(output.staticExtractPreset), ...next.split(",")];
        index += 1;
      } else {
        output.staticExtractPreset = true;
      }
    } else if (arg === "--no-legacy-endpoint-inference") {
      output.noLegacyEndpointInference = true;
    } else if (arg === "--tsconfig" && next) {
      output.tsconfig = next;
      index += 1;
    } else if (arg === "--project-name" && next) {
      output.projectName = next;
      index += 1;
    } else if (arg === "--request" && next) {
      output.request = next;
      index += 1;
    } else if (arg === "--stdio") {
      output.stdio = true;
    } else if (arg === "--delta") {
      output.delta = true;
    }
  }
  return output;
}

async function runProcessProtocol(args: CliArgs): Promise<void> {
  const request = args.request
    ? JSON.parse(fs.readFileSync(path.resolve(args.request), "utf8")) as ParseRequest
    : JSON.parse(await readStdin()) as ParseRequest;

  const projectRoot = path.resolve(requiredProjectRoot(request));
  const rulesDir = resolveRulesDir(args.rules, request);
  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot,
    projectName: request.projectName,
    tsConfigPath: stringOption(request, "tsconfig") ?? stringOption(request, "tsConfigPath"),
    endpointRulesDir: rulesDir,
    ruleSources: request.ruleSources,
    ruleTexts: request.ruleTexts ?? arrayOption(request, "ruleTexts"),
    traceRuleSources: request.traceRuleSources,
    traceRuleTexts: request.traceRuleTexts ?? arrayOption(request, "traceRuleTexts"),
    externalValues: request.externalValues,
    externalValuesFile: stringOption(request, "externalValuesFile"),
    staticExtractBuiltinRules: booleanOption(request, "staticExtractBuiltinRules") ?? booleanOption(request, "staticExtractBuiltin"),
    staticExtractPresetRules: request.staticExtractPresetRules ?? booleanOption(request, "staticExtractPresetRules") ?? arrayOption(request, "staticExtractPresetRules"),
    legacyEndpointInference: booleanOption(request, "legacyEndpointInference"),
    include: arrayOption(request, "include"),
    exclude: arrayOption(request, "exclude"),
    gitRepoUrl: request.gitRepoUrl,
    gitBranch: request.gitBranch
  });

  const payload = JSON.stringify(toGraphDelta({
    graph: result.graph,
    request,
    projectName: request.projectName ?? path.basename(projectRoot),
    projectRoot
  }), null, 2);

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), `${payload}\n`, "utf8");
  } else {
    process.stdout.write(`${payload}\n`);
  }

  process.stderr.write(
    `Parsed ${result.stats.files} files, ` +
      `${result.stats.units} units, ${result.stats.functions} functions, ` +
      `${result.stats.endpoints} endpoints, ${result.stats.relationships} relationships.\n`
  );
}

function requestFromArgs(args: CliArgs, projectRoot: string): ParseRequest {
  return {
    projectName: args.projectName ?? path.basename(projectRoot),
    language: "typescript",
    projectRoot,
    sourceFiles: [],
    sourceRoots: [],
    dependencies: [],
    changeType: "SOURCE_MODIFIED",
    ruleSources: args.serRule?.map((rule) => path.resolve(rule)),
    ruleTexts: args.serRuleText,
    traceRuleSources: args.traceRule?.map((rule) => path.resolve(rule)),
    traceRuleTexts: args.traceRuleText,
    options: {
      ...(args.externalValues ? { externalValuesFile: path.resolve(args.externalValues) } : {}),
      ...(args.staticExtractBuiltin ? { staticExtractBuiltin: true } : {}),
      ...(args.staticExtractPreset ? { staticExtractPresetRules: args.staticExtractPreset } : {}),
      ...(args.noLegacyEndpointInference ? { legacyEndpointInference: false } : {})
    }
  };
}

function resultProjectName(args: CliArgs, projectRoot: string): string {
  return args.projectName ?? path.basename(projectRoot);
}

function requiredProjectRoot(request: ParseRequest): string {
  const fromOption = stringOption(request, "projectRoot");
  const projectRoot = request.projectRoot ?? fromOption;
  if (!projectRoot) {
    throw new Error("ParseRequest.projectRoot is required for frontend-code-graph --stdio/--request");
  }
  return projectRoot;
}

function resolveRulesDir(cliRules: string | undefined, request: ParseRequest): string | undefined {
  const fromOptions = stringOption(request, "rules") ?? stringOption(request, "endpointRulesDir");
  if (cliRules) return path.resolve(cliRules);
  if (fromOptions) return path.resolve(fromOptions);
  return defaultRulesDir();
}

function stringOption(request: ParseRequest, key: string): string | undefined {
  const value = request.options?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayOption(request: ParseRequest, key: string): string[] | undefined {
  const value = request.options?.[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function booleanOption(request: ParseRequest, key: string): boolean | undefined {
  const value = request.options?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function presetArray(value: boolean | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function defaultRulesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const distRoot = path.dirname(thisFile);
  const repoRules = path.resolve(distRoot, "../endpoint-rules");
  if (fs.existsSync(repoRules)) return repoRules;
  return path.resolve(process.cwd(), "endpoint-rules");
}

function printUsage(): void {
  process.stderr.write(
      `Usage:\n` +
      `  frontend-code-graph --project <path> [--rules <dir>] [--static-extract-preset [name|all]] [--ser-rule <file>] [--ser-rule-text <text>] [--trace-rule <file>] [--trace-rule-text <text>] [--external-values <file>] [--no-legacy-endpoint-inference] [--out graph.json] [--delta]\n` +
      `  frontend-code-graph --stdio [--rules <dir>]\n` +
      `  frontend-code-graph --request request.json [--rules <dir>] [--out delta.json]\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
