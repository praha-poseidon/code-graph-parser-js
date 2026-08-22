import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReactCodeGraphParser } from "./react-code-graph-parser.js";
import type { CodeGraph } from "../model/code-graph.js";
import { toGraphDelta } from "../model/process-protocol.js";
import { loadTypeScriptProject } from "../project/project-loader.js";

test("parses React JSX graph and outbound endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-code-graph-"));
  fs.mkdirSync(path.join(root, "src/api"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/components"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/pages"), { recursive: true });

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-app" }), "utf8");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src/api/user.js"),
    "export function getUser(id) { return request.get(`/api/users/${id}`); }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src/components/UserCard.jsx"),
    "export default function UserCard(props) { return <section>{props.name}</section>; }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src/pages/UserPage.jsx"),
    [
      "import UserCard from '../components/UserCard.jsx';",
      "import { getUser } from '../api/user.js';",
      "export default function UserPage() {",
      "  getUser('1');",
      "  return <UserCard onRefresh={getUser} />;",
      "}"
    ].join("\n"),
    "utf8"
  );

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  assert.ok(result.graph.units.some((unit) => unit.id === "fixture-app#src/pages/UserPage.jsx"));
  assert.ok(result.graph.functions.some((fn) => fn.id === "fixture-app#src/pages/UserPage.jsx::UserPage()"));
  assert.ok(result.graph.relationships.some((rel) => rel.relationshipType === "CALLS" && rel.toNodeId === "fixture-app#src/api/user.js::getUser(id)"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/users/{param}"));
});

test("parses mixed JS TSX project into graph without graph storage", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "mixed-react-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api/http.ts": [
      "export const API_PREFIX = '/api';",
      "export function listUsers() { return fetch(`${API_PREFIX}/users`, { method: 'GET' }); }",
      "export function createUser(data: unknown) { return axios.post('/api/users', data); }",
      "const Articles = {",
      "  delete: (slug: string) => requests.del(`/api/articles/${slug}`)",
      "};"
    ].join("\n"),
    "src/hooks/useUsers.ts": [
      "import { listUsers } from '../api/http';",
      "export function useUsers() {",
      "  return listUsers();",
      "}"
    ].join("\n"),
    "src/components/UserList.jsx": [
      "export default function UserList() {",
      "  return <ul />;",
      "}"
    ].join("\n"),
    "src/pages/UserPage.tsx": [
      "import UserList from '../components/UserList.jsx';",
      "import { useUsers } from '../hooks/useUsers';",
      "export function UserPage() {",
      "  const users = useUsers();",
      "  return <UserList users={users} />;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const ids = {
    pageUnit: "mixed-react-app#src/pages/UserPage.tsx",
    listUnit: "mixed-react-app#src/components/UserList.jsx",
    page: "mixed-react-app#src/pages/UserPage.tsx::UserPage()",
    list: "mixed-react-app#src/components/UserList.jsx::UserList()",
    useUsers: "mixed-react-app#src/hooks/useUsers.ts::useUsers()",
    listUsers: "mixed-react-app#src/api/http.ts::listUsers()",
    createUser: "mixed-react-app#src/api/http.ts::createUser(data: unknown)"
  };

  assertGraphHasUnit(result, ids.pageUnit);
  assertGraphHasUnit(result, ids.listUnit);
  assertGraphHasFunction(result, ids.page);
  assertGraphHasFunction(result, ids.list);
  assertGraphHasFunction(result, ids.useUsers);
  assertGraphHasFunction(result, ids.listUsers);
  assertGraphHasFunction(result, ids.createUser);
  assertGraphHasFunction(result, "mixed-react-app#src/api/http.ts::Articles.delete(slug: string)");

  assertGraphHasRelationship(result, "CALLS", ids.page, ids.useUsers);
  assertGraphHasRelationship(result, "CALLS", ids.useUsers, ids.listUsers);

  assert.ok(
    result.graph.endpoints.some((endpoint) =>
      endpoint.matchIdentity === "HTTP:GET:/api/users" &&
      endpoint.attributes?.source === "static-extract"
    )
  );
  assert.ok(
    result.graph.endpoints.some((endpoint) =>
      endpoint.matchIdentity === "HTTP:POST:/api/users" &&
      endpoint.attributes?.source === "static-extract"
    )
  );
  assert.ok(
    result.graph.endpoints.some((endpoint) =>
      endpoint.matchIdentity === "HTTP:DELETE:/api/articles/{param}" &&
      endpoint.attributes?.source === "static-extract"
    )
  );
});

test("incremental parse loads the import closure but scans only seeds", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "incremental-closure-app" }),
    "src/dependency.js": [
      'export const API = "/api/from-dependency";',
      'export function target() { return fetch("/api/dependency-only"); }'
    ].join("\n"),
    "src/seed.js": [
      'import { API, target } from "./dependency.js";',
      "export function seed() { target(); return fetch(API); }"
    ].join("\n"),
    "src/unrelated.js": "export function unrelated() { return 1; }\n"
  });
  const seed = path.join(root, "src/seed.js");
  const dependency = path.join(root, "src/dependency.js");

  const loaded = await loadTypeScriptProject({ projectRoot: root, sourceFiles: [seed] });
  assert.deepEqual(loaded.scanPaths, [seed]);
  assert.ok(loaded.loadPaths.includes(dependency));
  assert.ok(!loaded.loadPaths.includes(path.join(root, "src/unrelated.js")));

  const withoutClosure = await loadTypeScriptProject({
    projectRoot: root,
    sourceFiles: [seed],
    moduleClosure: false
  });
  assert.deepEqual(withoutClosure.loadPaths, [seed]);

  const result = await new ReactCodeGraphParser().parse({
    projectRoot: root,
    sourceFiles: [seed],
    staticExtractPresetRules: ["http-client"]
  });
  assert.deepEqual(result.graph.units.map((unit) => unit.projectFilePath), ["src/seed.js"]);
  assert.ok(result.graph.relationships.some((relationship) =>
    relationship.relationshipType === "CALLS"
      && relationship.toNodeId.includes("src/dependency.js::target()")
  ));
  assert.deepEqual(
    result.graph.endpoints.map((endpoint) => endpoint.matchIdentity),
    ["HTTP:GET:/api/from-dependency"]
  );
});

test("incremental parse discovers jsconfig path aliases", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "incremental-alias-app" }),
    "jsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true, baseUrl: ".", paths: { "@/*": ["src/*"] } }
    }),
    "src/config.js": 'export const API = "/api/alias-closure";\n',
    "src/seed.js": 'import { API } from "@/config";\nexport function seed() { return fetch(API); }\n'
  });
  const seed = path.join(root, "src/seed.js");

  const loaded = await loadTypeScriptProject({ projectRoot: root, sourceFiles: [seed] });
  assert.ok(loaded.loadPaths.includes(path.join(root, "src/config.js")));

  const result = await new ReactCodeGraphParser().parse({
    projectRoot: root,
    sourceFiles: [seed],
    staticExtractPresetRules: ["http-client"]
  });
  assert.equal(result.graph.endpoints.length, 1);
  assert.equal(result.graph.endpoints[0]?.matchIdentity, "HTTP:GET:/api/alias-closure");
});

test("one-file incremental graph union is exactly equivalent to a full parse", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "incremental-equivalence-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { moduleResolution: "bundler", baseUrl: "." },
      include: ["src/**/*"]
    }),
    "src/api.ts": [
      "export const URL = '/api/users';",
      "export function saveUser() { return fetch(URL, { method: 'POST' }); }"
    ].join("\n"),
    "src/service.ts": [
      "import { saveUser } from './api';",
      "export function save() { return saveUser(); }"
    ].join("\n"),
    "src/page.ts": [
      "import { save } from './service';",
      "export function submit() { return save(); }"
    ].join("\n")
  });
  const options = { projectRoot: root, staticExtractPresetRules: ["http-client"] };
  const full = await new ReactCodeGraphParser().parse(options);
  const files = ["src/api.ts", "src/service.ts", "src/page.ts"].map((file) => path.join(root, file));
  const deltas = [];
  for (const sourceFile of files) {
    deltas.push((await new ReactCodeGraphParser().parse({ ...options, sourceFiles: [sourceFile] })).graph);
  }

  const union = {
    packages: unionById(deltas.flatMap((graph) => graph.packages)),
    units: unionById(deltas.flatMap((graph) => graph.units)),
    functions: unionById(deltas.flatMap((graph) => graph.functions)),
    relationships: unionById(deltas.flatMap((graph) => graph.relationships)),
    endpoints: unionById(deltas.flatMap((graph) => graph.endpoints))
  };
  assert.deepEqual(canonicalGraph(union), canonicalGraph(full.graph));
});

test("converts parsed frontend graph to process GraphDelta protocol", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "protocol-react-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api/user.ts": "export function getUser(id: string) { return fetch(`/api/users/${id}`); }",
    "src/pages/UserPage.tsx": [
      "import { getUser } from '../api/user';",
      "export function UserPage() {",
      "  getUser('1');",
      "  return <main />;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    projectName: "protocol-react-app",

    gitRepoUrl: "https://example.com/protocol-react-app.git",
    gitBranch: "main",
    staticExtractPresetRules: true
  });

  const delta = toGraphDelta({
    graph: result.graph,
    projectName: "protocol-react-app",
    projectRoot: root,
    request: {
      projectName: "protocol-react-app",
      language: "typescript",
      projectRoot: root,
      sourceFiles: [],
      sourceRoots: [path.join(root, "src")],
      dependencies: [],
      gitRepoUrl: "https://example.com/protocol-react-app.git",
      gitBranch: "main",
      changeType: "SOURCE_MODIFIED",
      options: {}
    }
  });

  assert.equal(delta.scope.projectName, "protocol-react-app");
  assert.equal(delta.deletedNodeIds.length, 0);
  assert.ok(delta.units.every((unit) => unit.projectName === "protocol-react-app"));
  assert.ok(delta.functions.every((fn) => fn.projectName === "protocol-react-app"));
  assert.ok(delta.relationships.every((rel) => rel.projectName === "protocol-react-app"));
  assert.ok(delta.endpoints.every((endpoint) => endpoint.endpointKind === "http"));
  assert.ok(delta.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/users/{param}"));
});

test("adds outbound endpoints from static-extract facts with trace rules", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-react-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api/user.ts": [
      "const config = {",
      "  get(key: string) { return key; }",
      "};",
      "export function renderDiagram(content: string) {",
      "  const url = `${serverUrl}/svg/${content}`;",
      "  return fetch(url);",
      "}",
      "export function loadUsers() {",
      "  return fetch(config.get('usersUrl'));",
      "}"
    ].join("\n"),
    "rules/api.ser": [
      "rule \"Fetch With External Config\"",
      "fact frontend_api_call",
      "",
      "find call fetch",
      "",
      "let path =",
      "  from argument[0] take value",
      "",
      "build {",
      "  client: \"fetch\"",
      "  path: path | normalize httpPath",
      "}"
    ].join("\n"),
    "rules/config.trace.ser": [
      "trace \"TS Config Trace\"",
      "",
      "from call",
      "when call config.get",
      "",
      "let configKey =",
      "  from argument[0] take value",
      "",
      "build {",
      "  namespace: \"config\"",
      "  key: configKey",
      "}"
    ].join("\n"),
    "rules/external-values.json": JSON.stringify({
      config: {
        usersUrl: ["/api/static-users"]
      }
    })
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    ruleSources: [path.join(root, "rules/api.ser")],
    traceRuleSources: [path.join(root, "rules/config.trace.ser")],
    externalValuesFile: path.join(root, "rules/external-values.json")
  });

  const endpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/api/static-users");
  assert.ok(endpoint);
  assert.equal(endpoint.attributes?.source, "static-extract");
  assert.ok(result.graph.endpoints.some((item) => item.matchIdentity === "HTTP:GET:/svg/{param}"));
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "static-extract-react-app#src/api/user.ts::loadUsers()",
    endpoint.id
  );
});

test("adds inbound route endpoints from static-extract facts", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-route-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes.ts": [
      "function handleUsers() {",
      "  return 'ok';",
      "}",
      "customRoute('/ser/users/:id', handleUsers);"
    ].join("\n"),
    "rules/route.ser": [
      "rule \"Custom Route\"",
      "fact http_route",
      "",
      "find call customRoute",
      "",
      "let path =",
      "  from argument[0] take value",
      "",
      "let handler =",
      "  from handler take reference",
      "",
      "build {",
      "  method: \"GET\"",
      "  direction: \"inbound\"",
      "  path: path | normalize pathVariable",
      "  handler: handler",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    ruleSources: [path.join(root, "rules/route.ser")]
  });

  const endpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/ser/users/{param}");
  assert.ok(endpoint);
  assert.equal(endpoint.direction, "inbound");
  assert.equal(endpoint.attributes?.source, "static-extract");
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    endpoint.id,
    "static-extract-route-app#src/routes.ts::handleUsers()"
  );
});

test("ignores UI action facts because UI is not an engine endpoint type", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-ui-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/page.tsx": [
      "function ActionButton(props: { label: string; onPress: () => void }) {",
      "  return <button>{props.label}</button>;",
      "}",
      "export function Page() {",
      "  const handlePress = () => fetch('/api/press', { method: 'POST' });",
      "  return <ActionButton label=\"Press Save\" onPress={handlePress} />;",
      "}"
    ].join("\n"),
    "rules/ui.ser": [
      "rule \"Action Button Press\"",
      "fact ui_action",
      "",
      "find jsx ActionButton",
      "",
      "let text =",
      "  from prop label take value",
      "",
      "let handler =",
      "  from prop onPress take reference",
      "",
      "build {",
      "  component: \"ActionButton\"",
      "  kind: \"button\"",
      "  event: \"press\"",
      "  text: text",
      "  handler: handler",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    ruleSources: [path.join(root, "rules/ui.ser")]
  });

  assert.ok(!result.graph.endpoints.some((item) => item.endpointType === "UI"));
  assert.ok(!result.graph.relationships.some((item) =>
    item.relationshipType === "ENDPOINT_TO_FUNCTION" &&
    item.toNodeId === "static-extract-ui-app#src/page.tsx::handlePress()"
  ));
});

test("accepts in-memory SER and trace rules from parser options", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-inline-rules-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api.ts": [
      "const config = { get(key: string) { return key; } };",
      "export function loadInlineUsers() {",
      "  return fetch(config.get('usersUrl'));",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    // ruleSources intentionally carries inline SER here. Other fixtures cover
    // the file-path form so both wire-compatible representations stay tested.
    ruleSources: [[
      "rule \"Inline Fetch\"",
      "fact frontend_api_call",
      "",
      "find call fetch",
      "",
      "let path =",
      "  from argument[0] take value",
      "",
      "build {",
      "  client: \"fetch\"",
      "  path: path",
      "}"
    ].join("\n")],
    traceRuleTexts: [[
      "trace \"Inline Config Trace\"",
      "",
      "from call",
      "when call config.get",
      "",
      "let configKey =",
      "  from argument[0] take value",
      "",
      "build {",
      "  namespace: \"config\"",
      "  key: configKey",
      "}"
    ].join("\n")],
    externalValues: {
      config: {
        usersUrl: ["/api/inline-users"]
      }
    },

  });

  const endpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/api/inline-users");
  assert.ok(endpoint);
  assert.equal(endpoint.attributes?.source, "static-extract");
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "static-extract-inline-rules-app#src/api.ts::loadInlineUsers()",
    endpoint.id
  );
});

test("maps non-http SER endpoint facts to graph endpoints", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-mq-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/mq.ts": [
      "const kafka = {",
      "  send(topic: string, payload: unknown) { return topic; },",
      "  subscribe(topic: string, group: string) { return topic; }",
      "};",
      "export function publishOrder(order: unknown) {",
      "  return kafka.send('orders.created', order);",
      "}",
      "export function consumeOrder() {",
      "  return kafka.subscribe('orders.created', 'order-consumer-group');",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    ruleTexts: [[
      "rule \"Kafka Send\"",
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
      "  other: \"schema=order-v2\"",
      "}"
    ].join("\n"), [
      "rule \"Kafka Subscribe\"",
      "fact mq_endpoint",
      "",
      "find call subscribe",
      "when call owner kafka",
      "",
      "let topic =",
      "  from argument[0] take value",
      "",
      "let group =",
      "  from argument[1] take value",
      "",
      "build {",
      "  endpointType: \"MQ\"",
      "  direction: \"inbound\"",
      "  brokerType: \"KAFKA\"",
      "  operation: \"CONSUME\"",
      "  topic: topic",
      "  group: group",
      "  handler: \"consumeOrder\"",
      "}"
    ].join("\n")],

  });

  const endpoint = result.graph.endpoints.find((item) => item.matchIdentity === "MQ:orders.created" && item.direction === "outbound");
  assert.ok(endpoint);
  assert.equal(endpoint.endpointType, "MQ");
  assert.equal(endpoint.topic, "orders.created");
  assert.equal(endpoint.brokerType, "KAFKA");
  assert.equal(endpoint.operation, "PRODUCE");
  assert.equal(endpoint.other, "schema=order-v2");
  assert.equal(endpoint.matchIdentity, "MQ:orders.created", "other must not change endpoint identity");
  assert.equal(endpoint.attributes?.source, "static-extract");
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "static-extract-mq-app#src/mq.ts::publishOrder(order: unknown)",
    endpoint.id
  );

  const consumer = result.graph.endpoints.find(
    (item) => item.matchIdentity === "MQ:orders.created" && item.direction === "inbound"
  );
  assert.ok(consumer, "MQ consumer endpoint expected");
  assert.equal(consumer.group, "order-consumer-group");
  assert.equal(consumer.topic, "orders.created");
  assert.equal(consumer.operation, "CONSUME");

  const delta = toGraphDelta({
    graph: result.graph,
    request: { projectRoot: root, language: "typescript" },
    projectName: "static-extract-mq-app",
    projectRoot: root
  });
  const deltaEndpoint = delta.endpoints.find((item) => item.matchIdentity === "MQ:orders.created" && item.direction === "outbound");
  assert.ok(deltaEndpoint);
  assert.equal(deltaEndpoint.endpointKind, "mq");
  assert.equal(deltaEndpoint.topic, "orders.created");
  assert.equal(deltaEndpoint.brokerType, "KAFKA");
  assert.equal(deltaEndpoint.other, "schema=order-v2");
  const deltaConsumer = delta.endpoints.find(
    (item) => item.matchIdentity === "MQ:orders.created" && item.direction === "inbound"
  );
  assert.ok(deltaConsumer, "process-protocol must emit MQ consumer");
  assert.equal(deltaConsumer.group, "order-consumer-group", "process-protocol must pass MQ group");
});

test("can disable parser endpoint inference and use SER facts instead", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-ser-only-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/actions.ts": [
      "function Area(_path: string) { return () => undefined; }",
      "function Action(_path: string) { return () => undefined; }",
      "@Area('/ser')",
      "export class UsersActions {",
      "  @Action('/users/:id')",
      "  findOne() { return 'ok'; }",
      "}",
      "export function Page() {",
      "  const handleClick = () => fetch('/api/legacy-disabled');",
      "  return <button onClick={handleClick}>Legacy Disabled</button>;",
      "}"
    ].join("\n"),
    "rules/actions.ser": [
      "rule \"SER Decorator Action\"",
      "fact http_route",
      "",
      "find decorator Action",
      "",
      // static-extract-js / Java SER: `from decorator Name on class`
      "let basePath =",
      "  from decorator Area on class take value",
      "",
      "let methodPath =",
      "  from decorator take value",
      "",
      "build {",
      "  method: \"GET\"",
      "  direction: \"inbound\"",
      "  path: concat(basePath, \"/\", methodPath) | normalize httpPath",
      "  handler: \"findOne\"",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    ruleSources: [path.join(root, "rules/actions.ser")],

  });

  const endpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/ser/users/{param}");
  assert.ok(endpoint);
  assert.equal(endpoint.attributes?.source, "static-extract");
  assert.ok(!result.graph.endpoints.some((item) => item.matchIdentity === "HTTP:GET:/api/legacy-disabled"));
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    endpoint.id,
    "static-extract-ser-only-app#src/actions.ts::UsersActions.findOne()"
  );
});

test.skip("SER-only mode extracts router, UI, and file-route facts", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-ser-baseline-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes.tsx": [
      "function listUsers() { return fetch('/api/ser-list'); }",
      "function handleClick() { return fetch('/api/ser-click', { method: 'POST' }); }",
      "router.get('/ser/users/:id', listUsers);",
      "export function Page() {",
      "  return <button onClick={handleClick}>SER Save</button>;",
      "}"
    ].join("\n"),
    "src/pages/api/orders/[id].ts": [
      "export default function handler() {",
      "  return fetch('/api/ser-orders');",
      "}"
    ].join("\n"),
    "rules/router.ser": [
      "rule \"SER Router Get\"",
      "fact http_route",
      "",
      "find call get",
      "when call owner router",
      "",
      "let path =",
      "  from argument[0] take value",
      "",
      "let handler =",
      "  from handler take reference",
      "",
      "build {",
      "  method: \"GET\"",
      "  direction: \"inbound\"",
      "  path: path | normalize httpPath",
      "  handler: handler",
      "}"
    ].join("\n"),
    "rules/ui.ser": [
      "rule \"SER JSX Click\"",
      "fact ui_action",
      "",
      "find jsx button",
      "",
      "let text =",
      "  from children take text",
      "",
      "let handler =",
      "  from prop onClick take reference",
      "",
      "build {",
      "  kind: \"button\"",
      "  event: \"click\"",
      "  text: text",
      "  handler: handler",
      "}"
    ].join("\n"),
    "rules/file-route.ser": [
      "rule \"SER File Route\"",
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
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    ruleSources: [
      path.join(root, "rules/router.ser"),
      path.join(root, "rules/ui.ser"),
      path.join(root, "rules/file-route.ser")
    ],

  });

  const routerEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/ser/users/{param}");
  const uiEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "UI:CLICK:button:SER Save");
  const fileRouteEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:ANY:/api/orders/{param}");

  assert.ok(routerEndpoint);
  assert.ok(uiEndpoint);
  assert.ok(fileRouteEndpoint);
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    routerEndpoint.id,
    "static-extract-ser-baseline-app#src/routes.tsx::listUsers()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    uiEndpoint.id,
    "static-extract-ser-baseline-app#src/routes.tsx::handleClick()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    fileRouteEndpoint.id,
    "static-extract-ser-baseline-app#src/pages/api/orders/[id].ts::handler()"
  );
});

test.skip("SER preset rules extract common frontend endpoints without legacy inference", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "static-extract-preset-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes.tsx": [
      "function listUsers() { return fetch('/api/preset-users'); }",
      "function saveUser() { return axios.post('/api/preset-axios-users'); }",
      "function handleClick() { return fetch('/api/preset-click', { method: 'POST' }); }",
      "router.get('/preset/users/:id', listUsers);",
      "export function Page() {",
      "  return <><button onClick={handleClick}>Preset Save</button><a onClick={handleClick}>Preset Link</a><input name=\"Preset Search\" onChange={handleClick} /><form name=\"Preset Form\" onSubmit={handleClick}></form></>;",
      "}"
    ].join("\n"),
    "src/pages/api/orders/[id].ts": [
      "export default function handler() {",
      "  return fetch('/api/preset-orders');",
      "}"
    ].join("\n"),
    "src/controller.ts": [
      "function Controller(_path: string) { return () => undefined; }",
      "function Get(_path: string) { return () => undefined; }",
      "@Controller('/preset')",
      "export class UsersController {",
      "  @Get('/decorated')",
      "  list() { return 'ok'; }",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    staticExtractPresetRules: ["http-client", "router", "next-file-route", "decorator-route"],

  });

  const outbound = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/api/preset-users");
  const axiosOutbound = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:POST:/api/preset-axios-users");
  const routerEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/preset/users/{param}");
  const uiEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "UI:CLICK:button:Preset Save");
  const linkEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "UI:CLICK:a:Preset Link");
  const inputEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "UI:CHANGE:input:Preset Search");
  const formEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "UI:SUBMIT:form:Preset Form");
  const fileRouteEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:ANY:/api/orders/{param}");
  const decoratorEndpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/preset/decorated");

  assert.ok(outbound);
  assert.ok(axiosOutbound);
  assert.ok(routerEndpoint);
  assert.ok(uiEndpoint);
  assert.ok(linkEndpoint);
  assert.ok(inputEndpoint);
  assert.ok(formEndpoint);
  assert.ok(fileRouteEndpoint);
  assert.ok(decoratorEndpoint);
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "static-extract-preset-app#src/routes.tsx::listUsers()",
    outbound.id
  );
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "static-extract-preset-app#src/routes.tsx::saveUser()",
    axiosOutbound.id
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    routerEndpoint.id,
    "static-extract-preset-app#src/routes.tsx::listUsers()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    uiEndpoint.id,
    "static-extract-preset-app#src/routes.tsx::handleClick()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    linkEndpoint.id,
    "static-extract-preset-app#src/routes.tsx::handleClick()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    inputEndpoint.id,
    "static-extract-preset-app#src/routes.tsx::handleClick()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    formEndpoint.id,
    "static-extract-preset-app#src/routes.tsx::handleClick()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    fileRouteEndpoint.id,
    "static-extract-preset-app#src/pages/api/orders/[id].ts::handler()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    decoratorEndpoint.id,
    "static-extract-preset-app#src/controller.ts::UsersController.list()"
  );
});

test.skip("full demo project emits GraphDelta with common endpoint kinds in SER-only mode", async () => {
  const root = path.resolve("examples/full-demo");
  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    staticExtractPresetRules: ["all"],

  });

  const delta = toGraphDelta({
    graph: result.graph,
    request: { projectRoot: root, language: "typescript" },
    projectName: "code-graph-parser-js-full-demo",
    projectRoot: root
  });

  const endpointByIdentity = new Map(delta.endpoints.map((endpoint) => [endpoint.matchIdentity, endpoint]));

  assert.equal(endpointByIdentity.get("HTTP:GET:/api/users")?.endpointKind, "http");
  assert.equal(endpointByIdentity.get("HTTP:POST:/api/users")?.endpointKind, "http");
  assert.equal(endpointByIdentity.get("HTTP:GET:/users/{param}")?.endpointKind, "http");
  assert.equal(endpointByIdentity.get("HTTP:ANY:/api/orders/{param}")?.endpointKind, "http");
  assert.equal(endpointByIdentity.get("HTTP:GET:/api/products/{param}")?.endpointKind, "http");
  assert.equal(endpointByIdentity.get("HTTP:GET:/admin/users")?.endpointKind, "http");
  assert.equal(endpointByIdentity.get("UI:CLICK:button:Save User")?.endpointKind, "ui");
  assert.equal(endpointByIdentity.get("UI:CLICK:a:Open User")?.endpointKind, "ui");
  assert.equal(endpointByIdentity.get("UI:CHANGE:input:Search User")?.endpointKind, "ui");
  assert.equal(endpointByIdentity.get("UI:SUBMIT:form:User Form")?.endpointKind, "ui");
  assert.equal(endpointByIdentity.get("MQ:users.created")?.endpointKind, "mq");
  assert.equal(endpointByIdentity.get("MQ:users.created")?.topic, "users.created");
  assert.equal(endpointByIdentity.get("REDIS:user:*")?.endpointKind, "redis");
  assert.equal(endpointByIdentity.get("REDIS:user:*")?.keyPattern, "user:*");
  assert.equal(endpointByIdentity.get("DB:users")?.endpointKind, "db");
  assert.equal(endpointByIdentity.get("DB:users")?.tableName, "users");

  assert.ok(!delta.endpoints.some((endpoint) => endpoint.endpointKind === "http" && endpoint.matchIdentity?.includes("undefined")));
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "code-graph-parser-js-full-demo#src/routes.tsx::listUsers()",
    result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "MQ:users.created")?.id ?? ""
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:Save User")?.id ?? "",
    "code-graph-parser-js-full-demo#src/routes.tsx::handleClick()"
  );
});

test.skip("parses JSX UI actions as inbound endpoints linked to handlers", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ui-action-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/pages/UserPage.tsx": [
      "export function UserPage() {",
      "  const handleSave = () => fetch('/api/users', { method: 'POST' });",
      "  const saving = false;",
      "  return <><button onClick={handleSave}>保存</button><button onClick={handleSave}>{saving ? '保存中' : '提交'}</button><input placeholder=\"用户名\" onChange={handleSave} /></>;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const uiEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:保存");
  assert.ok(uiEndpoint);
  assert.equal(uiEndpoint.endpointType, "UI");
  assert.equal(uiEndpoint.direction, "inbound");
  assert.equal(uiEndpoint.uiEvent, "click");
  assert.equal(uiEndpoint.uiElement, "button");
  assert.equal(uiEndpoint.uiText, "保存");
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:保存中 / 提交"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "UI:CHANGE:input:用户名"));

  const handlerId = "ui-action-app#src/pages/UserPage.tsx::handleSave()";
  assertGraphHasFunction(result, handlerId);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", uiEndpoint.id, handlerId);
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/users"));
});

test("resolves TypeScript symbols for calls and type relationships", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "semantic-ts-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/contracts.ts": [
      "export interface ApiClient {",
      "  save(): Promise<void>;",
      "}",
      "export class BaseService {",
      "  log() {}",
      "}"
    ].join("\n"),
    "src/other.ts": [
      "export interface ApiClient {",
      "  save(): Promise<void>;",
      "}"
    ].join("\n"),
    "src/service.ts": [
      "import { ApiClient, BaseService } from './contracts';",
      "export class UserService extends BaseService implements ApiClient {",
      "  save() { return fetch('/api/users', { method: 'POST' }); }",
      "}"
    ].join("\n"),
    "src/page.tsx": [
      "import { UserService } from './service';",
      "const service = new UserService();",
      "export function UserPage() {",
      "  const handleSave = () => service.save();",
      "  return <button onClick={handleSave}>Save</button>;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const ids = {
    contractsUnit: "semantic-ts-app#src/contracts.ts",
    serviceUnit: "semantic-ts-app#src/service.ts",
    apiClient: "semantic-ts-app#src/contracts.ts::ApiClient",
    baseService: "semantic-ts-app#src/contracts.ts::BaseService",
    userService: "semantic-ts-app#src/service.ts::UserService",
    handleSave: "semantic-ts-app#src/page.tsx::handleSave()",
    save: "semantic-ts-app#src/service.ts::UserService.save()",
    interfaceSave: "semantic-ts-app#src/contracts.ts::ApiClient.save()",
    wrongApiClient: "semantic-ts-app#src/other.ts::ApiClient"
  };

  assertGraphHasUnit(result, ids.contractsUnit);
  assertGraphHasUnit(result, ids.serviceUnit);
  assertGraphHasUnit(result, ids.apiClient);
  assertGraphHasUnit(result, ids.baseService);
  assertGraphHasUnit(result, ids.userService);
  assertGraphHasFunction(result, ids.save);
  assertGraphHasFunction(result, ids.interfaceSave);
  assertGraphHasRelationship(result, "UNIT_TO_FUNCTION", ids.userService, ids.save);
  assertGraphHasRelationship(result, "UNIT_TO_FUNCTION", ids.apiClient, ids.interfaceSave);
  assertGraphHasRelationship(result, "EXTENDS", ids.userService, ids.baseService);
  assertGraphHasRelationship(result, "IMPLEMENTS", ids.userService, ids.apiClient);
  assertGraphLacksRelationship(result, "IMPLEMENTS", ids.userService, ids.wrongApiClient);
  assertGraphHasRelationship(result, "OVERRIDES", ids.save, ids.interfaceSave);
  assertGraphHasRelationship(result, "CALLS", ids.handleSave, ids.save);

  assert.ok(!result.graph.endpoints.some((endpoint) => endpoint.endpointType === "UI"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/users"));
});

test("resolves class member calls, super calls, and barrel exports", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "advanced-ts-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/services/base.ts": [
      "export class BaseService {",
      "  save() { return fetch('/api/base', { method: 'POST' }); }",
      "}"
    ].join("\n"),
    "src/services/user-service.ts": [
      "import { BaseService } from './base';",
      "export class UserService extends BaseService {",
      "  save() {",
      "    super.save();",
      "    return fetch('/api/users', { method: 'POST' });",
      "  }",
      "}"
    ].join("\n"),
    "src/services/form-service.ts": [
      "import { UserService } from './user-service';",
      "export class FormService {",
      "  private direct = new UserService();",
      "  constructor(private injected: UserService) {}",
      "  saveInjected() { return this.injected.save(); }",
      "  saveDirect() { return this.direct.save(); }",
      "}"
    ].join("\n"),
    "src/services/index.ts": "export { UserService } from './user-service';",
    "src/page.tsx": [
      "import { UserService } from './services';",
      "import { FormService } from './services/form-service';",
      "const form = new FormService(new UserService());",
      "export function UserPage() {",
      "  const handleSave = () => {",
      "    form.saveInjected();",
      "    form.saveDirect();",
      "  };",
      "  return <button onClick={handleSave}>Save</button>;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const ids = {
    pageHandler: "advanced-ts-app#src/page.tsx::handleSave()",
    formSaveInjected: "advanced-ts-app#src/services/form-service.ts::FormService.saveInjected()",
    formSaveDirect: "advanced-ts-app#src/services/form-service.ts::FormService.saveDirect()",
    userSave: "advanced-ts-app#src/services/user-service.ts::UserService.save()",
    baseSave: "advanced-ts-app#src/services/base.ts::BaseService.save()"
  };

  assertGraphHasRelationship(result, "CALLS", ids.pageHandler, ids.formSaveInjected);
  assertGraphHasRelationship(result, "CALLS", ids.pageHandler, ids.formSaveDirect);
  assertGraphHasRelationship(result, "CALLS", ids.formSaveInjected, ids.userSave);
  assertGraphHasRelationship(result, "CALLS", ids.formSaveDirect, ids.userSave);
  assertGraphHasRelationship(result, "CALLS", ids.userSave, ids.baseSave);
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/base"));
});

test.skip("links UI events passed through component props back to known parent handlers", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "react-props-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/components/UserForm.tsx": [
      "type Props = { onSave: () => void };",
      "export function UserForm(props: Props) {",
      "  return <button onClick={props.onSave}>Save</button>;",
      "}"
    ].join("\n"),
    "src/page.tsx": [
      "import { UserForm } from './components/UserForm';",
      "export function UserPage() {",
      "  const handleSave = () => fetch('/api/users', { method: 'POST' });",
      "  return <UserForm onSave={handleSave} />;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const uiEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:Save");
  assert.ok(uiEndpoint);
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    uiEndpoint.id,
    "react-props-app#src/page.tsx::handleSave()"
  );
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/users"));
});

test.skip("resolves renamed default React components and destructured callback props", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "react-default-props-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/components/UserForm.tsx": [
      "type Props = { onSave: () => void };",
      "export default function UserForm({ onSave }: Props) {",
      "  return <button onClick={onSave}>Save</button>;",
      "}"
    ].join("\n"),
    "src/page.tsx": [
      "import Form from './components/UserForm';",
      "export function UserPage() {",
      "  const handleSave = () => fetch('/api/users', { method: 'POST' });",
      "  return <Form onSave={handleSave} />;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const formUnitId = "react-default-props-app#src/components/UserForm.tsx";
  const handlerId = "react-default-props-app#src/page.tsx::handleSave()";
  const uiEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:Save");

  assertGraphHasUnit(result, formUnitId);
  assert.ok(uiEndpoint);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", uiEndpoint.id, handlerId);
});

test("resolves class property arrow methods and object literal methods", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-function-shapes-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api.ts": [
      "export const api = {",
      "  save(data: unknown) { return fetch('/api/object', { method: 'POST', body: JSON.stringify(data) }); }",
      "};"
    ].join("\n"),
    "src/service.ts": [
      "import { api } from './api';",
      "export class UserService {",
      "  save = (data: unknown) => api.save(data);",
      "}"
    ].join("\n"),
    "src/page.tsx": [
      "import { UserService } from './service';",
      "const service = new UserService();",
      "export function UserPage() {",
      "  const handleSave = () => service.save({});",
      "  return <button onClick={handleSave}>Save</button>;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const ids = {
    handler: "ts-function-shapes-app#src/page.tsx::handleSave()",
    serviceSave: "ts-function-shapes-app#src/service.ts::UserService.save(data: unknown)",
    apiSave: "ts-function-shapes-app#src/api.ts::api.save(data: unknown)"
  };

  assertGraphHasFunction(result, ids.serviceSave);
  assertGraphHasFunction(result, ids.apiSave);
  assertGraphHasRelationship(result, "CALLS", ids.handler, ids.serviceSave);
  assertGraphHasRelationship(result, "CALLS", ids.serviceSave, ids.apiSave);
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/object"));
});

test.skip("parses React memo and forwardRef wrapped components", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "react-wrapper-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/page.tsx": [
      "import { memo, forwardRef } from 'react';",
      "export const MemoPage = memo(function MemoPageInner() {",
      "  const handleSave = () => fetch('/api/memo', { method: 'POST' });",
      "  return <button onClick={handleSave}>Memo Save</button>;",
      "});",
      "export const InputButton = forwardRef<HTMLButtonElement, { onSave: () => void }>((props, ref) => {",
      "  return <button ref={ref} onClick={props.onSave}>Forward Save</button>;",
      "});"
    ].join("\n"),
    "src/app.tsx": [
      "import { InputButton } from './page';",
      "export function App() {",
      "  const handleSave = () => fetch('/api/forward', { method: 'POST' });",
      "  return <InputButton onSave={handleSave} />;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  assertGraphHasFunction(result, "react-wrapper-app#src/page.tsx::MemoPage()");
  assertGraphHasUnit(result, "react-wrapper-app#src/page.tsx");
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:Memo Save"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/memo"));

  const forwardEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:Forward Save");
  assert.ok(forwardEndpoint);
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    forwardEndpoint.id,
    "react-wrapper-app#src/app.tsx::handleSave()"
  );
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/forward"));
});

test("resolves namespace imports, aliased re-exports, static methods, and nested object methods", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-module-shapes-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api.ts": [
      "export function saveUser() { return fetch('/api/users', { method: 'POST' }); }",
      "export const client = {",
      "  users: {",
      "    save() { return fetch('/api/nested-users', { method: 'POST' }); }",
      "  }",
      "};",
      "export class AdminService {",
      "  static save() { return fetch('/api/admins', { method: 'POST' }); }",
      "}"
    ].join("\n"),
    "src/index.ts": "export { saveUser as save, AdminService } from './api';",
    "src/page.tsx": [
      "import * as api from './api';",
      "import { save, AdminService } from './index';",
      "export function UserPage() {",
      "  const handleSave = () => {",
      "    api.saveUser();",
      "    api.client.users.save();",
      "    save();",
      "    AdminService.save();",
      "  };",
      "  return <button onClick={handleSave}>Save</button>;",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const ids = {
    handler: "ts-module-shapes-app#src/page.tsx::handleSave()",
    saveUser: "ts-module-shapes-app#src/api.ts::saveUser()",
    nestedSave: "ts-module-shapes-app#src/api.ts::client.users.save()",
    adminSave: "ts-module-shapes-app#src/api.ts::AdminService.save()"
  };

  assertGraphHasFunction(result, ids.saveUser);
  assertGraphHasFunction(result, ids.nestedSave);
  assertGraphHasFunction(result, ids.adminSave);
  assertGraphHasRelationship(result, "CALLS", ids.handler, ids.saveUser);
  assertGraphHasRelationship(result, "CALLS", ids.handler, ids.nestedSave);
  assertGraphHasRelationship(result, "CALLS", ids.handler, ids.adminSave);
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/nested-users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/admins"));
});

test("resolves tsconfig path aliases, hook wrapped handlers, class component handlers, and optional calls", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-real-world-shapes-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: ".",
        paths: {
          "@api/*": ["src/api/*"]
        }
      },
      include: ["src/**/*"]
    }),
    "src/api/user.ts": [
      "export class UserService {",
      "  save() { return fetch('/api/alias-users', { method: 'POST' }); }",
      "}"
    ].join("\n"),
    "src/pages/UserPage.tsx": [
      "import React, { useCallback } from 'react';",
      "import { UserService } from '@api/user';",
      "const service: UserService | undefined = new UserService();",
      "export function UserPage() {",
      "  const handleSave = useCallback(() => service?.save(), []);",
      "  return <button onClick={handleSave}>Save Alias</button>;",
      "}",
      "export class LegacyPage extends React.Component {",
      "  handleLegacy() { return service!.save(); }",
      "  render() { return <button onClick={this.handleLegacy}>Save Legacy</button>; }",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const ids = {
    serviceSave: "ts-real-world-shapes-app#src/api/user.ts::UserService.save()",
    hookHandler: "ts-real-world-shapes-app#src/pages/UserPage.tsx::handleSave()",
    legacyHandler: "ts-real-world-shapes-app#src/pages/UserPage.tsx::LegacyPage.handleLegacy()"
  };

  assertGraphHasFunction(result, ids.serviceSave);
  assertGraphHasRelationship(result, "CALLS", ids.hookHandler, ids.serviceSave);
  assertGraphHasRelationship(result, "CALLS", ids.legacyHandler, ids.serviceSave);

  assert.ok(!result.graph.endpoints.some((endpoint) => endpoint.endpointType === "UI"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/alias-users"));
});

test("resolves conditional call targets and connect injected dispatch effects", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "redux-dispatch-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", moduleResolution: "bundler", baseUrl: "." },
      include: ["src/**/*"]
    }),
    "src/model.ts": [
      "export const user = {",
      "  effects: {",
      "    save(payload: unknown) { return payload; },",
      "    cancel() { return undefined; }",
      "  }",
      "};"
    ].join("\n"),
    "src/page.tsx": [
      "declare function connect(state: unknown, dispatch: unknown): (component: unknown) => unknown;",
      "type Props = { save: (value?: unknown) => unknown; cancel: () => unknown };",
      "const mapDispatch = (dispatch: any) => ({",
      "  save: (payload: unknown) => dispatch.user.save(payload),",
      "  cancel: () => dispatch.user.cancel()",
      "});",
      "export function Page({ save, cancel: onCancel }: Props) {",
      "  const flag = true;",
      "  (flag ? save : onCancel)();",
      "  (save || onCancel)();",
      "  (save ?? onCancel)();",
      "  return null;",
      "}",
      "export function PropsPage(props: Props) {",
      "  const { cancel: cancelFromProps } = props;",
      "  props.save?.();",
      "  cancelFromProps();",
      "  return null;",
      "}",
      "export function dynamic(dispatch: any, model: string, effect: string) {",
      "  return dispatch[model][effect]();",
      "}",
      "export const ConnectedPage = connect(null, mapDispatch)(Page);",
      "export const ConnectedPropsPage = connect(null, mapDispatch)(PropsPage);"
    ].join("\n")
  });

  const result = await new ReactCodeGraphParser().parse({ projectRoot: root });
  const ids = {
    page: "redux-dispatch-app#src/page.tsx::Page({ save, cancel: onCancel }: Props)",
    propsPage: "redux-dispatch-app#src/page.tsx::PropsPage(props: Props)",
    dynamic: "redux-dispatch-app#src/page.tsx::dynamic(dispatch: any,model: string,effect: string)",
    save: "redux-dispatch-app#src/model.ts::user.effects.save(payload: unknown)",
    cancel: "redux-dispatch-app#src/model.ts::user.effects.cancel()"
  };
  for (const caller of [ids.page, ids.propsPage]) {
    assertGraphHasRelationship(result, "CALLS", caller, ids.save);
    assertGraphHasRelationship(result, "CALLS", caller, ids.cancel);
  }
  assertGraphLacksRelationship(result, "CALLS", ids.dynamic, ids.save);
  assertGraphLacksRelationship(result, "CALLS", ids.dynamic, ids.cancel);

  const incremental = await new ReactCodeGraphParser().parse({
    projectRoot: root,
    sourceFiles: [path.join(root, "src/page.tsx")]
  });
  assert.ok(!incremental.graph.units.some((unit) => unit.projectFilePath === "src/model.ts"));
  assert.ok(!incremental.graph.functions.some((fn) => fn.projectFilePath === "src/model.ts"));
  for (const caller of [ids.page, ids.propsPage]) {
    assertGraphHasRelationship(incremental, "CALLS", caller, ids.save);
    assertGraphHasRelationship(incremental, "CALLS", caller, ids.cancel);
  }
  assertGraphLacksRelationship(incremental, "CALLS", ids.dynamic, ids.save);
  assertGraphLacksRelationship(incremental, "CALLS", ids.dynamic, ids.cancel);
});

test.skip("extracts Next.js app route handlers as inbound HTTP endpoints", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "next-route-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/app/api/users/[id]/route.ts": [
      "export async function GET(_request: Request, context: { params: { id: string } }) {",
      "  return Response.json({ id: context.params.id });",
      "}",
      "export async function POST(request: Request) {",
      "  return Response.json(await request.json());",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const getFn = "next-route-app#src/app/api/users/[id]/route.ts::GET(_request: Request,context: { params: { id: string } })";
  const postFn = "next-route-app#src/app/api/users/[id]/route.ts::POST(request: Request)";
  const getEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/users/{param}");
  const postEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/users/{param}");

  assertGraphHasFunction(result, getFn);
  assertGraphHasFunction(result, postFn);
  assert.ok(getEndpoint);
  assert.ok(postEndpoint);
  assert.equal(getEndpoint.direction, "inbound");
  assert.equal(postEndpoint.direction, "inbound");
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", getEndpoint.id, getFn);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", postEndpoint.id, postFn);
});

test.skip("extracts registered router handlers as inbound HTTP endpoints", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-router-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes/users.ts": [
      "function listUsers(req: unknown, res: unknown) {",
      "  return fetch('/api/internal-users');",
      "}",
      "const createUser = (req: unknown) => fetch('/api/internal-users', { method: 'POST' });",
      "router.get('/users/:id', listUsers);",
      "app.post('/users', createUser);"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const listFn = "ts-router-app#src/routes/users.ts::listUsers(req: unknown,res: unknown)";
  const createFn = "ts-router-app#src/routes/users.ts::createUser(req: unknown)";
  const getEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/users/{param}");
  const postEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:POST:/users");

  assert.ok(getEndpoint);
  assert.ok(postEndpoint);
  assert.equal(getEndpoint.direction, "inbound");
  assert.equal(postEndpoint.direction, "inbound");
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", getEndpoint.id, listFn);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", postEndpoint.id, createFn);
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/internal-users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/internal-users"));
});

test.skip("extracts route-chain, options-object, and middleware registered handlers", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-router-variants-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes.ts": [
      "const auth = (_req: unknown, _res: unknown, next: () => void) => next();",
      "function listUsers() { return fetch('/api/route-chain'); }",
      "function createUser() { return fetch('/api/fastify-create', { method: 'POST' }); }",
      "function updateUser() { return fetch('/api/middleware-update', { method: 'PATCH' }); }",
      "router.route('/users/:id').get(listUsers);",
      "fastify.post('/users', { schema: {} }, createUser);",
      "router.patch('/users/:id', auth, updateUser);"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const getEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/users/{param}");
  const postEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:POST:/users");
  const patchEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:PATCH:/users/{param}");

  assert.ok(getEndpoint);
  assert.ok(postEndpoint);
  assert.ok(patchEndpoint);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", getEndpoint.id, "ts-router-variants-app#src/routes.ts::listUsers()");
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", postEndpoint.id, "ts-router-variants-app#src/routes.ts::createUser()");
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", patchEndpoint.id, "ts-router-variants-app#src/routes.ts::updateUser()");
});

test.skip("extracts inline router handlers and parses their outbound calls", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-inline-router-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes/users.ts": [
      "router.get('/inline-users', async (req: unknown) => {",
      "  return fetch('/api/inline-users');",
      "});"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const routeEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/inline-users");
  const outboundEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/inline-users");
  const inlineHandler = result.graph.functions.find((fn) => fn.subKind === "route_inline_handler");

  assert.ok(routeEndpoint);
  assert.ok(outboundEndpoint);
  assert.ok(inlineHandler);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", routeEndpoint.id, inlineHandler.id);
  assertGraphHasRelationship(result, "FUNCTION_TO_ENDPOINT", inlineHandler.id, outboundEndpoint.id);
});

test("traces imported constants and config object properties in endpoint paths", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-trace-import-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/config.ts": [
      "export const API_PREFIX = '/api';",
      "export const endpoints = { users: '/users', admins: '/admins' };"
    ].join("\n"),
    "src/api.ts": [
      "import { API_PREFIX, endpoints } from './config';",
      "const { users } = endpoints;",
      "export function listUsers() { return fetch(`${API_PREFIX}${endpoints.users}`); }",
      "export function listAdmins() { return fetch(API_PREFIX + endpoints.admins); }",
      "export function listDestructuredUsers() { return fetch(API_PREFIX + users); }"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/admins"));
  assert.ok(
    result.graph.relationships.some((rel) =>
      rel.relationshipType === "FUNCTION_TO_ENDPOINT" &&
      rel.fromNodeId === "ts-trace-import-app#src/api.ts::listDestructuredUsers()" &&
      result.graph.endpoints.some((endpoint) => endpoint.id === rel.toNodeId && endpoint.matchIdentity === "HTTP:GET:/api/users")
    )
  );
});

test.skip("extracts decorator declared controller methods as inbound HTTP endpoints", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-decorator-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        experimentalDecorators: true,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/users.controller.ts": [
      "function Controller(_path: string) { return () => undefined; }",
      "function Get(_path?: string) { return () => undefined; }",
      "function Post(_path?: string) { return () => undefined; }",
      "@Controller('/users')",
      "export class UsersController {",
      "  @Get(':id')",
      "  findOne() { return 'one'; }",
      "  @Post()",
      "  create() { return 'created'; }",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const findOne = "ts-decorator-app#src/users.controller.ts::UsersController.findOne()";
  const create = "ts-decorator-app#src/users.controller.ts::UsersController.create()";
  const getEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/users/{param}");
  const postEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:POST:/users");

  assert.ok(getEndpoint);
  assert.ok(postEndpoint);
  assert.equal(getEndpoint.direction, "inbound");
  assert.equal(postEndpoint.direction, "inbound");
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", getEndpoint.id, findOne);
  assertGraphHasRelationship(result, "ENDPOINT_TO_FUNCTION", postEndpoint.id, create);
});

test.skip("applies router mount prefixes and traced decorator path constants", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-prefixed-routes-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        experimentalDecorators: true,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/routes.ts": [
      "const API = '/api';",
      "const USERS = 'users';",
      "function handler() { return fetch('/api/internal'); }",
      "const usersRouter = Router({ prefix: '/v1' });",
      "app.use(API, usersRouter);",
      "usersRouter.get(`/${USERS}/:id`, handler);"
    ].join("\n"),
    "src/users.controller.ts": [
      "const BASE = '/admin';",
      "const RESOURCE = 'users';",
      "function Controller(_path: string) { return () => undefined; }",
      "function Get(_path?: string) { return () => undefined; }",
      "@Controller(BASE)",
      "export class UsersController {",
      "  @Get(`/${RESOURCE}/:id`)",
      "  findOne() { return 'one'; }",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const routerEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/v1/users/{param}");
  const decoratorEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:GET:/admin/users/{param}");
  assert.ok(routerEndpoint);
  assert.ok(decoratorEndpoint);
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    routerEndpoint.id,
    "ts-prefixed-routes-app#src/routes.ts::handler()"
  );
  assertGraphHasRelationship(
    result,
    "ENDPOINT_TO_FUNCTION",
    decoratorEndpoint.id,
    "ts-prefixed-routes-app#src/users.controller.ts::UsersController.findOne()"
  );
});

test("resolves dynamic import module calls", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-dynamic-import-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/api.ts": [
      "export function saveUser() { return fetch('/api/dynamic-users', { method: 'POST' }); }",
      "export const adminApi = {",
      "  save() { return fetch('/api/dynamic-admins', { method: 'POST' }); }",
      "};"
    ].join("\n"),
    "src/page.tsx": [
      "export async function saveWithAwaitImport() {",
      "  const api = await import('./api');",
      "  return api.saveUser();",
      "}",
      "export function saveWithThenImport() {",
      "  return import('./api').then((api) => api.adminApi.save());",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const awaitImportFn = "ts-dynamic-import-app#src/page.tsx::saveWithAwaitImport()";
  const thenImportFn = "ts-dynamic-import-app#src/page.tsx::saveWithThenImport()";
  const saveUserFn = "ts-dynamic-import-app#src/api.ts::saveUser()";
  const saveAdminFn = "ts-dynamic-import-app#src/api.ts::adminApi.save()";

  assertGraphHasRelationship(result, "CALLS", awaitImportFn, saveUserFn);
  assertGraphHasRelationship(result, "CALLS", thenImportFn, saveAdminFn);
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/dynamic-users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/dynamic-admins"));
});

test.skip("extracts anonymous default exports and Next.js pages api handlers", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-default-export-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/pages/api/users/[id].ts": [
      "export default async function(req: unknown, res: unknown) {",
      "  return fetch('/api/downstream-users');",
      "}"
    ].join("\n"),
    "src/components/SaveButton.tsx": [
      "export default () => {",
      "  const handleClick = () => fetch('/api/default-component', { method: 'POST' });",
      "  return <button onClick={handleClick}>Default Save</button>;",
      "};"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const pagesApiEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "HTTP:ANY:/api/users/{param}");
  const defaultUiEndpoint = result.graph.endpoints.find((endpoint) => endpoint.matchIdentity === "UI:CLICK:button:Default Save");
  assert.ok(pagesApiEndpoint);
  assert.ok(defaultUiEndpoint);
  assert.equal(pagesApiEndpoint.direction, "inbound");
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:GET:/api/downstream-users"));
  assert.ok(result.graph.endpoints.some((endpoint) => endpoint.matchIdentity === "HTTP:POST:/api/default-component"));
});

test("does not attribute nested function endpoints to the outer function", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "ts-nested-scope-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/page.ts": [
      "export function outer() {",
      "  const inner = () => fetch('/api/inner');",
      "  return inner();",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,

    staticExtractPresetRules: true

  });

  const endpoint = result.graph.endpoints.find((item) => item.matchIdentity === "HTTP:GET:/api/inner");
  const outer = "ts-nested-scope-app#src/page.ts::outer()";
  const inner = "ts-nested-scope-app#src/page.ts::inner()";

  assert.ok(endpoint);
  assertGraphHasRelationship(result, "CALLS", outer, inner);
  assertGraphHasRelationship(result, "FUNCTION_TO_ENDPOINT", inner, endpoint.id);
  assertGraphLacksRelationship(result, "FUNCTION_TO_ENDPOINT", outer, endpoint.id);
});

test("emits RENDERS for direct JSX components and React.lazy dynamic imports", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "renders-lazy-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        jsx: "react-jsx",
        moduleResolution: "bundler",
        baseUrl: "."
      },
      include: ["src/**/*"]
    }),
    "src/Child.jsx": "export default function Child() { return <div>child</div>; }\n",
    "src/LazyChild.jsx": "export default function LazyChild() { return <span>lazy</span>; }\n",
    "src/Parent.jsx": [
      "import { lazy, Suspense } from 'react';",
      "import Child from './Child.jsx';",
      "const LazyChild = lazy(() => import('./LazyChild.jsx'));",
      "export default function Parent() {",
      "  return (",
      "    <Suspense fallback={null}>",
      "      <Child />",
      "      <LazyChild />",
      "    </Suspense>",
      "  );",
      "}"
    ].join("\n")
  });

  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    projectName: "renders-lazy-app",

    staticExtractPresetRules: true

  });

  const parent = "renders-lazy-app#src/Parent.jsx::Parent()";
  const child = "renders-lazy-app#src/Child.jsx::Child()";
  const lazyChild = "renders-lazy-app#src/LazyChild.jsx::LazyChild()";

  assertGraphHasFunction(result, parent);
  assertGraphHasFunction(result, child);
  assertGraphHasFunction(result, lazyChild);
  assert.equal(result.graph.functions.find((fn) => fn.id === child)?.isPlaceholder, false);
  assert.equal(result.graph.functions.find((fn) => fn.id === lazyChild)?.isPlaceholder, false);
  assertGraphHasRelationship(result, "RENDERS", parent, child);
  assertGraphHasRelationship(result, "RENDERS", parent, lazyChild);
});

function createFixtureProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-code-graph-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return root;
}

function assertGraphHasUnit(result: Awaited<ReturnType<ReactCodeGraphParser["parse"]>>, id: string): void {
  assert.ok(result.graph.units.some((unit) => unit.id === id), `Expected unit ${id}`);
}

function assertGraphHasFunction(result: Awaited<ReturnType<ReactCodeGraphParser["parse"]>>, id: string): void {
  assert.ok(result.graph.functions.some((fn) => fn.id === id), `Expected function ${id}`);
}

test("path dict overrides any direction; MISS keeps SER path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-code-graph-dict-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dict-app" }), "utf8");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", moduleResolution: "bundler", baseUrl: "." },
      include: ["src/**/*"]
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src/client.ts"),
    [
      "function buildUsersUrl() { return '/should-not-appear'; }",
      "export function listUsers() { return fetch(buildUsersUrl()); }",
      "export function listFixed() { return fetch('/api/fixed'); }"
    ].join("\n"),
    "utf8"
  );

  // identity key: module.path.symbol() — no project prefix, flat string value
  const key = "src.client.listUsers()";
  const parser = new ReactCodeGraphParser();
  const result = await parser.parse({
    projectRoot: root,
    projectName: "dict-app",
    staticExtractPresetRules: ["http-client"],
    externalValues: {
      [key]: "v1/users-from-dict"
    }
  });

  const fromDict = result.graph.endpoints.find((e) => e.path === "v1/users-from-dict");
  assert.ok(fromDict, "dict HIT should set path");
  assert.equal(fromDict?.parseLevel, "config");
  assert.equal(fromDict?.direction, "outbound");
  assert.equal(fromDict?.normalizedPath, "v1/users-from-dict");
  assert.equal(fromDict?.matchIdentity, "HTTP:GET:v1/users-from-dict");
  assert.ok(!result.graph.endpoints.some((e) => (e.path ?? "").includes("buildUsersUrl")));

  const fixed = result.graph.endpoints.find((e) => e.path === "/api/fixed");
  assert.ok(fixed, "MISS keeps SER literal path");
});

test("HTTP identity uses the exact SER path when no normalizer is declared", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "exact-ser-path-app" }),
    "src/routes.js": [
      "export function loadUser() { return null; }",
      "router.get('/users/:userId?view=full', loadUser);"
    ].join("\n")
  });
  const rule = [
    "rule \"Exact route path\"",
    "fact http_route",
    "find call get",
    "when call owner router",
    "let path =",
    "  from argument[0] take value",
    "let handler =",
    "  from handler take reference",
    "build {",
    "  method: \"GET\"",
    "  direction: \"inbound\"",
    "  path: path",
    "  handler: handler",
    "}"
  ].join("\n");

  const result = await new ReactCodeGraphParser().parse({ projectRoot: root, ruleTexts: [rule] });
  assert.equal(result.graph.endpoints.length, 1);
  assert.equal(result.graph.endpoints[0]?.path, "/users/:userId?view=full");
  assert.equal(result.graph.endpoints[0]?.normalizedPath, "/users/:userId?view=full");
  assert.equal(result.graph.endpoints[0]?.matchIdentity, "HTTP:GET:/users/:userId?view=full");
});

test("inbound path dict HIT overrides SER route path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-code-graph-inbound-dict-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "inbound-dict-app" }), "utf8");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", moduleResolution: "bundler", baseUrl: "." },
      include: ["src/**/*"]
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src/routes.ts"),
    [
      "export function listUsers() { return null; }",
      "router.get('/legacy-users', listUsers);"
    ].join("\n"),
    "utf8"
  );

  const parser = new ReactCodeGraphParser();
  // module.path.symbol() — no project prefix
  const result = await parser.parse({
    projectRoot: root,
    projectName: "inbound-dict-app",
    staticExtractPresetRules: ["router"],
    externalValues: {
      "src.routes.listUsers()": "/v1/users-inbound-dict"
    }
  });

  const hit = result.graph.endpoints.find((e) => e.path === "/v1/users-inbound-dict");
  assert.ok(
    hit && hit.parseLevel === "config" && hit.direction === "inbound",
    `inbound dict HIT expected, endpoints=${JSON.stringify(result.graph.endpoints.map((e) => ({ path: e.path, parseLevel: e.parseLevel, dir: e.direction, pathKey: e.attributes?.pathKey })))}`
  );
});

test("method-anchor dict creates inbound endpoints for object functions and preserves other", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "object-handler-app" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true, moduleResolution: "bundler" },
      include: ["src/**/*"]
    }),
    "src/handlers.ts": [
      "export const handlers = {",
      "  getDocMarkdown: async function() { return ''; },",
      "  save: async () => null",
      "};"
    ].join("\n")
  });
  const rule = [
    "rule \"Configured object handler\"",
    "fact http_route",
    "find method getDocMarkdown",
    "let path =",
    "  from method take value",
    "let handler =",
    "  from method take name",
    "build {",
    "  endpointType: \"HTTP\"",
    "  direction: \"inbound\"",
    "  method: \"GET\"",
    "  path: path",
    "  handler: handler",
    "  other: \"source=manual\"",
    "}",
    "dict {",
    "  src.handlers.handlers.getDocMarkdown() = /docs/{docId}",
    "  src.handlers.handlers.getDocMarkdown().1 = /admin/docs/{adminId}",
    "}"
  ].join("\n");

  const result = await new ReactCodeGraphParser().parse({
    projectRoot: root,
    ruleTexts: [rule]
  });
  const handlerId = "object-handler-app#src/handlers.ts::handlers.getDocMarkdown()";
  assertGraphHasFunction(result, handlerId);
  assert.deepEqual(result.graph.endpoints.map((endpoint) => endpoint.path), ["/docs/{docId}", "/admin/docs/{adminId}"]);
  assert.deepEqual(
    result.graph.endpoints.map((endpoint) => endpoint.matchIdentity),
    ["HTTP:GET:/docs/{docId}", "HTTP:GET:/admin/docs/{adminId}"]
  );
  assert.ok(result.graph.endpoints.every((endpoint) => endpoint.other === "source=manual"));
  assert.ok(result.graph.endpoints.every((endpoint) => endpoint.parseLevel === "config"));
  assert.ok(result.graph.endpoints.every((endpoint) =>
    result.graph.relationships.some((relationship) =>
      relationship.relationshipType === "ENDPOINT_TO_FUNCTION" &&
      relationship.fromNodeId === endpoint.id &&
      relationship.toNodeId === handlerId
    )
  ));

  const delta = toGraphDelta({
    graph: result.graph,
    request: { projectRoot: root },
    projectName: "object-handler-app",
    projectRoot: root
  });
  assert.ok(delta.endpoints.every((endpoint) => endpoint.other === "source=manual"));
});

test("dictionary or trace without endpoint SER does not block the base graph", async () => {
  const root = createFixtureProject({
    "package.json": JSON.stringify({ name: "no-ser-app" }),
    "src/service.js": "export function run() { return 1; }\n"
  });
  const result = await new ReactCodeGraphParser().parse({
    projectRoot: root,
    externalValues: { "src.service.run()": "/unused" },
    traceRuleTexts: ["from call helper\n  to parameter[0]"],
    staticExtractPresetRules: []
  });
  assertGraphHasFunction(result, "no-ser-app#src/service.js::run()");
  assert.equal(result.graph.endpoints.length, 0);
});

function assertGraphHasRelationship(
  result: Awaited<ReturnType<ReactCodeGraphParser["parse"]>>,
  relationshipType: string,
  fromNodeId: string,
  toNodeId: string
): void {
  assert.ok(
    result.graph.relationships.some((rel) =>
      rel.relationshipType === relationshipType &&
      rel.fromNodeId === fromNodeId &&
      rel.toNodeId === toNodeId
    ),
    `Expected relationship ${fromNodeId} -[${relationshipType}]-> ${toNodeId}`
  );
}

function assertGraphLacksRelationship(
  result: Awaited<ReturnType<ReactCodeGraphParser["parse"]>>,
  relationshipType: string,
  fromNodeId: string,
  toNodeId: string
): void {
  assert.ok(
    !result.graph.relationships.some((rel) =>
      rel.relationshipType === relationshipType &&
      rel.fromNodeId === fromNodeId &&
      rel.toNodeId === toNodeId
    ),
    `Unexpected relationship ${fromNodeId} -[${relationshipType}]-> ${toNodeId}`
  );
}

function unionById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function canonicalGraph(graph: CodeGraph): CodeGraph {
  const sort = <T extends { id: string }>(items: T[]): T[] =>
    items.map((item) => JSON.parse(JSON.stringify(item)) as T).sort((left, right) => left.id.localeCompare(right.id));
  return {
    packages: sort(graph.packages),
    units: sort(graph.units),
    functions: sort(graph.functions),
    relationships: sort(graph.relationships),
    endpoints: sort(graph.endpoints)
  };
}
