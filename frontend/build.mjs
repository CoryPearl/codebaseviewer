import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = dirname(fileURLToPath(import.meta.url));
const outputDir = join(frontendDir, 'dist');
const staticFiles = ['index.html', 'styles.css', 'app.js', 'renderer.js', 'favicon.svg'];
let backendUrl = (process.env.BACKEND_URL || 'http://127.0.0.1:4177').trim().replace(/\/+$/, '');

if (process.env.VERCEL && !process.env.BACKEND_URL) {
  throw new Error('BACKEND_URL must be set in the Vercel project environment variables.');
}

let parsed;
try {
  parsed = new URL(backendUrl);
} catch {
  throw new Error('BACKEND_URL must be a complete http:// or https:// URL.');
}
if (!['http:', 'https:'].includes(parsed.protocol)) {
  throw new Error('BACKEND_URL must use http:// or https://.');
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await Promise.all(staticFiles.map(file => copyFile(join(frontendDir, file), join(outputDir, file))));
await writeFile(
  join(outputDir, 'config.js'),
  `window.CODEBASEVIEWER_CONFIG = { backendUrl: ${JSON.stringify(backendUrl)} };\n`,
  'utf8',
);

console.log('Built frontend');
