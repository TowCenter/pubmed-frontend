# ================================================================
# Semantic entity resolution across Affiliation / Funding / COI
# Architecture (per Modern Data 101): EXTRACT -> EMBED -> BLOCK (ANN)
#   -> SCORE (cosine) -> CLUSTER -> canonical mapping
# Deps:  pip install sentence-transformers scikit-learn pandas
#   (lighter alt: model2vec instead of sentence-transformers)
# ================================================================
import re, collections
import numpy as np
import pandas as pd

# ---------- 1. EXTRACTION (same tagged-mention step as before) ----------
FUNDER_VERBS = (r'(?:funded by|supported by|support from|grant(?:s)? from|'
    r'received (?:[a-z ]*?)?from|consultant (?:for|to)|employee of|employed by|'
    r'fees from|honoraria from|stock in|shareholder (?:of|in)|advisory board (?:of|for)|'
    r'this work was|the authors?|dr\.? \w+ is an?|dr\.? \w+ is a)')
STOP_PHR = ['electronic address','united states of america','united states','department of',
    'regulatory sciences','behavioral and clinical sciences','product stewardship',
    'scientific affairs','inc','llc','ltd','corp','usa','u s a']
NON_ENTITY = re.compile(r'^(none|nothing|not applicable|na|'
    r'(no|none)(\s+\w+){0,4}\s*(declared|to declare|disclosed|reported)?|authors? declare)\s*$')
ORG_RE = (r'(labs?|university|institute|college|hospital|corp|inc|llc|ltd|'
          r'analytical|pharma|pharmaceutical|foundation|altria|company|gmbh|ag)')

def _clean(s):
    s = s.lower()
    s = re.sub(r'[\w.\-]+@[\w.\-]+',' ',s)
    s = re.sub(r'\b\d{5}(?:-\d{4})?\b',' ',s)
    s = re.sub(r'grant(?:\s+no\.?)?\s*[a-z0-9\-]+',' ',s)
    s = re.sub(r'\br?\d[\d\-]{3,}\b',' ',s)
    s = re.sub(r'[^a-z0-9& ]',' ',s)
    return re.sub(r'\s+',' ',s).strip(' .,;:')

def _norm(s):
    s = re.sub(FUNDER_VERBS,' ',s,flags=re.I)
    s = _clean(s)
    for t in sorted(STOP_PHR,key=len,reverse=True):
        s = re.sub(rf'(?<!\w){re.escape(t)}(?!\w)',' ',s)
    return re.sub(r'\s+',' ',s).strip()

def extract(row_id, column, cell):
    if not cell or not str(cell).strip(): return []
    cell = str(cell)
    if column == 'affiliation':
        parts = [p.strip() for p in cell.split(',') if p.strip()]
        raws = [p for p in parts if re.search(ORG_RE,p,re.I)] or parts[:1]
    else:
        raws = [f for f in re.split(r'\band\b|;|,|\.\s',cell) if f.strip()]
    out, seen = [], set()
    for rm in raws:
        m = _norm(rm)
        if len(m) >= 3 and m not in seen and not NON_ENTITY.match(m):
            seen.add(m); out.append({'row':row_id,'column':column,'raw':cell,'mention':m})
    return out

# ---------- 2. EMBED ----------
def get_embedder():
    """Return a function str_list -> (n, d) float array. Tries real models,
    falls back to a hashing embedder if offline (keeps the cell runnable)."""
    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer('all-MiniLM-L6-v2')
        return lambda xs: np.asarray(model.encode(xs, normalize_embeddings=True))
    except Exception:
        pass
    try:
        from model2vec import StaticModel
        model = StaticModel.from_pretrained('minishlab/potion-base-8M')
        def enc(xs):
            v = np.asarray(model.encode(xs), dtype=float)
            return v / (np.linalg.norm(v,axis=1,keepdims=True)+1e-9)
        return enc
    except Exception:
        # offline fallback: char-ngram hashing (no semantic power, but runs)
        from sklearn.feature_extraction.text import HashingVectorizer
        hv = HashingVectorizer(n_features=512, analyzer='char_wb',
                               ngram_range=(2,4), norm='l2')
        return lambda xs: hv.transform(xs).toarray()

# ---------- 3-5. BLOCK (ANN) -> SCORE -> CLUSTER ----------
def resolve_semantic(mentions, embed, sim_threshold=0.72, k=10):
    from sklearn.neighbors import NearestNeighbors
    texts = [m['mention'] for m in mentions]
    X = embed(texts)                                   # (n, d) normalized

    # BLOCKING: approximate nearest neighbours instead of all-pairs
    n = len(texts)
    nn = NearestNeighbors(n_neighbors=min(k, n), metric='cosine').fit(X)
    dist, idx = nn.kneighbors(X)

    # SCORING + edges above threshold -> union-find CLUSTERING
    parent = list(range(n))
    def find(x):
        while parent[x]!=x: parent[x]=parent[parent[x]]; x=parent[x]
        return x
    for i in range(n):
        for d,j in zip(dist[i], idx[i]):
            if i!=j and (1.0-d) >= sim_threshold:
                parent[find(i)] = find(j)
    groups = collections.defaultdict(list)
    for i in range(n): groups[find(i)].append(i)

    rows = []
    for members in groups.values():
        cnt = collections.Counter(texts[i] for i in members)
        label = sorted(cnt.items(), key=lambda kv:(-kv[1], len(kv[0])))[0][0].title()
        for i in members:
            m = mentions[i]
            rows.append({'row':m['row'],'column':m['column'],'canonical_entity':label,
                         'extracted_mention':m['mention'],'raw_cell':m['raw']})
    return pd.DataFrame(rows).sort_values(['row','column']).reset_index(drop=True)

def dedupe_entities(df, cols, sim_threshold=0.72):
    mentions = []
    for logical, actual in cols.items():
        if actual in df.columns:
            for row_id, cell in df[actual].items():
                mentions += extract(row_id, logical, cell)
    embed = get_embedder()
    return resolve_semantic(mentions, embed, sim_threshold)

# ---------- DEMO ----------
if __name__ == '__main__':
    df = pd.DataFrame({
        'Affiliation':['Juul Labs, Inc., San Francisco, CA, 94107, USA.',
                       'Enthalpy Analytical, Durham, NC, USA.',
                       'JUUL Labs, Inc, Washington, DC, USA.'],
        'Funding':['Funded by Juul Labs.','Supported by the NIH.',
                   'Funded by the National Institutes of Health.'],
        'ConflictOfInterest':['Employee of Juul Labs.',
                   'Stock in Altria; consultant for Pfizer.','None declared.'],
    })
    out = dedupe_entities(df, {'affiliation':'Affiliation','funding':'Funding',
                               'coi':'ConflictOfInterest'})
    print(out.to_string(index=False))
