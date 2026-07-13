import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env } from './env.js'

// The production entry point, and the esbuild bundle's entry. Its only job is to bind the
// app to a port — the routes live in app.ts, which stays importable without starting a
// server so tests/api can drive it in-process.
serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`BiteTime billing server on http://localhost:${info.port}`)
})
