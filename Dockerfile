FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Public AWS RDS CA bundle (not a secret, just the cert chain RDS's SSL
# connection requires) — gitignored locally, so fetch it fresh here.
RUN node -e "fetch('https://truststore.pds.aws.amazon.com/global/global-bundle.pem').then(r=>r.text()).then(t=>require('fs').writeFileSync('global-bundle.pem',t))"

# Build-time Postgres snapshot (per-collection CSVs, collections.json, COI
# graph core/extended) plus the static bundle. Needs DB_* to be available as
# Railway service variables — this runs live queries now, not at request time.
RUN node scripts/export-db.mjs && node scripts/build-coi-graph.mjs && npx vite build

EXPOSE 4173
CMD npx vite preview --host 0.0.0.0 --port $PORT
