import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Which vendor a module belongs to, for the chunk split below. The entry chunk used to be a
 * single 600KB file: React, the router, Supabase, Motion and every route's shared code, all
 * cache-busted together by any one-line change to the app. Splitting the vendors out means a
 * deploy that touches only app code leaves React, Supabase and Motion in the visitor's cache.
 *
 * Base UI is deliberately NOT named either: one group for all of @base-ui/react shipped the
 * dialog, sheet, checkbox and radio machinery — reached only from lazy dashboard and storefront
 * routes — to every prerendered marketing page, 224KB preloaded for four components. Left to
 * rolldown, the entry carries only the primitives it renders.
 *
 * Recharts, the table stack and dnd-kit are deliberately NOT named: each is imported by one or
 * two lazy dashboard sections, and rolldown already emits them as shared lazy chunks. Naming
 * them as groups made rolldown park clsx — which recharts and the app both use — inside the
 * recharts chunk, so the marketing entry preloaded 387KB of charts to reach a class joiner.
 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  // Tiny helpers that BOTH the app and a vendor below depend on, named first and explicitly so
  // none of them is parked inside a vendor chunk and dragged onto the entry path from there.
  if (/[\\/]node_modules[\\/](clsx|tailwind-merge|class-variance-authority|react-is|tiny-invariant|use-sync-external-store|@radix-ui[\\/]react-slot)[\\/]/.test(id)) return 'shared'
  if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react'
  if (id.includes('/@supabase/')) return 'supabase'
  if (id.includes('/motion/') || id.includes('/framer-motion/') || id.includes('/motion-dom/') || id.includes('/motion-utils/')) return 'motion'
  return undefined
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
})
