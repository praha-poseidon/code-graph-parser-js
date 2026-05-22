export interface ParserOptions {
  projectRoot: string;
  projectName?: string;
  tsConfigPath?: string;
  endpointRulesDir?: string;
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
