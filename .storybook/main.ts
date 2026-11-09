import type { StorybookConfig } from '@storybook/react-vite';
import { loadConfig } from '../src/config.ts';

const { appOrigin } = loadConfig();

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  // react-docgen reads component props without the TypeScript compiler API, which TypeScript 7 lacks.
  typescript: { reactDocgen: 'react-docgen' },
  // Stories that read live data call the running app on its configured origin. The Host header is
  // rewritten to the app origin, which is the only host the app accepts. Test traces, builds and logs
  // are written inside the repo while stories are open; watching them would reload every open story.
  viteFinal: (vite) => ({
    ...vite,
    server: {
      ...vite.server,
      proxy: { ...vite.server?.proxy, '/api': { target: appOrigin, changeOrigin: true } },
      watch: { ...vite.server?.watch, ignored: ['**/.runtime/**', '**/dist/**', '**/storybook-static/**'] },
    },
  }),
};

export default config;
