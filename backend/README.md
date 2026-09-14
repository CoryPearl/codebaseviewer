# Codebase Viewer backend

Standalone framework-free Rust HTTP/SSE API and source indexer.

```bash
cargo run --release
```

Configuration:

- `PORT`: listening port, default `4177`
- `CORS_ORIGIN`: allowed frontend origin, default `*`

Health check: `GET /api/health`
