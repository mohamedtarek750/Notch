-- A page that covers several topics is indexed as several segments, so a question about
-- one of them is not diluted by the rest. Citations still point to the whole page.
ALTER TABLE chunk_embeddings ADD COLUMN IF NOT EXISTS part integer NOT NULL DEFAULT 0;
ALTER TABLE chunk_embeddings DROP CONSTRAINT IF EXISTS chunk_embeddings_pkey;
ALTER TABLE chunk_embeddings ADD PRIMARY KEY (tenant_id,chunk_id,model,part);
