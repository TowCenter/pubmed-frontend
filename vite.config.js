import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import pgDataPlugin from './pg-data-plugin.mjs'

export default defineConfig(({ mode }) => {
  // Load all .env vars (including non-VITE_ ones like DB_*) and expose them to
  // server-side plugins via process.env. Client code still only sees VITE_*.
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)

  return {
    plugins: [svelte(), pgDataPlugin()],
    // Must match GitHub repo name for Pages. Override with BASE_PATH=/ for
    // deploys served from a domain root (e.g. Railway) instead of a subpath.
    base: env.BASE_PATH || '/pubmed-frontend/',
    build: {
      outDir: 'dist' // Use 'dist' since you're using the `gh-pages` branch
    }
  }
})
