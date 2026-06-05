# pubmed-frontend

Interactive semantic map of PubMed articles. A Svelte + Vite app that plots
articles in 2D embedding space, with date filtering, search, and category
highlighting.

## Development

```shell
npm install
npm run dev
```

## Deploy

```sh
npm run build
npm run deploy   # builds and publishes dist/ to the gh-pages branch
```

> **GitHub Pages note:** `base` in [vite.config.js](vite.config.js) must match the
> repo name for Pages to resolve assets. Set it to `/pubmed-frontend/` before
> deploying to this repo.

## Data loading

By default the app loads `public/data-with-xy.csv`. You can override the source
at runtime via URL parameters (works on GitHub Pages, localhost, etc.). The
loader resolves the data URL in this order:

1. **`url`** — a full CSV URL
   - Example: `?url=https://my-cdn.example.com/maps/latest.csv`

2. **`filename`** (with optional **`bucket`**) — build a URL to a public S3 (or any host)
   - Default base: if only `filename` is given, it resolves to the public bucket `https://pink-slime-public.s3.amazonaws.com/`.
   - Bare bucket name: `?filename=foo.csv&bucket=my-bucket` → `https://my-bucket.s3.amazonaws.com/foo.csv`
   - Bucket host: `?filename=foo.csv&bucket=my-bucket.s3.us-east-1.amazonaws.com` → `https://my-bucket.s3.us-east-1.amazonaws.com/foo.csv`
   - Full base URL: `?filename=foo.csv&bucket=https://static.example.org/data/` → `https://static.example.org/data/foo.csv`

3. **Env-configured base + `filename`**
   - If no `bucket` is provided, the app uses `VITE_S3_BASE_URL` (or `VITE_DATA_BASE_URL`), if set, and appends `filename`.

4. **Fallbacks**
   - `VITE_DATA_URL` if defined, otherwise the bundled `public/data-with-xy.csv`.

Examples on GitHub Pages:

- `https://towcenter.github.io/pubmed-frontend/?filename=foo.csv`
- `https://towcenter.github.io/pubmed-frontend/?filename=foo.csv&bucket=my-bucket`
- `https://towcenter.github.io/pubmed-frontend/?url=https://my-bucket.s3.amazonaws.com/foo.csv`

> Note: any external CSV must be publicly readable and served with proper CORS headers.
