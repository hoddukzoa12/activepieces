/// <reference types='vitest' />
import path from 'path';

import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import { createHtmlPlugin } from 'vite-plugin-html';

export default defineConfig(({ command, mode }) => {
  const isDev = command === 'serve' || mode === 'development';

  const AP_TITLE = isDev ? 'Activepieces' : '${AP_APP_TITLE}';

  const AP_FAVICON = isDev
    ? 'https://activepieces.com/favicon.ico'
    : '${AP_FAVICON_URL}';

  const hmrHost = process.env.VITE_HMR_HOST ?? process.env.HMR_HOST;
  const hmrProtocol =
    process.env.VITE_HMR_PROTOCOL ?? process.env.HMR_PROTOCOL ?? 'wss';
  const hmrClientPort =
    process.env.VITE_HMR_CLIENT_PORT ?? process.env.HMR_CLIENT_PORT;
  const hmrConfig = hmrHost
    ? {
        host: hmrHost,
        protocol: hmrProtocol,
        ...(hmrClientPort ? { clientPort: Number(hmrClientPort) } : {}),
      }
    : undefined;

  return {
    root: __dirname,
    cacheDir: '../../node_modules/.vite/packages/react-ui',

    server: {
      allowedHosts: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          secure: false,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          headers: {
            Host: '127.0.0.1:4200',
          },
          ws: true,
        },
      },
      port: 4200,
      host: '0.0.0.0',
      hmr: hmrConfig,
    },

    preview: {
      port: 4300,
      host: 'localhost',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@activepieces/shared': path.resolve(
          __dirname,
          '../../packages/shared/src',
        ),
        'ee-embed-sdk': path.resolve(
          __dirname,
          '../../packages/ee/ui/embed-sdk/src',
        ),
        '@activepieces/ee-shared': path.resolve(
          __dirname,
          '../../packages/ee/shared/src',
        ),
        '@activepieces/pieces-framework': path.resolve(
          __dirname,
          '../../packages/pieces/community/framework/src',
        ),
      },
    },
    plugins: [
      react(),
      nxViteTsPaths(),

      createHtmlPlugin({
        inject: {
          data: {
            apTitle: AP_TITLE,
            apFavicon: AP_FAVICON,
          },
        },
      }),
      checker({
        typescript: {
          buildMode: true,
          tsconfigPath: './tsconfig.json',
          root: __dirname,
        },
      }),
    ],

    build: {
      outDir: '../../dist/packages/react-ui',
      emptyOutDir: true,
      reportCompressedSize: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
      rollupOptions: {
        onLog(level, log, handler) {
          if (
            log.cause &&
            log.message.includes(`Can't resolve original location of error.`)
          ) {
            return;
          }
          handler(level, log);
        },
      },
    },
  };
});
