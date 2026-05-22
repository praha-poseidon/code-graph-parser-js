export function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

export function isHookName(name: string): boolean {
  return /^use[A-Z0-9].*/.test(name);
}

export function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}

export function normalizeHttpPath(pathValue: string): string {
  let value = pathValue.trim();
  value = value.replace(/^https?:\/\/[^/]+/i, "");
  value = value.split("?")[0] ?? value;
  value = value.replace(/\/+/g, "/");
  value = value.replace(/:([A-Za-z_$][\w$]*)/g, "{param}");
  value = value.replace(/\$\{[^}]+}/g, "{param}");
  value = value.replace(/\{[A-Za-z_$][\w$]*}/g, "{param}");
  if (!value.startsWith("/")) {
    value = `/${value}`;
  }
  if (value.length > 1) {
    value = value.replace(/\/$/, "");
  }
  return value || "/";
}
