import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { aiPlugin } from './server/ai-plugin';

// Cross-origin isolation lets the cut-out model use multiple threads (much faster).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), aiPlugin()],
  // The key in .env.local is read by the AI route on each request. Keeping Vite itself away
  // from env files means adding the key never restarts the server or exposes it to the client.
  envDir: false,
  server: { port: 5183, strictPort: false, headers: isolation },
  preview: { port: 5183, headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
