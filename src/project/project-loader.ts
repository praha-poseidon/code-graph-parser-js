import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, ts } from "ts-morph";
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

export async function loadTypeScriptProject(options: ParserOptions): Promise<Project> {
  const tsConfigPath = resolveTsConfig(options);
  const project = tsConfigPath
    ? new Project({ tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: true })
    : new Project({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          esModuleInterop: true,
          skipLibCheck: true
        }
      });

  const files = await scanSourceFiles(options);
  project.addSourceFilesAtPaths(files);
  return project;
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

function resolveTsConfig(options: ParserOptions): string | undefined {
  if (options.tsConfigPath) {
    return path.resolve(options.tsConfigPath);
  }
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(options.projectRoot, name));
  return candidates.find((candidate) => fs.existsSync(candidate));
}
