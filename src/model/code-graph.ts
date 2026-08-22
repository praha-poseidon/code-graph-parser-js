export type NodeLanguage = "javascript" | "typescript" | "unknown";

export type CodeNodeKind =
  | "package"
  | "module"
  | "function"
  | "endpoint";

export type RelationshipType =
  | "PACKAGE_TO_UNIT"
  | "PACKAGE_TO_PACKAGE"
  | "UNIT_TO_FUNCTION"
  | "CALLS"
  | "RENDERS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "OVERRIDES"
  | "JS_EXTENDS"
  | "JS_IMPLEMENTS"
  | "JS_OVERRIDES"
  | "TS_EXTENDS"
  | "TS_IMPLEMENTS"
  | "TS_OVERRIDES"
  | "FUNCTION_TO_ENDPOINT"
  | "ENDPOINT_TO_FUNCTION"
  | "MATCHES";

export type RelationshipKind =
  | "CALL"
  | "CONTAINS"
  | "SPECIALIZES"
  | "CONFORMS"
  | "REFINES"
  | "RENDERS"
  | "BINDS_ENDPOINT"
  | "MATCHES_ENDPOINT";

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
  /** full/partial/unknown from SER; config/unresolved from platform path dict. */
  parseLevel?: "full" | "partial" | "unknown" | "config" | "unresolved";
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
  /** MQ consumer group (metadata; not MATCHES identity). Aligned with Java MqEndpoint.group. */
  group?: string;
  operation?: string;
  brokerType?: string;
  keyPattern?: string;
  command?: string;
  dataStructure?: string;
  tableName?: string;
  dbOperation?: string;
  /** Opaque extra endpoint metadata emitted by SER `build { other: ... }`. */
  other?: string | null;
}

export interface CodeRelationship {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: RelationshipType;
  relationshipKind: RelationshipKind;
  fromNodeType: "CodePackage" | "CodeUnit" | "CodeFunction" | "CodeEndpoint";
  toNodeType: "CodePackage" | "CodeUnit" | "CodeFunction" | "CodeEndpoint";
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
