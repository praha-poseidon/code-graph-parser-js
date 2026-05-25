import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStaticExtractTs, type StaticExtractFact } from "@static-extract/extractor-ts";
import type { GraphBuilder } from "../graph/graph-builder.js";
import type { CodeFunction, NodeLanguage } from "../model/code-graph.js";
import type { ParserOptions } from "../model/parser-options.js";
import { endpointId } from "../parser/node-id.js";
import { normalizeHttpPath } from "../util/string-utils.js";

interface AddEndpointOptions {
  projectName: string;
  projectRoot: string;
  sourceFiles: Array<{ getFilePath(): string }>;
  options: ParserOptions;
}

export class StaticExtractEndpointProvider {
  async addEndpoints(graph: GraphBuilder, input: AddEndpointOptions): Promise<void> {
    if (!this.shouldRun(input.options)) return;

    const externalValuesFile = await this.resolveExternalValuesFile(input.options);
    const report = await runStaticExtractTs({
      project: input.projectRoot,
      source: input.sourceFiles.map((file) => file.getFilePath()),
      rule: input.options.ruleSources ?? [],
      traceRule: input.options.traceRuleSources ?? [],
      externalValues: externalValuesFile,
      builtin: input.options.staticExtractBuiltinRules
    });

    for (const fact of report.results.filter((result) => result.factType === "frontend_api_call")) {
      this.addEndpointFact(graph, input, fact);
    }
  }

  private shouldRun(options: ParserOptions): boolean {
    return Boolean(
      options.staticExtractBuiltinRules ||
      options.ruleSources?.length ||
      options.traceRuleSources?.length
    );
  }

  private async resolveExternalValuesFile(options: ParserOptions): Promise<string | undefined> {
    if (options.externalValuesFile) return options.externalValuesFile;
    if (!options.externalValues) return undefined;

    const directory = await mkdtemp(path.join(os.tmpdir(), "code-graph-static-extract-"));
    const file = path.join(directory, "external-values.json");
    await writeFile(file, `${JSON.stringify(options.externalValues, null, 2)}\n`, "utf8");
    return file;
  }

  private addEndpointFact(graph: GraphBuilder, input: AddEndpointOptions, fact: StaticExtractFact): void {
    const pathValue = fact.fields.path ?? fact.fields.url ?? fact.fields.route;
    if (!pathValue) return;

    const method = normalizeHttpMethod(fact.fields.method, fact.fields.client);
    const normalizedPath = normalizeHttpPath(pathValue);
    const matchIdentity = `HTTP:${method}:${normalizedPath}`;
    const projectFilePath = fact.projectFilePath;
    const language = languageOf(projectFilePath);
    const line = fact.startLine;
    const id = endpointId(input.projectName, projectFilePath, matchIdentity, line);
    const enclosingFunction = findEnclosingFunction(graph.graph.functions, projectFilePath, line);

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
      subKind: "http_outbound",
      endpointType: "HTTP",
      direction: "outbound",
      isExternal: true,
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

    if (!enclosingFunction) return;
    graph.addRelationship({
      fromNodeId: enclosingFunction.id,
      toNodeId: id,
      relationshipType: "FUNCTION_TO_ENDPOINT",
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

function findEnclosingFunction(functions: CodeFunction[], projectFilePath: string, line: number): CodeFunction | undefined {
  return functions
    .filter((fn) => fn.projectFilePath === projectFilePath)
    .filter((fn) => (fn.startLine ?? 0) <= line && (fn.endLine ?? Number.MAX_SAFE_INTEGER) >= line)
    .sort((left, right) => ((left.endLine ?? 0) - (left.startLine ?? 0)) - ((right.endLine ?? 0) - (right.startLine ?? 0)))[0];
}

function languageOf(filePath: string): NodeLanguage {
  return /\.(ts|tsx)$/i.test(filePath) ? "typescript" : "javascript";
}

function normalizeHttpMethod(method: string | undefined, client: string | undefined): string {
  const value = (method ?? "").toUpperCase();
  if (!value || value === "FETCH" || value === "AXIOS") return "GET";
  if (value === "DEL") return "DELETE";
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(value)) return value;
  return client?.toLowerCase() === "fetch" ? "GET" : value;
}
