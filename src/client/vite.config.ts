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
        // often than app code). Each chunk is a COHESIVE ecosystem so no circular
        // dependency spans a chunk boundary (a forced catch-all "vendor" did — it caused
        // a "Cannot access X before initialization" TDZ crash at runtime). Anything not
        // matched here is left to Rollup (usually the entry chunk), which keeps init order
        // correct. Leaflet is only reached via a dynamic import, so it stays a lazy chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('leaflet')) return;
          if (/[\\/](antd|@ant-design|@rc-component|rc-[a-z-]+|dayjs)[\\/]/.test(id)) return 'antd';
          if (/[\\/](react|react-dom|scheduler|react-is)[\\/]/.test(id)) return 'react';
          if (/[\\/](react-markdown|remark|rehype|micromark|mdast|hast|unist|unified|vfile|marked|property-information|character-entities|decode-named-character-reference|space-separated-tokens|comma-separated-tokens|trim-lines|zwitch|html-void-elements|bail|is-plain-obj|trough)[\\/]/.test(id)) return 'markdown';
        }
      }
    }
  }
});
