import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isTest = mode === 'test';
  const isServe = command === 'serve';

  // HTTPS certificates for LAN development (camera requires secure context)
  const key  = path.resolve(env.TLS_KEY  || '../certs/lan-key.pem');
  const cert = path.resolve(env.TLS_CERT || '../certs/lan.pem');
  if (isServe && !isTest && (!fs.existsSync(key) || !fs.existsSync(cert))) {
    throw new Error('HTTPS certificates missing. Run scripts/setup-https.ps1 first.');
  }

  // Firebase Functions emulator base URL
  const FUNC_EMULATOR = 'http://127.0.0.1:5001/agingtest-57600/us-central1/api';

  return {
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      cors: false,
      fs: {
        strict: true,
        allow: [process.cwd()],
        deny: ['.env', '.env.*', '**/*.{pem,key,crt}'],
      },
      https: isServe && !isTest
        ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
        : undefined,
      proxy: {
        // Proxy /api/* to the Firebase Functions emulator during development.
        // The emulator expects the path WITHOUT the /api prefix.
        '/api': {
          target: FUNC_EMULATOR,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
