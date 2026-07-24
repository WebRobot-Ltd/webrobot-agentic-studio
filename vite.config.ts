import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// Library build: consumers with a Vue bundler can also import the source directly (main → src).
export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'WebRobotAgenticStudio',
      fileName: 'index',
      formats: ['es'],
    },
    rollupOptions: { external: ['vue'], output: { globals: { vue: 'Vue' } } },
  },
});
