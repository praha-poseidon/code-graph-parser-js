export interface ParserOptions {
  projectRoot: string;
  projectName?: string;
  tsConfigPath?: string;
  /** SER rule files for static-extract (HTTP / UI / MQ / Redis / DB facts). */
  ruleSources?: string[];
  ruleTexts?: string[];
  /**
   * Legacy standalone value-trace documents. static-extract-js only supports
   * embedded `trace { }` in the same rule file (same as Java extract).
   * Parser merges these into each rule as embedded trace before calling extract.
   * Prefer embedding `trace { }` in the SER rule itself.
   */
  traceRuleSources?: string[];
  traceRuleTexts?: string[];
  /**
   * Identity dict: flat `{"src.api.user.createUser()": "/api/users"}`.
   * (Wire may also use `{ identity: { "key()": "v" } }`.)
   * Other namespaces e.g. config are used by value-trace, not identity override.
   */
  externalValues?: Record<string, unknown>;
  externalValuesFile?: string;
  /**
   * When true and presets not set: enable all local SER presets
   * (Java extract has no builtins; this is parser-js convenience).
   */
  staticExtractBuiltinRules?: boolean;
  staticExtractPresetRules?: boolean | string[];
  include?: string[];
  exclude?: string[];
  /**
   * When set, only these project files (absolute paths) are extracted and emitted.
   * The full project is still loaded for cross-file resolution, but graph building
   * (and the emitted CodeGraph) is scoped to these files. Undefined/empty => all files.
   */
  sourceFiles?: string[];
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
