import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: the Fastify API server (apps/server) listens on port 8100.
// `ws: true` is enabled up front for the M3 WebSocket state stream
// (GET /api/simulations/:id/stream).
export default defineConfig({
  plugins: [react()],
  build: {
    // Route/canvas/tab-level code splitting lives in the app source
    // (React.lazy in App.tsx, WorldViewPage, SimulationView, WorldSidebar).
    // The manual chunks below only pin the always-needed framework core and
    // echarts into stable files so app-code deploys don't invalidate them.
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          vendor: ['react', 'react-dom', 'react-router-dom', 'zustand', '@tanstack/react-query'],
        },
      },
    },
    // echarts (~540kB min) is a lazy-loaded vendor chunk fetched on first
    // console/world-view mount — not part of the initial download. Anything
    // bigger than this limit in the INITIAL graph would be a regression.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // 127.0.0.1 (not "localhost"): on Windows, localhost may resolve to
        // ::1 while Fastify binds IPv4 only, which fails the proxy with 502.
        // EAF_API_TARGET overrides the upstream (e.g. when 8100 is occupied
        // by a docker-compose stack or WSL relay and the dev server runs on
        // another port).
        target: process.env.EAF_API_TARGET || 'http://127.0.0.1:8100',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
