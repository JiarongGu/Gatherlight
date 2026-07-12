import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// In dev the backend runs Vite in middleware mode on its own port (5317) and
// serves /api itself — no proxy needed. These server settings apply only when
// Vite is run standalone (`npm -w @daily-planner/frontend run dev`, frontend-only).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
  },
  server: {
    host: true,
    port: 5317, // scramble of Vite's default 5173 — avoids clashing with other projects
    strictPort: true,
    fs: {
      // __dirname is viewer/frontend → repo root is two levels up.
      // Vite must read plans/ household/ .claude/ (globbed) from the repo root.
      allow: [path.resolve(__dirname, '..', '..')]
    }
  }
});
