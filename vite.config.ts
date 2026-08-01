/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Codec extensions must register against the same Mediabunny instance in
  // each realm. Module workers also need ES chunks for lazy decoder imports.
  resolve: {
    dedupe: ['mediabunny'],
  },
  worker: {
    format: 'es',
  },
  // External preview harnesses may assign an isolated port through PORT;
  // plain `npm run dev` keeps Vite's 5173 default.
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The architecture guard uses the compiler parser directly. Keep the
    // compiler external so Vite does not transform its large CommonJS bundle.
    server: {
      deps: {
        external: ['typescript'],
      },
    },
  },
})
