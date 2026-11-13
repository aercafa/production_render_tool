import { defineConfig } from 'vite';
import { localWorkbench } from './server/local-workbench.mjs';

export default defineConfig({ plugins: [localWorkbench()] });
