// scripts/ig-autodm/tunnel.mjs
// Spawns a Cloudflare quick tunnel and extracts the public URL.

import { spawn } from 'node:child_process';

export function startTunnel({ port, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const urlRe = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    function onChunk(buf) {
      const s = buf.toString();
      process.stderr.write(s); // surface tunnel logs
      if (resolved) return;
      const m = s.match(urlRe);
      if (m) {
        resolved = true;
        resolve({ url: m[0], proc });
      }
    }
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('exit', (code) => {
      if (!resolved) reject(new Error(`cloudflared exited (${code}) before printing URL`));
    });

    setTimeout(() => {
      if (!resolved) {
        proc.kill('SIGTERM');
        reject(new Error(`cloudflared did not produce a URL within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}
