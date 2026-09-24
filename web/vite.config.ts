import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      includeAssets: [
        'favicon.svg',
        'favicon-classic.svg',
        'apple-touch-icon-180x180.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-512x512.png',
        'push-sw.js',
      ],
      manifest: {
        name: 'Travel Bill Split',
        short_name: 'BillSplit',
        description: 'Split travel expenses with friends',
        lang: 'en',
        theme_color: '#f3eee3',
        background_color: '#f3eee3',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // SPA fallback so /join/:token and /trips/:id/* work offline-cached too.
        navigateFallback: 'index.html',
        // Web Push handlers live in public/push-sw.js (generateSW has none).
        importScripts: ['push-sw.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // Google Fonts (Washi theme): keep the CSS fresh, cache the font files.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
