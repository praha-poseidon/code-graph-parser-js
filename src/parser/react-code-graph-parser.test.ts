import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReactCodeGraphParser } from "./react-code-graph-parser.js";
import { toGraphDelta } from "../model/process-protocol.js";

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
    endpointRulesDir: path.resolve("endpoint-rules")
  });

  assert.ok(result.graph.units.some((unit) => unit.id === "fixture-app#src/pages/UserPage.jsx::UserPage"));
  assert.ok(
    result.graph.relationships.some((rel) =>
      rel.relationshipType === "RENDERS" &&
      rel.fromNodeId === "fixture-app#src/pages/UserPage.jsx::UserPage" &&
      rel.toNodeId === "fixture-app#src/components/UserCard.jsx::UserCard"
    )
  );
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
      "export function createUser(data: unknown) { return axios({ url: '/api/users', method: 'post', data }); }",
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
    endpointRulesDir: path.resolve("endpoint-rules")
  });

  const ids = {
    page: "mixed-react-app#src/pages/UserPage.tsx::UserPage",
    list: "mixed-react-app#src/components/UserList.jsx::UserList",
    useUsers: "mixed-react-app#src/hooks/useUsers.ts::useUsers()",
    listUsers: "mixed-react-app#src/api/http.ts::listUsers()",
    createUser: "mixed-react-app#src/api/http.ts::createUser(data: unknown)"
  };

  assertGraphHasUnit(result, ids.page);
  assertGraphHasUnit(result, ids.list);
  assertGraphHasFunction(result, ids.useUsers);
  assertGraphHasFunction(result, ids.listUsers);
  assertGraphHasFunction(result, ids.createUser);
  assertGraphHasFunction(result, "mixed-react-app#src/api/http.ts::Articles.delete(slug: string)");

  assertGraphHasRelationship(result, "RENDERS", ids.page, ids.list);
  assertGraphHasRelationship(result, "USES_HOOK", "mixed-react-app#src/pages/UserPage.tsx::UserPage()", ids.useUsers);
  assertGraphHasRelationship(result, "CALLS", ids.useUsers, ids.listUsers);

  assert.ok(
    result.graph.endpoints.some((endpoint) =>
      endpoint.matchIdentity === "HTTP:GET:/api/users" &&
      endpoint.attributes?.ruleId === "browser-fetch"
    )
  );
  assert.ok(
    result.graph.endpoints.some((endpoint) =>
      endpoint.matchIdentity === "HTTP:POST:/api/users" &&
      endpoint.attributes?.ruleId === "axios-config-object"
    )
  );
  assert.ok(
    result.graph.endpoints.some((endpoint) =>
      endpoint.matchIdentity === "HTTP:DELETE:/api/articles/{param}" &&
      endpoint.attributes?.ruleId === "axios-method-shortcut"
    )
  );
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
    endpointRulesDir: path.resolve("endpoint-rules"),
    gitRepoUrl: "https://example.com/protocol-react-app.git",
    gitBranch: "main"
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
      "  path: path",
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
  assertGraphHasRelationship(
    result,
    "FUNCTION_TO_ENDPOINT",
    "static-extract-react-app#src/api/user.ts::loadUsers()",
    endpoint.id
  );
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
