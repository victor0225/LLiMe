import type { StorybookConfig } from '@storybook/react-vite';
import { loadConfig } from '../src/config.ts';

const { appOrigin } = loadConfig();

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  // react-docgen reads component props without the TypeScript compiler API, which TypeScript 7 lacks.
  typescript: { reactDocgen: 'react-docgen' },
  // Stories that read live data call the running app on its configured origin.
  viteFinal: (vite) => ({ ...vite, server: { ...vite.server, proxy: { ...vite.server?.proxy, '/api': appOrigin } } }),
};

export default config;
