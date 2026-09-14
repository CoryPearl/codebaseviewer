# Codebase Viewer backend

Standalone framework-free Rust HTTP/SSE API and source indexer.

```bash
cargo run --release
```

Configuration:

- `PORT`: listening port, default `4177`; the included systemd example uses `3001`
- `CORS_ORIGIN`: allowed frontend origin, default `*`

Health check: `GET /api/health`

See the root README for Ubuntu installation instructions using the included `codebaseviewer.service` unit.
