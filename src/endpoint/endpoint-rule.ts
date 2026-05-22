export interface EndpointRule {
  id: string;
  endpointType?: "HTTP" | "GRAPHQL" | "UNKNOWN";
  direction?: "inbound" | "outbound";
  locate: LocateConfig;
  extract: Record<string, ExtractConfig>;
  normalize?: NormalizeConfig;
}

export interface LocateConfig {
  nodeType: "CallExpression";
  callee: CalleeMatcher;
}

export type CalleeMatcher =
  | string
  | {
      anyOf?: string[];
      regex?: string;
    };

export interface ExtractConfig {
  from?: PathSelector | { anyOf: PathSelector[] };
  default?: string;
  const?: string;
  trace?: boolean;
  transforms?: string[];
}

export type PathSelector =
  | "callee"
  | "callee.property"
  | `arguments[${number}]`
  | `arguments[${number}].properties.${string}`;

export interface NormalizeConfig {
  matchIdentity?: string;
}

export interface ExtractedEndpoint {
  ruleId: string;
  method: string;
  path: string;
  normalizedPath: string;
  matchIdentity: string;
  rawPath?: string;
  confidence: "exact" | "inferred" | "heuristic" | "partial" | "unresolved";
}
