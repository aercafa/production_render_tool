import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4181',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'npm run preview -- --port 4181 --strictPort',
    env: { RENDER_WORKBENCH_HOME: path.resolve('local-fixtures', 'playwright-' + randomUUID()) },
    url: 'http://127.0.0.1:4181',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
