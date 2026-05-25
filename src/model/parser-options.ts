export interface ParserOptions {
  projectRoot: string;
  projectName?: string;
  tsConfigPath?: string;
  endpointRulesDir?: string;
  ruleSources?: string[];
  traceRuleSources?: string[];
  externalValues?: Record<string, Record<string, string[]>>;
  externalValuesFile?: string;
  staticExtractBuiltinRules?: boolean;
  include?: string[];
  exclude?: string[];
  gitRepoUrl?: string;
  gitBranch?: string;
}

export interface ParseStats {
  files: number;
  packages: number;
  units: number;
  functions: number;
  endpoints: number;
  relationships: number;
}

export interface ParseResult {
  graph: import("./code-graph.js").CodeGraph;
  stats: ParseStats;
}
