import { defineConfig, type Plugin } from 'vite';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only sink for in-page benchmarks: POST /__bench with a text line, or
// {"png": "<dataURL>"} to drop a screenshot of the real GPU output.
function benchSink(): Plugin {
  return {
    name: 'bench-sink',
    configureServer(server) {
      const dir = join(server.config.root, '.bench');
      mkdirSync(dir, { recursive: true });
      server.middlewares.use('/__bench', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const j = JSON.parse(body) as { line?: string; png?: string; name?: string };
            if (j.line) appendFileSync(join(dir, 'bench.log'), `${new Date().toISOString()} ${j.line}\n`);
            if (j.png) {
              const b = Buffer.from(j.png.replace(/^data:image\/png;base64,/, ''), 'base64');
              writeFileSync(join(dir, `${j.name ?? 'shot'}.png`), b);
            }
          } catch {
            /* ignore malformed */
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  server: { port: 5190 },
  build: { target: 'es2022' },
  plugins: [benchSink()],
});
