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

The machine needs Git and a current Rust toolchain. Git is also required at runtime when users load public GitHub repositories.

Clone the public repository and build the optimized backend:

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/codebaseviewer
git clone https://github.com/CoryPearl/codebaseviewer.git /opt/codebaseviewer
cd /opt/codebaseviewer/backend
cargo build --release --locked
```

Run it on port 3001:

```bash
PORT=3001 ./target/release/codebaseviewer
```

Verify the server from another terminal:

```bash
curl http://127.0.0.1:3001/api/health
```

The response should be `{"ok":true,"version":"0.1.0"}`.

The backend listens on `0.0.0.0`, so expose port 3001 through your firewall or put an HTTPS reverse proxy in front of it. To restrict browser access to your production frontend, set `CORS_ORIGIN` to its exact origin:

```bash
CORS_ORIGIN=https://your-project.vercel.app PORT=3001 ./target/release/codebaseviewer
```

Keep the default `*` while using changing Vercel Preview URLs, or configure the exact production frontend origin when you only need Production. Set Vercel's `BACKEND_URL` to the backend's public HTTPS origin and redeploy the frontend.

For a quick background process during testing:

```bash
nohup env PORT=3001 ./target/release/codebaseviewer > backend.log 2>&1 &
```

Use a process supervisor such as systemd for a permanent installation.

### Install as an Ubuntu systemd service

The included unit expects the repository at `/opt/codebaseviewer`, runs the API as a dedicated unprivileged user, and reads configuration from `/etc/codebaseviewer.env`.

Create the service account and install the configuration and unit:

```bash
id -u codebaseviewer >/dev/null 2>&1 || sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin codebaseviewer
sudo install -m 600 /opt/codebaseviewer/backend/.env.example /etc/codebaseviewer.env
sudo install -m 644 /opt/codebaseviewer/backend/codebaseviewer.service /etc/systemd/system/codebaseviewer.service
sudoedit /etc/codebaseviewer.env
```

Set `CORS_ORIGIN` in that environment file to your Vercel production URL. Then enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codebaseviewer
sudo systemctl status codebaseviewer --no-pager
```

Check the API and follow its logs:

```bash
curl http://127.0.0.1:3001/api/health
sudo journalctl -u codebaseviewer -f
```

### Run ngrok with systemd

Install ngrok on the Ubuntu backend machine using the official package, then confirm where it was installed:

```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update
sudo apt install ngrok
command -v ngrok
```

The included unit expects `/usr/bin/ngrok`. If `command -v ngrok` prints another path, edit `ExecStart` in `backend/codebaseviewer-ngrok.service` before installing it.

Copy the ngrok configuration and service unit:

```bash
sudo install -o root -g codebaseviewer -m 640 /opt/codebaseviewer/backend/ngrok.yml.example /etc/codebaseviewer-ngrok.yml
sudo install -m 644 /opt/codebaseviewer/backend/codebaseviewer-ngrok.service /etc/systemd/system/codebaseviewer-ngrok.service
sudoedit /etc/codebaseviewer-ngrok.yml
```

Replace the example authtoken and URL in `/etc/codebaseviewer-ngrok.yml`. Keep the upstream set to `http://127.0.0.1:3001`; TLS is provided by ngrok. The root-owned configuration keeps the token and public endpoint out of the repository and normal process command lines.

Stop any interactive ngrok process using the same endpoint before starting the service, then enable both services:

```bash
pkill -u "$USER" -x ngrok || true
sudo systemctl daemon-reload
sudo systemctl enable --now codebaseviewer
sudo systemctl enable --now codebaseviewer-ngrok
sudo systemctl status codebaseviewer codebaseviewer-ngrok --no-pager
```

Verify both the private backend and the public tunnel:

```bash
curl http://127.0.0.1:3001/api/health
curl https://your-assigned-domain.ngrok-free.dev/api/health
```

The ngrok service requires and starts after the backend service. Both restart automatically and start again after reboot. To inspect errors without continuously exposing routine endpoint details, the example ngrok configuration logs only errors:

```bash
sudo journalctl -u codebaseviewer -n 50 --no-pager
sudo journalctl -u codebaseviewer-ngrok -n 50 --no-pager
```

After pulling and rebuilding an update, restart the service:

```bash
cd /opt/codebaseviewer
git pull --ff-only
cd backend
cargo build --release --locked
sudo systemctl restart codebaseviewer
```

Useful management commands:

```bash
sudo systemctl stop codebaseviewer
sudo systemctl start codebaseviewer
sudo systemctl disable --now codebaseviewer
sudo systemctl restart codebaseviewer-ngrok
sudo systemctl disable --now codebaseviewer-ngrok
```

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
