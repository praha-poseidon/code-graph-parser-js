import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStaticExtractTs, type StaticExtractFact } from "@static-extract/extractor-ts";
import type { GraphBuilder } from "../graph/graph-builder.js";
import type { CodeEndpoint, CodeFunction, EndpointType, NodeLanguage } from "../model/code-graph.js";
import type { ParserOptions } from "../model/parser-options.js";
import { endpointId } from "../parser/node-id.js";
import { resolveStaticExtractPresetRules } from "./static-extract-presets.js";

interface AddEndpointOptions {
  projectName: string;
  projectRoot: string;
  sourceFiles: Array<{
    getFilePath(): string;
  }>;
  morphProject?: Parameters<typeof runStaticExtractTs>[0]["morphProject"];
  options: ParserOptions;
}

interface ExtractWorkspace {
  /** Fully materialised SER rule file paths (presets + user rules + merged trace). */
  ruleFiles: string[];
  /** Object form preferred; path string accepted by static-extract-js. */
  externalValues: Record<string, unknown> | string | undefined;
  dispose(): Promise<void>;
}

/**
 * static-extract-js (aligned with Java extract) only accepts:
 * - SER rule files / ruleSources text with optional embedded `trace { ... }`
 * - externalValues / dictionary / externalValuesFile
 *
 * There is no top-level `traceRule` or `builtin` API. Standalone legacy
 * `trace "name" ...` documents (parser options / CLI) are converted to
 * embedded `trace { ... }` and merged into each rule before extract.
 */
export class StaticExtractEndpointProvider {
  async addEndpoints(graph: GraphBuilder, input: AddEndpointOptions): Promise<void> {
    if (!this.shouldRun(input.options)) return;

    const workspace = await this.prepareWorkspace(input.options);
    try {
      if (workspace.ruleFiles.length === 0) return;
      // Identity dict is applied only inside static-extract-js.
      const report = await runStaticExtractTs({
        project: input.projectRoot,
        projectName: input.projectName,
        source: input.sourceFiles.map((file) => file.getFilePath()),
        morphProject: input.morphProject,
        rule: workspace.ruleFiles,
        externalValues: workspace.externalValues as never
      });

      for (const fact of report.results) {
        // UI actions are not graph endpoints. The Java engine intentionally has
        // no UI endpoint subtype, so emitting one would make GraphDelta fail to
        // deserialize at the process-adapter boundary.
        if (isHttpFact(fact)) {
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
    const hasPresetRules = options.staticExtractPresetRules === true ||
      (Array.isArray(options.staticExtractPresetRules) && options.staticExtractPresetRules.length > 0) ||
      (options.staticExtractPresetRules === undefined && options.staticExtractBuiltinRules === true);
    return Boolean(
      hasPresetRules ||
      options.ruleSources?.length ||
      options.ruleTexts?.some((text) => text.trim().length > 0) ||
      options.traceRuleSources?.length ||
      options.traceRuleTexts?.length
    );
  }

  private async prepareWorkspace(options: ParserOptions): Promise<ExtractWorkspace> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "code-graph-static-extract-"));
    try {
      // Java extract has no builtins; parser-js "builtin" enables local SER presets.
      const presetFlag =
        options.staticExtractPresetRules !== undefined
          ? options.staticExtractPresetRules
          : options.staticExtractBuiltinRules
            ? true
            : undefined;
      const presetRules = resolveStaticExtractPresetRules(presetFlag);

      const ruleBodies: string[] = [...presetRules, ...(options.ruleTexts ?? [])];
      for (const source of options.ruleSources ?? []) {
        // Process protocol compatibility: remote callers historically used
        // ruleSources for both file paths and inline SER documents.
        ruleBodies.push(looksLikeSerDocument(source) ? source : await readFile(source, "utf8"));
      }

      // Standalone trace docs (legacy CLI/options) → embedded entries; full `rule ` docs → rules.
      const embeddedTraceEntries: string[] = [];
      for (const source of options.traceRuleSources ?? []) {
        const text = await readFile(source, "utf8");
        if (containsRuleDecl(text)) {
          ruleBodies.push(text);
        } else {
          const entry = standaloneTraceToEmbeddedEntries(text);
          if (entry) embeddedTraceEntries.push(entry);
        }
      }
      for (const text of options.traceRuleTexts ?? []) {
        if (containsRuleDecl(text)) {
          ruleBodies.push(text);
        } else {
          const entry = standaloneTraceToEmbeddedEntries(text);
          if (entry) embeddedTraceEntries.push(entry);
        }
      }

      if (ruleBodies.length === 0) {
        return {
          ruleFiles: [],
          externalValues: undefined,
          async dispose(): Promise<void> {
            await rm(directory, { recursive: true, force: true });
          }
        };
      }

      const merged = ruleBodies.map((body) => mergeEmbeddedTrace(body, embeddedTraceEntries));
      const ruleFiles = await writeRuleTexts(directory, "rule", merged);
      const externalValues = await resolveExternalValues(options, directory);

      return {
        ruleFiles,
        externalValues,
        async dispose(): Promise<void> {
          await rm(directory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private addHttpEndpointFact(graph: GraphBuilder, input: AddEndpointOptions, fact: StaticExtractFact): void {
    if (isUnsafeFileRouteFact(fact)) return;

    const direction = normalizeDirection(fact);
    // Identity already resolved by static-extract (flat identity dict).
    const pathValue = fact.fields.path ?? fact.fields.url ?? fact.fields.route;
    const parseLevel = resolveParseLevel(fact.fields);

    if (!pathValue) return;
    // Drop non-path noise from bare get/post matches (Map.get(id), get(key), …).
    // After extract dict HIT, path is always a real path; still filter unresolved SER junk.
    if (!looksLikeHttpPath(pathValue) && parseLevel !== "config") return;

    const method = normalizeHttpMethod(fact.fields.method, fact.fields.client);
    if (!isKnownHttpMethod(method)) return;
    // static-extract/SER owns endpoint identity; graph mapping is lossless.
    const normalizedPath = pathValue;
    const matchIdentity = `HTTP:${method}:${normalizedPath}`;
    const projectFilePath = fact.projectFilePath;
    const language = languageOf(projectFilePath);
    const line = fact.startLine;
    const id = endpointId(input.projectName, projectFilePath, matchIdentity, line);
    const handlerReference = resolveHandlerReference(fact);
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
      parseLevel,
      matchIdentity,
      httpMethod: method,
      path: pathValue,
      normalizedPath,
      other: fact.fields.other ?? null,
      attributes: {
        source: "static-extract",
        rule: fact.rule,
        factType: fact.factType,
        fields: fact.fields,
        client: fact.fields.client,
        enclosingSymbol: fact.enclosingSymbol,
        ...(fact.fields.pathKey ? { pathKey: fact.fields.pathKey } : {})
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

  private addGenericEndpointFact(graph: GraphBuilder, input: AddEndpointOptions, fact: StaticExtractFact): void {
    const endpointType = normalizeEndpointType(fact.fields.endpointType ?? fact.fields.type);
    if (endpointType === "HTTP" || endpointType === "UI" || endpointType === "UNKNOWN") return;

    // Identity from static-extract only (flat identity dict applied there).
    const identityValue = genericIdentityValue(endpointType, fact.fields);
    if (!identityValue) return;
    const parseLevel = resolveParseLevel(fact.fields);

    const direction = normalizeDirection(fact);
    const matchIdentity = fact.fields.matchIdentity ?? `${endpointType}:${identityValue}`;
    const projectFilePath = fact.projectFilePath;
    const language = languageOf(projectFilePath);
    const line = fact.startLine;
    const id = endpointId(input.projectName, projectFilePath, matchIdentity, line);
    const handlerReference = resolveHandlerReference(fact);
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
      parseLevel,
      matchIdentity,
      path: identityValue,
      normalizedPath: identityValue,
      topic: endpointType === "MQ" ? identityValue : fact.fields.topic,
      // MQ consumer group is metadata only (not MATCHES identity) — same as Java MqEndpoint.group.
      group: fact.fields.group,
      operation: fact.fields.operation,
      brokerType: fact.fields.brokerType,
      keyPattern: endpointType === "REDIS" ? identityValue : (fact.fields.keyPattern ?? fact.fields.key),
      command: normalizeCommand(fact.fields.command),
      dataStructure: fact.fields.dataStructure,
      tableName: endpointType === "DB" ? identityValue : (fact.fields.tableName ?? fact.fields.table),
      dbOperation: fact.fields.dbOperation ?? fact.fields.operation,
      other: fact.fields.other ?? null,
      attributes: {
        source: "static-extract",
        rule: fact.rule,
        factType: fact.factType,
        fields: fact.fields,
        handler: fact.fields.handler,
        enclosingSymbol: fact.enclosingSymbol,
        ...(fact.fields.pathKey ? { pathKey: fact.fields.pathKey } : {})
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

function looksLikeSerDocument(value: string): boolean {
  const trimmed = value.trimStart();
  return /^(?:rule\s+(?:"|')|rule\s+[A-Za-z_$]|trace\s*\{|fact\s+)/.test(trimmed) || value.includes("\n");
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/**
 * A method-anchor rule commonly builds the simple method name as `handler`,
 * while the extractor also reports its owner-qualified enclosing symbol. Use
 * that qualified symbol when both describe the same method; route-call rules
 * still prefer their explicit, unrelated handler argument.
 */
function resolveHandlerReference(fact: StaticExtractFact): string | undefined {
  const handler = firstNonBlank(fact.fields.handler);
  const enclosing = firstNonBlank(fact.enclosingSymbol);
  if (handler && enclosing) {
    const normalizedHandler = handler.replace(/^this\./, "");
    if (enclosing === normalizedHandler || enclosing.endsWith(`.${normalizedHandler}`)) {
      return enclosing;
    }
  }
  return handler ?? enclosing;
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

/**
 * Prefer in-memory object (matches static-extract-js externalValues API).
 * Fall back to externalValuesFile path when only a file was provided.
 */
async function resolveExternalValues(
  options: ParserOptions,
  directory: string
): Promise<Record<string, unknown> | string | undefined> {
  if (options.externalValues) return options.externalValues;
  if (options.externalValuesFile) return options.externalValuesFile;
  void directory;
  return undefined;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

/** Same semantics as Java mapper: blank/missing → "full"; otherwise pass through known levels. */
function resolveParseLevel(fields: Record<string, string>): NonNullable<CodeEndpoint["parseLevel"]> {
  const raw = (fields.parseLevel ?? "").trim().toLowerCase();
  if (
    raw === "config" ||
    raw === "partial" ||
    raw === "unknown" ||
    raw === "unresolved" ||
    raw === "full"
  ) {
    return raw;
  }
  return "full";
}

function containsRuleDecl(text: string): boolean {
  return /^\s*rule\s+/m.test(text) || /\brule\s+"/.test(text);
}

/**
 * Convert legacy standalone trace documents into the inner entries of
 * embedded `trace { ... }` (static-extract-js / SER grammar).
 *
 * Accepted forms:
 * - already-embedded: `trace { from call ... }`
 * - old named: `trace "Name"\nfrom call ...`
 * - bare entries: `from call ...`
 */
function standaloneTraceToEmbeddedEntries(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const embeddedBlock = trimmed.match(/^trace\s*\{([\s\S]*)\}\s*$/i);
  if (embeddedBlock) {
    const body = embeddedBlock[1].trim();
    return body || undefined;
  }

  // Strip optional `trace "name"` / `trace 'name'` header (legacy standalone file).
  const withoutHeader = trimmed.replace(/^trace\s+(?:"[^"]*"|'[^']*')\s*/i, "").trim();
  if (!withoutHeader) return undefined;
  // If still starts with `trace {` after partial strip, unwrap.
  const nested = withoutHeader.match(/^trace\s*\{([\s\S]*)\}\s*$/i);
  if (nested) {
    const body = nested[1].trim();
    return body || undefined;
  }
  return withoutHeader;
}

/** Append standalone trace entries into a rule that does not already embed trace { }. */
function mergeEmbeddedTrace(ruleText: string, entries: string[]): string {
  if (entries.length === 0) return ruleText;
  const body = ruleText.trimEnd();
  if (/\btrace\s*\{/.test(body)) {
    // Rule already has embedded trace — inject extra entries before the closing brace of the last trace block.
    const lastTrace = body.lastIndexOf("trace");
    const open = body.indexOf("{", lastTrace);
    const close = body.lastIndexOf("}");
    if (open >= 0 && close > open) {
      const before = body.slice(0, close).trimEnd();
      const after = body.slice(close);
      return ensureTrailingNewline(`${before}\n\n${entries.join("\n\n")}\n${after}`);
    }
    return ensureTrailingNewline(body);
  }
  return ensureTrailingNewline(`${body}\n\ntrace {\n${entries.join("\n\n")}\n}`);
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

function isGenericEndpointFact(fact: StaticExtractFact): boolean {
  const endpointType = normalizeEndpointType(fact.fields.endpointType ?? fact.fields.type);
  return endpointType === "MQ" || endpointType === "REDIS" || endpointType === "DB";
}

function normalizeEndpointType(value: string | undefined): EndpointType {
  const upper = (value ?? "").toUpperCase();
  if (upper === "MQ" || upper === "REDIS" || upper === "DB" || upper === "HTTP") return upper;
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
  // SER map miss→empty: do not use partial map { DEL: DELETE } in rules; normalize here.
  if (value === "DEL") return "DELETE";
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(value)) return value;
  return client?.toLowerCase() === "fetch" ? "GET" : value;
}

/** Normalize Redis/command-style aliases after SER upper (no partial map in SER). */
function normalizeCommand(command: string | undefined): string | undefined {
  if (!command) return command;
  const value = command.toUpperCase();
  if (value === "DEL") return "DELETE";
  return value;
}

const KNOWN_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function isKnownHttpMethod(method: string): boolean {
  return KNOWN_HTTP_METHODS.has(method);
}

/** True when the traced string looks like an HTTP path/URL, not a random get() argument. */
function looksLikeHttpPath(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (/^https?:\/\//i.test(value) || value.startsWith("//")) return true;
  if (value.startsWith("/")) return true;
  // Partial template traces such as `{serverUrl}/svg/{param}`
  if (value.includes("/") && (value.startsWith("{") || value.includes("{param}"))) return true;
  // Relative gateway / api paths without leading slash
  if (/(?:^|\/)(?:cooper_gateway|gateway|api)\b/i.test(value)) return true;
  if (value.startsWith("api/") || value.startsWith("cooper_gateway")) return true;
  return false;
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
