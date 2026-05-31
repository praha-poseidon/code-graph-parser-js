export type StaticExtractPresetName =
  | "http-client"
  | "react-ui"
  | "router"
  | "next-file-route"
  | "decorator-route"
  | "integration";

export const DEFAULT_STATIC_EXTRACT_PRESETS: StaticExtractPresetName[] = ["http-client", "react-ui"];

export function resolveStaticExtractPresetRules(input: boolean | string[] | undefined): string[] {
  if (!input) return [];
  const names = input === true ? DEFAULT_STATIC_EXTRACT_PRESETS : normalizePresetNames(input);
  return names.flatMap((name) => PRESET_RULES[name] ?? []);
}

function normalizePresetNames(input: string[]): StaticExtractPresetName[] {
  const output = new Set<StaticExtractPresetName>();
  for (const raw of input) {
    const name = raw.trim();
    if (!name) continue;
    if (name === "all") {
      for (const preset of Object.keys(PRESET_RULES) as StaticExtractPresetName[]) output.add(preset);
      continue;
    }
    if (isPresetName(name)) output.add(name);
  }
  return [...output];
}

function isPresetName(value: string): value is StaticExtractPresetName {
  return Object.hasOwn(PRESET_RULES, value);
}

const PRESET_RULES: Record<StaticExtractPresetName, string[]> = {
  "http-client": [
    [
      "rule \"Preset Fetch API Call\"",
      "fact frontend_api_call",
      "",
      "find call fetch",
      "",
      "let method =",
      "  from call take method",
      "",
      "let path =",
      "  from argument[0] take value",
      "",
      "build {",
      "  client: \"fetch\"",
      "  method: method | normalize upper",
      "  path: path",
      "}"
    ].join("\n"),
    [
      "rule \"Preset Axios API Call\"",
      "fact frontend_api_call",
      "",
      "find call axios",
      "",
      "let method =",
      "  from call take method",
      "",
      "let path =",
      "  from argument[0] take value",
      "",
      "build {",
      "  client: \"axios\"",
      "  method: method | normalize upper | map { AXIOS: GET }",
      "  path: path",
      "}"
    ].join("\n"),
    httpClientMethodShortcutRule("axios"),
    httpClientMethodShortcutRule("requests"),
    httpClientMethodShortcutRule("request"),
    httpClientMethodShortcutRule("api"),
    httpClientMethodShortcutRule("client"),
    httpClientMethodShortcutRule("http"),
    httpClientMethodShortcutRule("superagent")
  ],
  "react-ui": [
    reactUiRule("button", "click", "onClick", "button", ["from children take text"], "button"),
    reactUiRule("a", "click", "onClick", "a", ["from children take text", "from prop href take value"], "link"),
    reactUiRule("input", "change", "onChange", "input", ["from prop name take value"], "input"),
    reactUiRule("form", "submit", "onSubmit", "form", ["from prop name take value"], "form")
  ],
  router: [
    routerRule("router"),
    routerRule("app")
  ],
  "next-file-route": [
    [
      "rule \"Preset Next Named Route Export\"",
      "fact http_route",
      "",
      "find export [GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS]",
      "",
      "let method =",
      "  from export take name",
      "",
      "let filePath =",
      "  from file take path",
      "",
      "let handler =",
      "  from export take reference",
      "",
      "build {",
      "  method: method",
      "  direction: \"inbound\"",
      "  path: filePath | normalize fileRoutePath",
      "  handler: handler",
      "}"
    ].join("\n"),
    [
      "rule \"Preset Next Default Route Export\"",
      "fact http_route",
      "",
      "find file",
      "",
      "let filePath =",
      "  from file take path",
      "",
      "let handler =",
      "  from export default take reference",
      "",
      "build {",
      "  method: \"ANY\"",
      "  direction: \"inbound\"",
      "  path: filePath | normalize fileRoutePath",
      "  handler: handler",
      "}"
    ].join("\n")
  ],
  "decorator-route": [
    [
      "rule \"Preset Decorator Route\"",
      "fact http_route",
      "",
      "find decorator [Get,Post,Put,Patch,Delete,Head,Options]",
      "",
      "let basePath =",
      "  from decorator on class Controller take value",
      "",
      "let methodName =",
      "  from decorator take name",
      "",
      "let methodPath =",
      "  from decorator take value",
      "",
      "let handler =",
      "  from method take name",
      "",
      "build {",
      "  method: methodName | normalize upper",
      "  direction: \"inbound\"",
      "  path: concat(basePath, \"/\", methodPath) | normalize httpPath",
      "  handler: handler",
      "}"
    ].join("\n")
  ],
  integration: [
    [
      "rule \"Preset Kafka Send\"",
      "fact mq_endpoint",
      "",
      "find call send",
      "when call owner kafka",
      "",
      "let topic =",
      "  from argument[0] take value",
      "",
      "build {",
      "  endpointType: \"MQ\"",
      "  direction: \"outbound\"",
      "  brokerType: \"KAFKA\"",
      "  operation: \"PRODUCE\"",
      "  topic: topic",
      "}"
    ].join("\n"),
    [
      "rule \"Preset Redis Command\"",
      "fact redis_endpoint",
      "",
      "find call [get,set,del]",
      "when call owner redis",
      "",
      "let command =",
      "  from call take method",
      "",
      "let keyPattern =",
      "  from argument[0] take value",
      "",
      "build {",
      "  endpointType: \"REDIS\"",
      "  direction: \"outbound\"",
      "  command: command | normalize upper | map { DEL: DELETE }",
      "  keyPattern: keyPattern",
      "}"
    ].join("\n"),
    [
      "rule \"Preset DB Query\"",
      "fact db_endpoint",
      "",
      "find call query",
      "when call owner db",
      "",
      "let sql =",
      "  from argument[0] take value",
      "",
      "build {",
      "  endpointType: \"DB\"",
      "  direction: \"outbound\"",
      "  dbOperation: \"QUERY\"",
      "  tableName: sql | regex \"[Ff][Rr][Oo][Mm]\\\\s+([A-Za-z_][A-Za-z0-9_]*)\" group 1",
      "}"
    ].join("\n")
  ]
};

function routerRule(owner: string): string {
  return [
    `rule "Preset ${owner} Router Call"`,
    "fact http_route",
    "",
    "find call [get,post,put,patch,delete,del]",
    `when call owner ${owner}`,
    "",
    "let method =",
    "  from call take method",
    "",
    "let path =",
    "  from argument[0] take value",
    "",
    "let handler =",
    "  from handler take reference",
    "",
    "build {",
    "  method: method | normalize upper | map { DEL: DELETE }",
    "  direction: \"inbound\"",
    "  path: path | normalize httpPath",
    "  handler: handler",
    "}"
  ].join("\n");
}

function httpClientMethodShortcutRule(owner: string): string {
  return [
    `rule "Preset ${owner} Method API Call"`,
    "fact frontend_api_call",
    "",
    "find call [get,post,put,patch,delete,del]",
    `when call owner ${owner}`,
    "",
    "let method =",
    "  from call take method",
    "",
    "let path =",
    "  from argument[0] take value",
    "",
    "build {",
    `  client: "${owner}"`,
    "  method: method | normalize upper | map { DEL: DELETE }",
    "  path: path",
    "}"
  ].join("\n");
}

function reactUiRule(tag: string, event: string, handlerProp: string, kind: string, textSources: string[], fallbackText: string): string {
  return [
    `rule "Preset React ${tag} ${event}"`,
    "fact ui_action",
    "",
    `find jsx ${tag}`,
    "",
    "let text =",
    ...textSources.map((source) => `  ${source}`),
    `  default ${fallbackText}`,
    "",
    "let handler =",
    `  from prop ${handlerProp} take reference`,
    "",
    "build {",
    `  kind: "${kind}"`,
    `  event: "${event}"`,
    "  text: text",
    "  handler: handler",
    "}"
  ].join("\n");
}
