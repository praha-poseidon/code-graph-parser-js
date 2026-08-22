import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { createModuleClosureProject } from "@static-extract/extractor-ts";
import type { Project } from "ts-morph";
import type { ParserOptions } from "../model/parser-options.js";

const DEFAULT_INCLUDE = ["src/**/*.{js,jsx,ts,tsx,mjs,cjs}"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/.git/**",
  "**/target/**",
  "**/generated/**",
  "**/*.min.js"
];

export interface LoadedTypeScriptProject {
  project: Project;
  loadPaths: string[];
  scanPaths: string[];
}

export async function loadTypeScriptProject(options: ParserOptions): Promise<LoadedTypeScriptProject> {
  const seeds = options.sourceFiles?.length
    ? normalizeSeeds(options.projectRoot, options.sourceFiles)
    : await scanSourceFiles(options);
  const closure = createModuleClosureProject(options.projectRoot, seeds, {
    moduleClosure: options.moduleClosure !== false,
    configFilePath: options.tsConfigPath
  });
  // Redux/DVA model effects are commonly referenced through dispatch.<model>.<effect>
  // without an import from the calling file. They are therefore outside a normal
  // module closure. Incremental requests still need those declarations for exact
  // CALLS targets, but they must not become part of SCAN/output.
  const semanticSidecars = options.sourceFiles?.length
    ? await discoverSemanticSidecars(options, new Set(closure.loadPaths.map((file) => path.resolve(file))))
    : [];
  if (semanticSidecars.length > 0) {
    (closure.project as unknown as Project).addSourceFilesAtPaths(semanticSidecars);
  }
  return {
    project: closure.project as unknown as Project,
    loadPaths: [...new Set([...closure.loadPaths, ...semanticSidecars])].sort(),
    scanPaths: closure.scanPaths
  };
}

async function discoverSemanticSidecars(options: ParserOptions, loaded: Set<string>): Promise<string[]> {
  const candidates = await scanSourceFiles(options);
  const result: string[] = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (loaded.has(absolute)) continue;
    let source: string;
    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (/\beffects\s*[:=]/.test(source)) result.push(absolute);
  }
  return result.sort();
}

export async function scanSourceFiles(options: ParserOptions): Promise<string[]> {
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  return fg(include, {
    cwd: options.projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: exclude
  });
}

export function resolveProjectName(projectRoot: string, explicitName?: string): string {
  if (explicitName) return explicitName;
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        return pkg.name;
      }
    } catch {
      // Fall through to directory name.
    }
  }
  return path.basename(projectRoot);
}

function normalizeSeeds(projectRoot: string, sourceFiles: string[]): string[] {
  return [...new Set(sourceFiles
    .map((filePath) => path.resolve(projectRoot, filePath))
    .filter((filePath) => fs.existsSync(filePath)))]
    .sort();
}
