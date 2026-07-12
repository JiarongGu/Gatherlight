import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev: standalone Vite on :5173 proxying /api → the Gatherlight server on :5317.
// Build: output lands in the server project's wwwroot (gitignored) so `dotnet run`
// serves the same bundle in production.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:5317',
      '/mcp': 'http://localhost:5317'
    }
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'server', 'Gatherlight.Server', 'wwwroot'),
    emptyOutDir: true
  }
});
