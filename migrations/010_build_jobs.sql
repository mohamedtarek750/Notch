CREATE TABLE km_build_jobs (
  tenant_id text NOT NULL, id text NOT NULL, course_id text NOT NULL, owner_id text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en','ar')),
  status text NOT NULL CHECK (status IN ('queued','processing','completed','cancelled','failed')),
  request_key text NOT NULL, documents jsonb NOT NULL,
  lease_token text, lease_until timestamptz,
  next_attempt timestamptz NOT NULL DEFAULT now(), failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,owner_id,course_id) REFERENCES course_access(tenant_id,user_id,course_id)
);
CREATE INDEX km_jobs_history ON km_build_jobs(tenant_id,course_id,created_at DESC);
CREATE INDEX km_jobs_ready ON km_build_jobs(tenant_id,next_attempt,created_at)
  WHERE status IN ('processing','queued');
CREATE UNIQUE INDEX km_jobs_inflight ON km_build_jobs(tenant_id,course_id,request_key)
  WHERE status IN ('processing','queued');
CREATE TABLE km_build_results (
  tenant_id text NOT NULL, course_id text NOT NULL, version_id text NOT NULL, cache_key text NOT NULL,
  proposal_id text NOT NULL, PRIMARY KEY (tenant_id,course_id,version_id,cache_key),
  FOREIGN KEY (tenant_id,version_id) REFERENCES material_versions(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE km_build_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE km_build_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY build_job_tenant ON km_build_jobs USING (tenant_id=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
ALTER TABLE km_build_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE km_build_results FORCE ROW LEVEL SECURITY;
CREATE POLICY build_result_tenant ON km_build_results USING (tenant_id=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
