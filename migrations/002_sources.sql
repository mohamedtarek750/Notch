CREATE TABLE IF NOT EXISTS material_versions (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, course_id text NOT NULL,
 source_key text NOT NULL, title text NOT NULL, role text NOT NULL CHECK(role IN ('instructor','umbrella')),
 hash text NOT NULL, filename text, mime_type text, bytes bytea, page_count integer,
 rights jsonb NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending', current_version boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,source_key,hash)
);
CREATE INDEX IF NOT EXISTS material_scope ON material_versions(tenant_id,course_id,source_key,current_version);
CREATE TABLE IF NOT EXISTS evidence_chunks (
 tenant_id text NOT NULL, id text NOT NULL, version_id text NOT NULL, course_id text NOT NULL,
 page integer, section text, text_content text NOT NULL, language text NOT NULL DEFAULT 'en',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','quarantined','rejected')),
 review_note text, reviewed_by text, reviewed_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,version_id) REFERENCES material_versions(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS evidence_scope ON evidence_chunks(tenant_id,course_id,status,version_id);
CREATE TABLE IF NOT EXISTS model_traces (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, user_id text NOT NULL,
 operation text NOT NULL, policy_version text NOT NULL, retrieved_at timestamptz,
 generated_at timestamptz, evidence_ids jsonb NOT NULL DEFAULT '[]', model_id text,
 outcome text NOT NULL, tokens integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS trace_budget ON model_traces(tenant_id,user_id,created_at);

ALTER TABLE material_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY material_versions_tenant ON material_versions USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));

ALTER TABLE evidence_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_chunks_tenant ON evidence_chunks USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));

ALTER TABLE model_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_traces FORCE ROW LEVEL SECURITY;
CREATE POLICY model_traces_tenant ON model_traces USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
