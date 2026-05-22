export function moduleId(projectName: string, projectFilePath: string): string {
  return `${projectName}#${projectFilePath}`;
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
