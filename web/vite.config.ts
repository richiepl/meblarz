import { defineConfig } from 'vite';
import { resolve } from 'path';

// dwie strony: edytor mebli (index.html) i mieszkanie (apartment.html)
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        apartment: resolve(__dirname, 'apartment.html'),
      },
    },
  },
});
