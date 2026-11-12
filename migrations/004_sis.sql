-- This registrar adapter is intentionally isolated from learning/assessment storage.
-- No foreign keys or joins into an external registrar database are permitted.
CREATE SCHEMA IF NOT EXISTS demo_sis;
CREATE TABLE IF NOT EXISTS demo_sis.external_students (
  tenant_id text NOT NULL,
  external_student_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (tenant_id, external_student_id),
  UNIQUE (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS demo_sis.integration_inbox (
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  external_student_id text NOT NULL,
  course_id text NOT NULL,
  semester text NOT NULL,
  assessment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('local-demo', 'external-contract')),
  disposition text NOT NULL CHECK (disposition IN ('pending','applied','ignored-stale','revision-conflict')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,event_id)
);
CREATE TABLE IF NOT EXISTS demo_sis.result_projections (
  tenant_id text NOT NULL,
  external_student_id text NOT NULL,
  course_id text NOT NULL,
  semester text NOT NULL,
  assessment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('approved','revoked')),
  grade numeric,
  scale numeric NOT NULL CHECK (scale > 0),
  occurred_at timestamptz NOT NULL,
  event_id text NOT NULL,
  synthetic boolean NOT NULL DEFAULT false,
  adapter text NOT NULL CHECK (adapter IN ('local-demo', 'external-contract')),
  PRIMARY KEY (tenant_id,external_student_id,course_id,semester,assessment_id),
  FOREIGN KEY (tenant_id,external_student_id) REFERENCES demo_sis.external_students(tenant_id,external_student_id),
  FOREIGN KEY (tenant_id,event_id) REFERENCES demo_sis.integration_inbox(tenant_id,event_id),
  CHECK ((status='revoked' AND grade IS NULL) OR (status='approved' AND grade >= 0 AND grade <= scale))
);
CREATE TABLE IF NOT EXISTS demo_sis.audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  event_id text NOT NULL,
  action text NOT NULL,
  before_revision integer,
  after_revision integer,
  adapter text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sis_inbox_student ON demo_sis.integration_inbox(tenant_id,external_student_id,received_at);
CREATE INDEX IF NOT EXISTS sis_audit_tenant ON demo_sis.audit_events(tenant_id,created_at);
ALTER TABLE demo_sis.external_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.external_students FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.integration_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.integration_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.result_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.result_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_sis.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY sis_students_tenant ON demo_sis.external_students USING (tenant_id = current_setting('app.tenant_id',true)) WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
CREATE POLICY sis_inbox_tenant ON demo_sis.integration_inbox USING (tenant_id = current_setting('app.tenant_id',true)) WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
CREATE POLICY sis_results_tenant ON demo_sis.result_projections USING (tenant_id = current_setting('app.tenant_id',true)) WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
CREATE POLICY sis_audit_tenant ON demo_sis.audit_events USING (tenant_id = current_setting('app.tenant_id',true)) WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
