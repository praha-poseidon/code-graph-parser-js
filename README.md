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
parser-js --project /path/to/react-app --out graph.json
```

Optional endpoint rules:

```bash
parser-js --project /path/to/react-app --rules ./endpoint-rules --out graph.json
```

Endpoint SER is optional. With no SER rules or enabled presets, the parser still
emits the base package, source-unit, function, and code-relationship graph; the
endpoint list is simply empty. Supplying only an identity dictionary, an empty
preset list, or standalone trace helpers does not make endpoint configuration
mandatory and does not fail base graph parsing.

Emit the Java engine `GraphDelta` protocol directly:

直接输出 Java engine 使用的 `GraphDelta` 协议：

```bash
parser-js --project /path/to/react-app --delta --out delta.json
```

Run as a `code-graph-parser-process` adapter:

作为 `code-graph-parser-process` 外部解析器运行：

```bash
parser-js --stdio
```

Then configure the Java engine or app with:

然后在 Java engine 或 app 侧配置：

```bash
-Dcodegraph.parser.process.languages=typescript
-Dcodegraph.parser.process.typescript.command="/path/to/parser-js --stdio"
```

When the Java app receives a `.ts` or `.tsx` file change, it infers `typescript`, sends a `ParseRequest` to this CLI, receives `GraphDelta`, and writes the graph through the configured storage adapter.

当 Java app 收到 `.ts` 或 `.tsx` 文件变更时，会推断语言为 `typescript`，把 `ParseRequest` 发给这个 CLI，拿到 `GraphDelta` 后通过已配置的存储适配器写入图谱。

## Incremental LOAD vs SCAN

When `ParseRequest.sourceFiles` is non-empty, those paths are the incremental
SCAN set. The parser discovers `tsconfig.json` / `jsconfig.json`, builds their
static import closure as LOAD, and puts both sets into one `ts-morph` Project:

```text
LOAD = import closure(sourceFiles)  # resolution only
SCAN = sourceFiles                  # graph/fact emission
```

The graph parser and `static-extract-js` share that same Project. Dependency
files can resolve symbols and values but do not emit units or endpoints for the
current delta. With no `sourceFiles`, the existing `include` scan remains the
SCAN set. `moduleClosure: false` / `--no-module-closure` is a debugging escape
hatch that makes LOAD equal SCAN.

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

Endpoint facts may also build an opaque `other` string:

```ser
build {
  endpointType: "HTTP"
  direction: "inbound"
  method: "GET"
  path: path
  handler: handler
  other: "source=manual"
}
```

`other` is copied unchanged to `CodeEndpoint` and the emitted `GraphDelta`
endpoint. It is nullable, has no language-specific interpretation, and does not
participate in endpoint IDs or `matchIdentity`.
