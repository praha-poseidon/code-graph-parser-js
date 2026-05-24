# Code Graph Parser JS

Static parser for React projects that emits the same high-level graph shape used by the Java code graph engine:

- `CodePackage`
- `CodeUnit`
- `CodeFunction`
- `CodeEndpoint`
- `CodeRelationship`

The first implementation targets React projects written in JS, JSX, TS, or TSX. It uses `ts-morph` and the TypeScript compiler for project semantics, with a configurable endpoint rule engine for outbound HTTP calls.

## Usage

```bash
npm install
npm run build
node dist/cli.js --project /path/to/react-app --out graph.json
```

Optional endpoint rules:

```bash
node dist/cli.js --project /path/to/react-app --rules ./endpoint-rules --out graph.json
```

Emit the Java engine `GraphDelta` protocol directly:

直接输出 Java engine 使用的 `GraphDelta` 协议：

```bash
node dist/cli.js --project /path/to/react-app --delta --out delta.json
```

Run as a `code-graph-parser-process` adapter:

作为 `code-graph-parser-process` 外部解析器运行：

```bash
node dist/cli.js --stdio
```

Then configure the Java engine or app with:

然后在 Java engine 或 app 侧配置：

```bash
-Dcodegraph.parser.process.languages=typescript
-Dcodegraph.parser.process.typescript.command="node '/path/to/code-graph-parser-js/dist/cli.js' --stdio"
```

When the Java app receives a `.ts` or `.tsx` file change, it infers `typescript`, sends a `ParseRequest` to this CLI, receives `GraphDelta`, and writes the graph through the configured storage adapter.

当 Java app 收到 `.ts` 或 `.tsx` 文件变更时，会推断语言为 `typescript`，把 `ParseRequest` 发给这个 CLI，拿到 `GraphDelta` 后通过已配置的存储适配器写入图谱。

## Endpoint Rules

Endpoint rules let users describe where frontend API paths are located without changing parser code.

```yaml
id: axios-shortcut
endpointType: HTTP
direction: outbound
locate:
  nodeType: CallExpression
  callee:
    regex: "^(axios|api|request|http)\\.(get|post|put|delete|patch)$"
extract:
  method:
    from: callee.property
    transforms: [upperCase]
  path:
    from: arguments[0]
    trace: true
normalize:
  matchIdentity: "HTTP:{method}:{normalizedPath}"
```

The default rules cover `fetch`, `axios.get(...)`, `axios({ url, method })`, and common `request.get(...)` wrappers.
