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
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the big vendors into separately-cacheable chunks (they change far less
        // often than app code). Leaflet is only reached via a dynamic import (the map),
        // so it is left unassigned and Rollup keeps it in its own async chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('leaflet')) return; // stays in the lazy map chunk
          if (id.includes('/antd/') || id.includes('@ant-design/')) return 'antd';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react';
          if (/[\\/](react-markdown|remark|rehype|micromark|mdast|hast|unist|unified|vfile|marked|property-information|character-entities|decode-named-character-reference|space-separated-tokens|comma-separated-tokens|trim-lines|zwitch|html-void-elements|bail|is-plain-obj|trough|estree)/.test(id)) return 'markdown';
          return 'vendor';
        }
      }
    }
  }
});
