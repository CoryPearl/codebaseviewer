# Codebase Viewer frontend

Static, framework-free HTML/CSS/JavaScript frontend.

For local development, start the backend on port 4177 and run:

```bash
python3 -m http.server 4178 --directory frontend
```

For Vercel, set `BACKEND_URL` and deploy from the repository root. The root `vercel.json` builds this directory into `frontend/dist`.
