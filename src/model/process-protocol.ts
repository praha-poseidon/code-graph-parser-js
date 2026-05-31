import type {
  CodeEndpoint,
  CodeFunction,
  CodeGraph,
  CodePackage,
  CodeRelationship,
  CodeUnit,
  RelationshipType
} from "./code-graph.js";

const CORE_RELATIONSHIP_TYPES = new Set<RelationshipType>([
  "PACKAGE_TO_UNIT",
  "UNIT_TO_FUNCTION",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "OVERRIDES",
  "ENDPOINT_TO_FUNCTION",
  "FUNCTION_TO_ENDPOINT",
  "MATCHES"
]);

export interface ParseRequest {
  projectName?: string;
  language?: string;
  projectRoot?: string;
  sourceFiles?: string[];
  sourceRoots?: string[];
  dependencies?: string[];
  gitRepoUrl?: string;
  gitBranch?: string;
  changeType?: string;
  ruleSources?: string[];
  ruleTexts?: string[];
  traceRuleSources?: string[];
  traceRuleTexts?: string[];
  externalValues?: Record<string, Record<string, string[]>>;
  staticExtractPresetRules?: boolean | string[];
  options?: Record<string, unknown>;
}

export interface DeltaScope {
  projectName: string;
  language: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  projectRoot: string;
  sourceFiles: string[];
  changeType?: string;
  attributes: Record<string, unknown>;
}

export interface GraphDelta {
  scope: DeltaScope;
  packages: JavaCodePackage[];
  units: JavaCodeUnit[];
  functions: JavaCodeFunction[];
  endpoints: JavaCodeEndpoint[];
  relationships: JavaCodeRelationship[];
  deletedNodeIds: string[];
  deletedRelationshipIds: string[];
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  level: "INFO" | "WARN" | "ERROR";
  code: string;
  message: string;
  projectFilePath?: string;
  lineNumber?: number;
  details: Record<string, unknown>;
}

type JavaCodePackage = Pick<
  CodePackage,
  "id" | "name" | "qualifiedName" | "language" | "projectName" | "projectFilePath" | "gitRepoUrl" | "gitBranch" | "startLine" | "endLine" | "packagePath"
>;

type JavaCodeUnit = Pick<
  CodeUnit,
  | "id"
  | "name"
  | "qualifiedName"
  | "language"
  | "projectName"
  | "projectFilePath"
  | "gitRepoUrl"
  | "gitBranch"
  | "startLine"
  | "endLine"
  | "unitType"
  | "modifiers"
  | "isAbstract"
  | "packageId"
>;

type JavaCodeFunction = Pick<
  CodeFunction,
  | "id"
  | "name"
  | "qualifiedName"
  | "language"
  | "projectName"
  | "projectFilePath"
  | "gitRepoUrl"
  | "gitBranch"
  | "startLine"
  | "endLine"
  | "signature"
  | "returnType"
  | "modifiers"
  | "isStatic"
  | "isAsync"
  | "isConstructor"
  | "isPlaceholder"
>;

export interface JavaCodeEndpoint
  extends Pick<
    CodeEndpoint,
    | "id"
    | "name"
    | "qualifiedName"
    | "language"
    | "projectName"
    | "projectFilePath"
    | "gitRepoUrl"
    | "gitBranch"
    | "startLine"
    | "endLine"
    | "endpointType"
    | "direction"
    | "isExternal"
    | "serviceName"
    | "parseLevel"
    | "targetService"
    | "matchIdentity"
    | "httpMethod"
    | "path"
    | "normalizedPath"
    | "uiEvent"
    | "uiElement"
    | "uiText"
    | "uiSelector"
    | "routePath"
    | "componentName"
    | "topic"
    | "operation"
    | "brokerType"
    | "keyPattern"
    | "command"
    | "dataStructure"
    | "tableName"
    | "dbOperation"
  > {
  endpointKind: "http" | "mq" | "redis" | "db" | "ui";
}

type JavaCodeRelationship = Pick<
  CodeRelationship,
  "id" | "fromNodeId" | "toNodeId" | "relationshipType" | "lineNumber" | "callType" | "language" | "projectName"
>;

export function toGraphDelta(input: {
  graph: CodeGraph;
  request: ParseRequest;
  projectName: string;
  projectRoot: string;
}): GraphDelta {
  const { graph, request, projectName, projectRoot } = input;
  const id = createIdMapper(projectName);
  const units = graph.units.filter(isCoreUnit);
  const nodeIds = new Set<string>([
    ...graph.packages.map((pkg) => pkg.id),
    ...units.map((unit) => unit.id),
    ...graph.functions.map((fn) => fn.id),
    ...graph.endpoints.map((endpoint) => endpoint.id)
  ]);
  return {
    scope: {
      projectName,
      language: request.language ?? "typescript",
      gitRepoUrl: request.gitRepoUrl,
      gitBranch: request.gitBranch,
      projectRoot,
      sourceFiles: request.sourceFiles ?? [],
      changeType: request.changeType,
      attributes: {}
    },
    packages: graph.packages.map((pkg) => cleanPackage(pkg, projectName, id)),
    units: units.map((unit) => cleanUnit(unit, projectName, id)),
    functions: graph.functions.map((fn) => cleanFunction(fn, projectName, id)),
    endpoints: graph.endpoints.map((endpoint) => cleanEndpoint(endpoint, projectName, id)),
    relationships: graph.relationships
      .filter((relationship) => isCoreRelationship(relationship, nodeIds))
      .map((relationship) => cleanRelationship(relationship, projectName, id)),
    deletedNodeIds: [],
    deletedRelationshipIds: [],
    diagnostics: []
  };
}

function isCoreUnit(unit: CodeUnit): boolean {
  return unit.nodeKind === "module" && unit.subKind === "source_file";
}

function isCoreRelationship(relationship: CodeRelationship, nodeIds: Set<string>): boolean {
  if (!CORE_RELATIONSHIP_TYPES.has(relationship.relationshipType)) {
    return false;
  }
  return isKnownOrUnresolved(relationship.fromNodeId, nodeIds)
    && isKnownOrUnresolved(relationship.toNodeId, nodeIds);
}

function isKnownOrUnresolved(nodeId: string, nodeIds: Set<string>): boolean {
  return nodeIds.has(nodeId) || !nodeId.includes("#");
}

function cleanPackage(pkg: CodePackage, projectName: string, id: IdMapper): JavaCodePackage {
  return {
    id: id.required(pkg.id),
    name: pkg.name,
    qualifiedName: pkg.qualifiedName,
    language: pkg.language,
    projectName: pkg.projectName ?? projectName,
    projectFilePath: pkg.projectFilePath,
    gitRepoUrl: pkg.gitRepoUrl,
    gitBranch: pkg.gitBranch,
    startLine: pkg.startLine,
    endLine: pkg.endLine,
    packagePath: pkg.packagePath
  };
}

function cleanUnit(unit: CodeUnit, projectName: string, id: IdMapper): JavaCodeUnit {
  return {
    id: id.required(unit.id),
    name: unit.name,
    qualifiedName: unit.qualifiedName,
    language: unit.language,
    projectName: unit.projectName ?? projectName,
    projectFilePath: unit.projectFilePath,
    gitRepoUrl: unit.gitRepoUrl,
    gitBranch: unit.gitBranch,
    startLine: unit.startLine,
    endLine: unit.endLine,
    unitType: unit.unitType,
    modifiers: unit.modifiers,
    isAbstract: unit.isAbstract,
    packageId: id.optional(unit.packageId)
  };
}

function cleanFunction(fn: CodeFunction, projectName: string, id: IdMapper): JavaCodeFunction {
  return {
    id: id.required(fn.id),
    name: fn.name,
    qualifiedName: fn.qualifiedName,
    language: fn.language,
    projectName: fn.projectName ?? projectName,
    projectFilePath: fn.projectFilePath,
    gitRepoUrl: fn.gitRepoUrl,
    gitBranch: fn.gitBranch,
    startLine: fn.startLine,
    endLine: fn.endLine,
    signature: fn.signature,
    returnType: fn.returnType,
    modifiers: fn.modifiers,
    isStatic: fn.isStatic,
    isAsync: fn.isAsync,
    isConstructor: fn.isConstructor,
    isPlaceholder: fn.isPlaceholder
  };
}

function cleanEndpoint(endpoint: CodeEndpoint, projectName: string, id: IdMapper): JavaCodeEndpoint {
  return {
    endpointKind: endpointKind(endpoint),
    id: id.required(endpoint.id),
    name: endpoint.name,
    qualifiedName: endpoint.qualifiedName,
    language: endpoint.language,
    projectName: endpoint.projectName ?? projectName,
    projectFilePath: endpoint.projectFilePath,
    gitRepoUrl: endpoint.gitRepoUrl,
    gitBranch: endpoint.gitBranch,
    startLine: endpoint.startLine,
    endLine: endpoint.endLine,
    endpointType: endpoint.endpointType,
    direction: endpoint.direction,
    isExternal: endpoint.isExternal,
    serviceName: endpoint.serviceName,
    parseLevel: endpoint.parseLevel,
    targetService: endpoint.targetService,
    matchIdentity: endpoint.matchIdentity,
    httpMethod: endpoint.httpMethod,
    path: endpoint.path,
    normalizedPath: endpoint.normalizedPath,
    uiEvent: endpoint.uiEvent,
    uiElement: endpoint.uiElement,
    uiText: endpoint.uiText,
    uiSelector: endpoint.uiSelector,
    routePath: endpoint.routePath,
    componentName: endpoint.componentName,
    topic: endpoint.topic,
    operation: endpoint.operation,
    brokerType: endpoint.brokerType,
    keyPattern: endpoint.keyPattern,
    command: endpoint.command,
    dataStructure: endpoint.dataStructure,
    tableName: endpoint.tableName,
    dbOperation: endpoint.dbOperation
  };
}

function endpointKind(endpoint: CodeEndpoint): JavaCodeEndpoint["endpointKind"] {
  if (endpoint.endpointType === "MQ") return "mq";
  if (endpoint.endpointType === "REDIS") return "redis";
  if (endpoint.endpointType === "DB") return "db";
  if (endpoint.endpointType === "UI") return "ui";
  return "http";
}

function cleanRelationship(relationship: CodeRelationship, projectName: string, id: IdMapper): JavaCodeRelationship {
  return {
    id: relationship.id,
    fromNodeId: id.required(relationship.fromNodeId),
    toNodeId: id.required(relationship.toNodeId),
    relationshipType: relationship.relationshipType,
    lineNumber: relationship.lineNumber,
    callType: relationship.callType,
    language: relationship.language,
    projectName: relationship.projectName ?? projectName
  };
}

type IdMapper = {
  required(value: string): string;
  optional(value: string | undefined): string | undefined;
};

function createIdMapper(projectName: string): IdMapper {
  const projectPrefix = `${projectName}#`;
  return {
    required(value: string): string {
      return rawNodeId(value, projectName, projectPrefix);
    },
    optional(value: string | undefined): string | undefined {
      if (!value) return value;
      return rawNodeId(value, projectName, projectPrefix);
    }
  };
}

function rawNodeId(value: string, projectName: string, projectPrefix: string): string {
  if (value === projectName) return "pkg:.";
  if (value.startsWith(projectPrefix)) return value.slice(projectPrefix.length);
  return value;
}
