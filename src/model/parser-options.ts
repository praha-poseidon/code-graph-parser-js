export interface ParserOptions {
  projectRoot: string;
  projectName?: string;
  tsConfigPath?: string;
  /** SER rule files for static-extract (HTTP / UI facts). */
  ruleSources?: string[];
  ruleTexts?: string[];
  traceRuleSources?: string[];
  traceRuleTexts?: string[];
  externalValues?: Record<string, Record<string, string[]>>;
  externalValuesFile?: string;
  staticExtractBuiltinRules?: boolean;
  staticExtractPresetRules?: boolean | string[];
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
