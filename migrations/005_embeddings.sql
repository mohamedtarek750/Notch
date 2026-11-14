-- Semantic retrieval index over reviewed evidence. One vector per chunk and embedding model.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
 tenant_id text NOT NULL REFERENCES tenants(id), chunk_id text NOT NULL, model text NOT NULL,
 vector jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,chunk_id,model),
 FOREIGN KEY(tenant_id,chunk_id) REFERENCES evidence_chunks(tenant_id,id)
);
ALTER TABLE chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY chunk_embeddings_tenant ON chunk_embeddings USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
