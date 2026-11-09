import { defineConfig, devices } from '@playwright/test';
import { loadConfig } from './src/config.ts';

const { appOrigin } = loadConfig();
// The student's iPad in landscape, the primary layout.
const IPAD_LANDSCAPE = { width: 1194, height: 834 };

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: '.runtime/captures/playwright',
  forbidOnly: true,
  reporter: 'list',
  use: { baseURL: appOrigin, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: IPAD_LANDSCAPE } }],
  // Browser checks run against the built app served on this Task's own origin; a busy port fails
  // instead of silently testing another worktree's server.
  webServer: { command: 'npm run build && npm run start', url: `${appOrigin}/`, reuseExistingServer: false, timeout: 60_000 },
});
