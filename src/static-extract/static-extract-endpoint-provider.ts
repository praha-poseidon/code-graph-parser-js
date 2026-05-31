import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStaticExtractTs, type StaticExtractFact } from "@static-extract/extractor-ts";
import type { GraphBuilder } from "../graph/graph-builder.js";
import type { CodeEndpoint, CodeFunction, EndpointType, NodeLanguage } from "../model/code-graph.js";
import type { ParserOptions } from "../model/parser-options.js";
import { endpointId } from "../parser/node-id.js";
import { normalizeHttpPath } from "../util/string-utils.js";
import { resolveStaticExtractPresetRules } from "./static-extract-presets.js";

interface AddEndpointOptions {
  projectName: string;
  projectRoot: string;
  sourceFiles: Array<{ getFilePath(): string }>;
  options: ParserOptions;
}

export class StaticExtractEndpointProvider {
  async addEndpoints(graph: GraphBuilder, input: AddEndpointOptions): Promise<void> {
    if (!this.shouldRun(input.options)) return;

    const workspace = await this.prepareWorkspace(input.options);
    try {
      const report = await runStaticExtractTs({
        project: input.projectRoot,
        source: input.sourceFiles.map((file) => file.getFilePath()),
        rule: [...workspace.presetRuleFiles, ...(input.options.ruleSources ?? []), ...workspace.ruleFiles],
        traceRule: [...(input.options.traceRuleSources ?? []), ...workspace.traceRuleFiles],
        externalValues: workspace.externalValuesFile,
        builtin: input.options.staticExtractBuiltinRules
      });

      for (const fact of report.results) {
        if (isUiActionFact(fact)) {
          this.addUiActionFact(graph, input, fact);
        } else if (isHttpFact(fact)) {
          this.addHttpEndpointFact(graph, input, fact);
        } else if (isGenericEndpointFact(fact)) {
          this.addGenericEndpointFact(graph, input, fact);
        }
      }
    } finally {
      await workspace.dispose();
    }
  }

  private shouldRun(options: ParserOptions): boolean {
    return Boolean(
      options.staticExtractBuiltinRules ||
      options.staticExtractPresetRules ||
      options.ruleSources?.length ||
      options.ruleTexts?.length ||
      options.traceRuleSources?.length ||
      options.traceRuleTexts?.length
    );
  }

  private async prepareWorkspace(options: ParserOptions): Promise<{
    ruleFiles: string[];
    traceRuleFiles: string[];
    presetRuleFiles: string[];
    externalValuesFile: string | undefined;
    dispose(): Promise<void>;
  }> {
    const directory = needsTempWorkspace(options)
      ? await mkdtemp(path.join(os.tmpdir(), "code-graph-static-extract-"))
      : undefined;
    const presetRules = resolveStaticExtractPresetRules(options.staticExtractPresetRules);
    const presetRuleFiles = directory ? await writeRuleTexts(directory, "preset-rule", presetRules) : [];
    const ruleFiles = directory ? await writeRuleTexts(directory, "rule", options.ruleTexts ?? []) : [];
    const traceRuleFiles = directory ? await writeRuleTexts(directory, "trace", options.traceRuleTexts ?? []) : [];
    const externalValuesFile = await resolveExternalValuesFile(options, directory);

    return {
      ruleFiles,
      traceRuleFiles,
      presetRuleFiles,
      externalValuesFile,
      async dispose(): Promise<void> {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    };
  }

  private addHttpEndpointFact(graph: GraphBuilder, input: AddEndpointOptions, fact: StaticExtractFact): void {
    const pathValue = fact.fields.path ?? fact.fields.url ?? fact.fields.route;
    if (!pathValue) return;
    if (isUnsafeFileRouteFact(fact)) return;

    const method = normalizeHttpMethod(fact.fields.method, fact.fields.client);
    const normalizedPath = normalizeHttpPath(pathValue);
    const matchIdentity = `HTTP:${method}:${normalizedPath}`;
    const projectFilePath = fact.projectFilePath;
    const language = languageOf(projectFilePath);
    const line = fact.startLine;
    const id = endpointId(input.projectName, projectFilePath, matchIdentity, line);
    const direction = normalizeDirection(fact);
    const handlerReference = firstNonBlank(fact.fields.handler, fact.enclosingSymbol);
    if (direction === "inbound" && !handlerReference) return;
    const linkedFunction = direction === "inbound"
      ? findHandlerFunction(graph.graph.functions, projectFilePath, handlerReference)
      : findEnclosingFunction(graph.graph.functions, projectFilePath, line);

    graph.addEndpoint({
      id,
      name: matchIdentity,
      qualifiedName: id,
      language,
      projectFilePath,
      gitRepoUrl: input.options.gitRepoUrl,
      gitBranch: input.options.gitBranch,
      startLine: line,
      endLine: fact.endLine,
      nodeKind: "endpoint",
      subKind: direction === "inbound" ? "http_inbound" : "http_outbound",
      endpointType: "HTTP",
      direction,
      isExternal: direction === "outbound",
      parseLevel: "full",
      matchIdentity,
      httpMethod: method,
      path: pathValue,
      normalizedPath,
      attributes: {
        source: "static-extract",
        rule: fact.rule,
        factType: fact.factType,
        fields: fact.fields,
        client: fact.fields.client,
        enclosingSymbol: fact.enclosingSymbol
      }
    });

    if (!linkedFunction) return;
    graph.addRelationship({
      fromNodeId: direction === "inbound" ? id : linkedFunction.id,
      toNodeId: direction === "inbound" ? linkedFunction.id : id,
      relationshipType: direction === "inbound" ? "ENDPOINT_TO_FUNCTION" : "FUNCTION_TO_ENDPOINT",
      language,
      lineNumber: line,
      confidence: "inferred",
      attributes: {
        source: "static-extract",
        rule: fact.rule
      }
    });
  }

  private addUiActionFact(graph: GraphBuilder, input: AddEndpointOptions, fact: StaticExtractFact): void {
    const text = fact.fields.text ?? fact.fields.label ?? fact.fields.name;
    if (!text) return;

    const event = normalizeUiEvent(fact.fields.event);
    const element = fact.fields.kind ?? fact.fields.element ?? fact.fields.component ?? "unknown";
    const matchIdentity = `UI:${event.toUpperCase()}:${element}:${text}`;
    const projectFilePath = fact.projectFilePath;
    const language = languageOf(projectFilePath);
    const line = fact.startLine;
    const id = endpointId(input.projectName, projectFilePath, matchIdentity, line);
    const handlerReference = firstNonBlank(fact.fields.handler, fact.enclosingSymbol);
    const handler = findHandlerFunction(graph.graph.functions, projectFilePath, handlerReference);

    graph.addEndpoint({
      id,
      name: text,
      qualifiedName: id,
      language,
      projectFilePath,
      gitRepoUrl: input.options.gitRepoUrl,
      gitBranch: input.options.gitBranch,
      startLine: line,
      endLine: fact.endLine,
      nodeKind: "endpoint",
      subKind: "ui_action",
      endpointType: "UI",
      direction: "inbound",
      isExternal: false,
      parseLevel: "full",
      matchIdentity,
      path: `${projectFilePath}#${element}:${text}`,
      normalizedPath: `${element}:${text}`,
      uiEvent: event,
      uiElement: element,
      uiText: text,
      componentName: fact.fields.component,
      attributes: {
        source: "static-extract",
        rule: fact.rule,
        factType: fact.factType,
        fields: fact.fields,
        handler: fact.fields.handler,
        enclosingSymbol: fact.enclosingSymbol
      }
    });

    if (!handler) return;
    graph.addRelationship({
      fromNodeId: id,
      toNodeId: handler.id,
      relationshipType: "ENDPOINT_TO_FUNCTION",
      language,
      lineNumber: line,
      confidence: "inferred",
      attributes: {
        source: "static-extract",
        rule: fact.rule
      }
    });
  }

  private addGenericEndpointFact(graph: GraphBuilder, input: AddEndpointOptions, fact: StaticExtractFact): void {
    const endpointType = normalizeEndpointType(fact.fields.endpointType ?? fact.fields.type);
    if (endpointType === "HTTP" || endpointType === "UI" || endpointType === "UNKNOWN") return;

    const identityValue = genericIdentityValue(endpointType, fact.fields);
    if (!identityValue) return;

    const direction = normalizeDirection(fact);
    const matchIdentity = fact.fields.matchIdentity ?? `${endpointType}:${identityValue}`;
    const projectFilePath = fact.projectFilePath;
    const language = languageOf(projectFilePath);
    const line = fact.startLine;
    const id = endpointId(input.projectName, projectFilePath, matchIdentity, line);
    const handlerReference = firstNonBlank(fact.fields.handler, fact.enclosingSymbol);
    if (direction === "inbound" && !handlerReference) return;
    const linkedFunction = direction === "inbound"
      ? findHandlerFunction(graph.graph.functions, projectFilePath, handlerReference)
      : findEnclosingFunction(graph.graph.functions, projectFilePath, line);

    graph.addEndpoint({
      id,
      name: matchIdentity,
      qualifiedName: id,
      language,
      projectFilePath,
      gitRepoUrl: input.options.gitRepoUrl,
      gitBranch: input.options.gitBranch,
      startLine: line,
      endLine: fact.endLine,
      nodeKind: "endpoint",
      subKind: `${endpointType.toLowerCase()}_${direction}`,
      endpointType,
      direction,
      isExternal: direction === "outbound",
      serviceName: fact.fields.serviceName,
      targetService: fact.fields.targetService,
      parseLevel: "full",
      matchIdentity,
      path: identityValue,
      normalizedPath: identityValue,
      topic: fact.fields.topic,
      operation: fact.fields.operation,
      brokerType: fact.fields.brokerType,
      keyPattern: fact.fields.keyPattern ?? fact.fields.key,
      command: fact.fields.command,
      dataStructure: fact.fields.dataStructure,
      tableName: fact.fields.tableName ?? fact.fields.table,
      dbOperation: fact.fields.dbOperation ?? fact.fields.operation,
      attributes: {
        source: "static-extract",
        rule: fact.rule,
        factType: fact.factType,
        fields: fact.fields,
        handler: fact.fields.handler,
        enclosingSymbol: fact.enclosingSymbol
      }
    } satisfies CodeEndpoint);

    if (!linkedFunction) return;
    graph.addRelationship({
      fromNodeId: direction === "inbound" ? id : linkedFunction.id,
      toNodeId: direction === "inbound" ? linkedFunction.id : id,
      relationshipType: direction === "inbound" ? "ENDPOINT_TO_FUNCTION" : "FUNCTION_TO_ENDPOINT",
      language,
      lineNumber: line,
      confidence: "inferred",
      attributes: {
        source: "static-extract",
        rule: fact.rule
      }
    });
  }
}

function needsTempWorkspace(options: ParserOptions): boolean {
  return Boolean(options.staticExtractPresetRules || options.ruleTexts?.length || options.traceRuleTexts?.length || options.externalValues);
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

async function writeRuleTexts(directory: string, prefix: string, texts: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const [index, text] of texts.entries()) {
    const file = path.join(directory, `${prefix}-${index + 1}.ser`);
    await writeFile(file, ensureTrailingNewline(text), "utf8");
    files.push(file);
  }
  return files;
}

async function resolveExternalValuesFile(options: ParserOptions, directory: string | undefined): Promise<string | undefined> {
  if (options.externalValuesFile) return options.externalValuesFile;
  if (!options.externalValues) return undefined;

  if (!directory) {
    throw new Error("Internal error: external values require a temporary static-extract workspace");
  }
  const file = path.join(directory, "external-values.json");
  await writeFile(file, `${JSON.stringify(options.externalValues, null, 2)}\n`, "utf8");
  return file;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function findEnclosingFunction(functions: CodeFunction[], projectFilePath: string, line: number): CodeFunction | undefined {
  return functions
    .filter((fn) => fn.projectFilePath === projectFilePath)
    .filter((fn) => (fn.startLine ?? 0) <= line && (fn.endLine ?? Number.MAX_SAFE_INTEGER) >= line)
    .sort((left, right) => ((left.endLine ?? 0) - (left.startLine ?? 0)) - ((right.endLine ?? 0) - (right.startLine ?? 0)))[0];
}

function languageOf(filePath: string): NodeLanguage {
  return /\.(ts|tsx)$/i.test(filePath) ? "typescript" : "javascript";
}

function isHttpFact(fact: StaticExtractFact): boolean {
  return fact.factType === "frontend_api_call" ||
    fact.factType.includes("route") ||
    fact.fields.endpointType?.toLowerCase() === "http" ||
    Boolean(fact.fields.path || fact.fields.url || fact.fields.route);
}

function isUnsafeFileRouteFact(fact: StaticExtractFact): boolean {
  if (!fact.rule.startsWith("Preset Next ")) return false;
  if (fact.rule.includes("Named Route Export")) {
    return !isNextAppRouteFile(fact.projectFilePath);
  }
  if (fact.rule.includes("Default Route Export")) {
    return !isNextPagesApiFile(fact.projectFilePath);
  }
  return false;
}

function isNextAppRouteFile(filePath: string): boolean {
  return /(^|\/)app\/.+\/route\.[cm]?[jt]sx?$/i.test(filePath);
}

function isNextPagesApiFile(filePath: string): boolean {
  return /(^|\/)pages\/api\/.+\.[cm]?[jt]sx?$/i.test(filePath);
}

function isUiActionFact(fact: StaticExtractFact): boolean {
  return fact.factType === "ui_action" ||
    fact.fields.endpointType?.toLowerCase() === "ui" ||
    Boolean((fact.fields.text || fact.fields.label) && fact.fields.event);
}

function isGenericEndpointFact(fact: StaticExtractFact): boolean {
  const endpointType = normalizeEndpointType(fact.fields.endpointType ?? fact.fields.type);
  return endpointType === "MQ" || endpointType === "REDIS" || endpointType === "DB";
}

function normalizeEndpointType(value: string | undefined): EndpointType {
  const upper = (value ?? "").toUpperCase();
  if (upper === "MQ" || upper === "REDIS" || upper === "DB" || upper === "HTTP" || upper === "UI") return upper;
  return "UNKNOWN";
}

function genericIdentityValue(endpointType: EndpointType, fields: Record<string, string>): string | undefined {
  if (endpointType === "MQ") return fields.topic;
  if (endpointType === "REDIS") return fields.keyPattern ?? fields.key;
  if (endpointType === "DB") return fields.tableName ?? fields.table;
  return undefined;
}

function normalizeDirection(fact: StaticExtractFact): "inbound" | "outbound" {
  const direction = fact.fields.direction?.toLowerCase();
  if (direction === "inbound" || direction === "outbound") return direction;
  if (fact.fields.handler || fact.factType.includes("route")) return "inbound";
  return "outbound";
}

function normalizeUiEvent(event: string | undefined): string {
  if (!event) return "click";
  return event.replace(/^on/, "").toLowerCase();
}

function normalizeHttpMethod(method: string | undefined, client: string | undefined): string {
  const value = (method ?? "").toUpperCase();
  if (!value || value === "FETCH" || value === "AXIOS") return "GET";
  if (value === "DEL") return "DELETE";
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(value)) return value;
  return client?.toLowerCase() === "fetch" ? "GET" : value;
}

function findHandlerFunction(functions: CodeFunction[], projectFilePath: string, handler: string | undefined): CodeFunction | undefined {
  if (!handler) return undefined;
  const normalized = handler.replace(/^this\./, "");
  return functions
    .filter((fn) => fn.projectFilePath === projectFilePath)
    .find((fn) =>
      fn.name === normalized ||
      fn.name.endsWith(`.${normalized}`) ||
      fn.signature.startsWith(`${normalized}(`) ||
      fn.signature.includes(`.${normalized}(`)
    );
}
