import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

// WebXR only works over HTTPS or on localhost. So that a headset on the same network can connect,
// the page is served with a self-signed certificate and on every network interface (host: true).
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  // The HUD uses the tokens and fonts of design-system/ (at the repository root).
  server: { host: true, port: 5173, fs: { allow: ['..'] } },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        check: resolve(import.meta.dirname, 'check.html'),
      },
    },
  },
});
