export type NodeLanguage = "javascript" | "typescript" | "unknown";

export type CodeNodeKind =
  | "package"
  | "module"
  | "component"
  | "function"
  | "endpoint"
  | "external";

export type RelationshipType =
  | "PACKAGE_TO_UNIT"
  | "UNIT_TO_FUNCTION"
  | "MODULE_TO_UNIT"
  | "IMPORTS"
  | "EXPORTS"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "OVERRIDES"
  | "RENDERS"
  | "USES_HOOK"
  | "USES_STATE"
  | "HANDLES_EVENT"
  | "ROUTES_TO"
  | "FUNCTION_TO_ENDPOINT"
  | "ENDPOINT_TO_FUNCTION"
  | "MATCHES";

export type EndpointType = "HTTP" | "UI" | "UI_ROUTE" | "GRAPHQL" | "MQ" | "REDIS" | "DB" | "UNKNOWN";

export type Confidence = "exact" | "inferred" | "heuristic" | "partial" | "unresolved";

export interface CodeNode {
  id: string;
  name: string;
  qualifiedName: string;
  language: NodeLanguage;
  projectName?: string;
  projectFilePath: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  startLine?: number;
  endLine?: number;
  nodeKind: CodeNodeKind;
  subKind?: string;
  attributes?: Record<string, unknown>;
}

export interface CodePackage extends CodeNode {
  packagePath: string;
}

export interface CodeUnit extends CodeNode {
  unitType: string;
  modifiers: string[];
  isAbstract?: boolean;
  packageId?: string;
}

export interface CodeFunction extends CodeNode {
  signature: string;
  returnType?: string;
  modifiers: string[];
  isStatic?: boolean;
  isAsync?: boolean;
  isConstructor?: boolean;
  isPlaceholder?: boolean;
}

export interface CodeEndpoint extends CodeNode {
  endpointType: EndpointType;
  direction: "inbound" | "outbound";
  isExternal?: boolean;
  serviceName?: string;
  parseLevel?: "full" | "partial" | "unknown";
  targetService?: string;
  matchIdentity: string;
  httpMethod?: string;
  path?: string;
  normalizedPath?: string;
  uiEvent?: string;
  uiElement?: string;
  uiText?: string;
  uiSelector?: string;
  routePath?: string;
  componentName?: string;
  topic?: string;
  operation?: string;
  brokerType?: string;
  keyPattern?: string;
  command?: string;
  dataStructure?: string;
  tableName?: string;
  dbOperation?: string;
}

export interface CodeRelationship {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: RelationshipType;
  lineNumber?: number;
  callType?: string;
  language: NodeLanguage;
  projectName?: string;
  confidence?: Confidence;
  attributes?: Record<string, unknown>;
}

export interface CodeGraph {
  packages: CodePackage[];
  units: CodeUnit[];
  functions: CodeFunction[];
  relationships: CodeRelationship[];
  endpoints: CodeEndpoint[];
}

export function createEmptyGraph(): CodeGraph {
  return {
    packages: [],
    units: [],
    functions: [],
    relationships: [],
    endpoints: []
  };
}
