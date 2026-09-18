import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3102' } },
  build: {
    rolldownOptions: {
      output: { manualChunks: (id: string) => id.includes('/node_modules/three/') ? 'three' : undefined },
    },
  },
});
