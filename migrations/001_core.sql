CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tenants (
 id text PRIMARY KEY,
 name text NOT NULL,
 synthetic boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE demo_workspaces (
 code_hash text PRIMARY KEY,
 tenant_id text NOT NULL UNIQUE REFERENCES tenants(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
 tenant_id text NOT NULL REFERENCES tenants(id),
 id text NOT NULL,
 name jsonb NOT NULL,
 external_id text,
 PRIMARY KEY (tenant_id,id)
);
CREATE TABLE memberships (
 tenant_id text NOT NULL,
 user_id text NOT NULL,
 role text NOT NULL CHECK (role IN ('student','instructor','advisor')),
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY (tenant_id,user_id),
 FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE course_access (
 tenant_id text NOT NULL,
 user_id text NOT NULL,
 course_id text NOT NULL,
 access_role text NOT NULL CHECK (access_role IN ('student','instructor','advisor')),
 active boolean NOT NULL DEFAULT true,
 can_review boolean NOT NULL DEFAULT false,
 can_publish boolean NOT NULL DEFAULT false,
 PRIMARY KEY (tenant_id,user_id,course_id),
 FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE advisor_assignments (
 tenant_id text NOT NULL,
 advisor_id text NOT NULL,
 student_id text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY (tenant_id,advisor_id,student_id),
 FOREIGN KEY (tenant_id,advisor_id) REFERENCES users(tenant_id,id),
 FOREIGN KEY (tenant_id,student_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE auth_sessions (
 tenant_id text NOT NULL,
 id text NOT NULL,
 user_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX auth_sessions_user ON auth_sessions(tenant_id,user_id);
CREATE TABLE exam_sessions (
 tenant_id text NOT NULL,
 id text NOT NULL,
 user_id text NOT NULL,
 course_id text NOT NULL,
 protected boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,user_id,course_id) REFERENCES course_access(tenant_id,user_id,course_id)
);
CREATE INDEX active_exams ON exam_sessions(tenant_id,user_id,course_id,status);
CREATE TABLE policy_versions (
 id text PRIMARY KEY,
 version text NOT NULL,
 active boolean NOT NULL DEFAULT false,
 data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_policy ON policy_versions(active) WHERE active;
INSERT INTO policy_versions(id,version,active,data) VALUES('tilwa-education','1.0.0',true,'{"databaseFirst":true,"educationOnly":true,"protectedExam":"deny-tutor","maxContextCharacters":12000}') ON CONFLICT DO NOTHING;
CREATE TABLE records (
 tenant_id text NOT NULL REFERENCES tenants(id),
 id text NOT NULL,
 kind text NOT NULL,
 course_id text,
 owner_id text,
 data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX records_scope ON records(tenant_id,course_id,kind,owner_id);
CREATE INDEX records_payload ON records USING gin(data);
CREATE TABLE audit_events (
 tenant_id text NOT NULL REFERENCES tenants(id),
 id text NOT NULL,
 actor_id text,
 action text NOT NULL,
 entity_id text,
 data jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['users','memberships','course_access','advisor_assignments','auth_sessions','exam_sessions','records','audit_events'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
   EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',tab);
 END LOOP;
END $$;
