-- The same concept, objective or settings id can exist in more than one course.
ALTER TABLE records ADD COLUMN IF NOT EXISTS scope text GENERATED ALWAYS AS (COALESCE(course_id,'')) STORED;
ALTER TABLE records DROP CONSTRAINT records_pkey;
ALTER TABLE records ADD CONSTRAINT records_pkey PRIMARY KEY (tenant_id, scope, id);
CREATE INDEX IF NOT EXISTS records_by_id ON records(tenant_id, id);
