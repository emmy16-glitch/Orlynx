import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://localhost:4000',
      '/health': 'http://localhost:4000',
    },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
