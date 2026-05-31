# Full Demo

This fixture exercises SER-only extraction with built-in presets.

Run from the repository root:

```bash
npm run build
node dist/cli.js \
  --project examples/full-demo \
  --static-extract-preset all \
  --no-legacy-endpoint-inference \
  --delta \
  --out /tmp/code-graph-full-demo-delta.json
```

Expected endpoint kinds include `http`, `ui`, `mq`, `redis`, and `db`.
