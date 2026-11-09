import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { HOST, loadConfig } from './src/config.ts';

const config = loadConfig();
const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./web'),
  // The browser shares the isomorphic core with the server through one alias.
  resolve: { alias: { '@core': fromRoot('./src') } },
  plugins: [react()],
  build: { outDir: fromRoot('./dist'), emptyOutDir: true },
  server: {
    host: HOST,
    port: config.vitePort,
    strictPort: true,
    // The page is opened on the app origin, which proxies HMR to this server, so the HMR client
    // must connect back through the app port.
    hmr: { clientPort: config.port },
    // Test traces, builds and logs are written inside the repo during a run; watching them would
    // reload every open page.
    watch: { ignored: ['**/.runtime/**', '**/dist/**', '**/storybook-static/**'] },
  },
});
