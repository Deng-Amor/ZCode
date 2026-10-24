import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { readRelease } from './scripts/releases.mjs';

await readRelease(fileURLToPath(new URL('./public/', import.meta.url)));

export default defineConfig({
  output: 'static',
  devToolbar: { enabled: false },
});
