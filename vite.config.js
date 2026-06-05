import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'
import pgDataPlugin from './pg-data-plugin.mjs'

export default defineConfig(({ mode }) => {
  // Load all .env vars (including non-VITE_ ones like DB_*) and expose them to
  // server-side plugins via process.env. Client code still only sees VITE_*.
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)

  return {
    plugins: [svelte(), pgDataPlugin()],
    resolve: {
      alias: {
        "$components": path.resolve('./src/components'),
        "$data": path.resolve("./src/data"),
        "$routes": path.resolve("./src/routes"),
      }
    },
    base: '/pubmed-frontend/', // Must match GitHub repo name for Pages
    build: {
      outDir: 'dist' // Use 'dist' since you're using the `gh-pages` branch
    }
  }
})
