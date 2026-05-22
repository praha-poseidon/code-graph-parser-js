import path from "node:path";

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function relativeProjectPath(projectRoot: string, filePath: string): string {
  return toPosixPath(path.relative(projectRoot, filePath));
}

export function stableId(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join("#");
}

export function lineOf(sourceFile: { getLineAndColumnAtPos(pos: number): { line: number } }, pos: number): number {
  return sourceFile.getLineAndColumnAtPos(pos).line;
}

export function isProjectSourceFile(filePath: string, projectRoot: string): boolean {
  const rel = toPosixPath(path.relative(projectRoot, filePath));
  return !rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel);
}
