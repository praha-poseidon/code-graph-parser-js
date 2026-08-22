export function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

export function isHookName(name: string): boolean {
  return /^use[A-Z0-9].*/.test(name);
}

export function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}
