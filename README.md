# Codebase Viewer

A framework-free browser codebase explorer inspired by Rik Arends' large-codebase landscape demo. It combines a small Rust indexing server with a vanilla JavaScript/WebGL2 frontend.

## Run

```bash
cargo run --release -- --open
```

Or open `http://127.0.0.1:4177` yourself. The server listens on `0.0.0.0`, reads the `PORT` environment variable when provided, and accepts `--port 8080` as an explicit override.

The app opens with an empty workspace. Use the folder button to index a local directory, or paste the URL of a public GitHub repository.

## Controls

- Mouse wheel: cursor-anchored zoom in 2D, camera distance in 3D
- Drag: pan in 2D, orbit in 3D
- Shift-drag, right-drag, or middle-drag: pan in 3D
- Arrow keys: orbit in 3D
- WASD: pan in 3D
- `F`: reset the camera
- Click: inspect a file
- Double-click: focus a file
- `/`: focus search
- `Cmd/Ctrl+O`: open another codebase

## Deploy on Render

This repository includes a Render Blueprint. Push it to GitHub, then in the Render dashboard choose **New → Blueprint** and connect this repository. Render will build the optimized Rust binary, start it as a free web service, and monitor `/api/health`.

The server already binds to `0.0.0.0` and reads Render's `PORT` environment variable. Uploaded folders, cloned repositories, indexes, and snapshots use temporary memory and disk. They disappear whenever the free service sleeps, restarts, or redeploys. Do not upload private source code to a public instance you do not control.

The free Render instance has limited CPU and memory. It is appropriate for demos and moderate repositories; the five-million-line target may require a larger instance depending on file count and source complexity.

## Architecture

- `src/`: framework-free HTTP/SSE server and repository indexer
- `static/renderer.js`: instanced WebGL2 2D/3D renderer
- `static/app.js`: treemap, interaction, upload, search, and inspector UI
- Temporary folder uploads and GitHub clones are written under the server operating system's temporary directory and are not persisted by the project.

Supported dependency-aware language families are JavaScript/TypeScript, Python, Rust, Go, C/C++, Java, and C#. Other readable files still appear with generic metadata.
