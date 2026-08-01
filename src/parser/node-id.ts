export function moduleId(projectName: string, projectFilePath: string): string {
  return `${projectName}#${projectFilePath}`;
}

/** Directory package id. packagePath is project-relative, e.g. src/components/Foo */
export function directoryPackageId(projectName: string, packagePath: string): string {
  return `${projectName}#pkg#${packagePath}`;
}

export function unitId(projectName: string, projectFilePath: string, name: string): string {
  return `${projectName}#${projectFilePath}::${name}`;
}

export function functionId(projectName: string, projectFilePath: string, signature: string): string {
  return `${projectName}#${projectFilePath}::${signature}`;
}

export function endpointId(projectName: string, projectFilePath: string, matchIdentity: string, line: number): string {
  return `${projectName}#${projectFilePath}::endpoint:${matchIdentity}:${line}`;
}
