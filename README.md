# semantic-maps

## Development

```shell
npm install
npm run dev
```

## Deploy

```sh
npm run build
npm run deploy
```

## Load data from different sources

You can control which CSV to load via URL parameters when opening the app (works on GitHub Pages, localhost, etc.). The loader tries the following in order:

1. url param: use a full CSV URL
   - Example: `?url=https://my-cdn.example.com/maps/latest.csv`

1. filename param (with optional bucket): build a URL to a public S3 (or any host)
	- Default base: if only `filename` is provided, it resolves to the public bucket `https://pink-slime-public.s3.amazonaws.com/`.
	- With bucket name (S3): `?filename=courier_sda_asd.csv&bucket=my-bucket` → `https://my-bucket.s3.amazonaws.com/courier_sda_asd.csv`
	- With bucket host: `?filename=courier_sda_asd.csv&bucket=my-bucket.s3.us-east-1.amazonaws.com` → `https://my-bucket.s3.us-east-1.amazonaws.com/courier_sda_asd.csv`
	- With full base URL: `?filename=courier_sda_asd.csv&bucket=https://static.example.org/data/` → `https://static.example.org/data/courier_sda_asd.csv`

1. Env-configured default base + filename
	- If no `bucket` is provided, the app will use `VITE_S3_BASE_URL` (or `VITE_DATA_BASE_URL`), if set, and append `filename` to it.

1. Fallbacks
	- `VITE_DATA_URL` if defined, otherwise `public/data.csv` included in the repo.

Examples on GitHub Pages:

- `https://towcenter.github.io/semantic-map?filename=courier_sda_asd.csv`
- `https://towcenter.github.io/semantic-map?filename=courier_sda_asd.csv&bucket=my-bucket`
- `https://towcenter.github.io/semantic-map?url=https://my-bucket.s3.amazonaws.com/courier_sda_asd.csv`

Note: The CSV must be publicly readable and served with proper CORS headers.
# pubmed-semantic-interactive
