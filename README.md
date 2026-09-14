# Codebase Viewer

A framework-free browser codebase explorer inspired by Rik Arends' large-codebase landscape demo. The repository is split into a vanilla JavaScript/WebGL2 frontend and a standalone Rust API backend.

## Repository layout

- `frontend/`: static HTML, CSS, JavaScript, WebGL renderer, favicon, and Vercel build script
- `backend/`: standalone Rust HTTP/SSE API and repository indexer
- `vercel.json`: builds the frontend and injects the backend URL

## Run locally

Start the backend:

```bash
cd backend
cargo run --release
```

In another terminal, serve the frontend:

```bash
python3 -m http.server 4178 --directory frontend
```

Open `http://127.0.0.1:4178`. The committed development config points the frontend to `http://127.0.0.1:4177`.

The backend listens on `0.0.0.0`, reads `PORT` when provided, and accepts `--port 8080` as an explicit override.

## Deploy the frontend on Vercel

1. Import this GitHub repository into Vercel and leave the project root at the repository root.
2. Set the framework preset to **Other**.
3. Add `BACKEND_URL` under **Project Settings → Environment Variables**. Use the public HTTPS origin of your backend, with no trailing slash—for example, `https://api.example.com`.
4. Enable the variable for Production and Preview as needed, then deploy.

The root `vercel.json` runs `node frontend/build.mjs` and publishes `frontend/dist`. The build generates `config.js`, so changing `BACKEND_URL` requires a new deployment. This URL is public browser configuration, not a secret.

Because Vercel pages use HTTPS, the public backend should also use HTTPS. A plain `http://` backend will be blocked by browsers as mixed content.

## Run the backend on another machine

Copy or clone the repository, then run only the backend project:

```bash
cd backend
PORT=4177 cargo run --release
```

Expose that port through your firewall or reverse proxy and terminate HTTPS in front of it. The backend permits cross-origin API requests by default. To restrict it to your deployed frontend, set `CORS_ORIGIN` to the exact frontend origin:

```bash
CORS_ORIGIN=https://your-project.vercel.app PORT=4177 cargo run --release
```

Keep the default `*` while using changing Vercel Preview URLs, or configure the exact production frontend origin when you only need Production.

The backend stores uploaded folders, cloned repositories, indexes, and snapshots in temporary memory and disk. They disappear when the process restarts. Do not expose it publicly without considering who may upload code and consume machine resources.

## Controls

- Mouse wheel: cursor-anchored zoom in 2D, camera distance in 3D
- Drag: pan in 2D, orbit in 3D
- Shift-drag, right-drag, or middle-drag: pan in 3D
- Arrow keys: orbit in 3D
- WASD: pan in 3D
- `F`: reset the camera
- Click: inspect a file
- Double-click: focus a file
- Click a colored coverage section: browse every file in that category
- Click or use Up/Down in a coverage list: move smoothly to a file without selecting it
- `/`: focus search
- `Cmd/Ctrl+O`: open another codebase

Supported dependency-aware language families are JavaScript/TypeScript, Python, Rust, Go, C/C++, Java, and C#. Other readable files still appear with generic metadata.
