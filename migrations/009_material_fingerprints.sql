-- Pilot source keys are reused in distinct courses. Version identity includes the course.
ALTER TABLE material_versions DROP CONSTRAINT material_versions_tenant_id_source_key_hash_key;
ALTER TABLE material_versions ADD UNIQUE (tenant_id,course_id,source_key,hash);
CREATE TABLE material_fingerprints (
  tenant_id text NOT NULL,
  course_id text NOT NULL,
  role text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('file','content')),
  digest text NOT NULL,
  first_page integer NOT NULL,
  last_page integer NOT NULL,
  document_pages integer NOT NULL,
  version_id text NOT NULL,
  PRIMARY KEY (tenant_id,course_id,role,kind,digest,first_page,last_page),
  FOREIGN KEY (tenant_id,version_id) REFERENCES material_versions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX material_fingerprint_versions ON material_fingerprints(tenant_id,version_id);
-- Keep pre-existing copies and their historical evidence. Use one stable representative.
INSERT INTO material_fingerprints
SELECT DISTINCT ON (tenant_id,course_id,role,digest,first_page,last_page)
  tenant_id,course_id,role,'file',digest,first_page,last_page,document_pages,id
FROM (
  SELECT v.*, coalesce(metadata->>'documentHash',
    CASE WHEN metadata->>'extractedInBrowser' IS DISTINCT FROM 'true'
      THEN coalesce(metadata->>'originalFileHash',hash) END) AS digest,
    coalesce((metadata->>'firstPage')::int,1) AS first_page,
    coalesce((metadata->>'lastPage')::int,page_count) AS last_page,
    coalesce((metadata->>'documentPages')::int,page_count) AS document_pages
  FROM material_versions v WHERE current_version AND page_count>0 AND bytes IS NOT NULL
) existing
WHERE digest IS NOT NULL ORDER BY tenant_id,course_id,role,digest,first_page,last_page,created_at,id;
WITH bodies AS (
  SELECT v.tenant_id,v.course_id,v.role,v.id,v.created_at,v.metadata,v.page_count,
    string_agg(trim(regexp_replace(normalize(c.text_content,NFKC),'[[:space:]]+',' ','g')),
      ' ' ORDER BY c.page NULLS LAST, length(c.section),c.section) AS body
  FROM material_versions v JOIN evidence_chunks c ON c.tenant_id=v.tenant_id AND c.version_id=v.id
  WHERE v.current_version AND (v.source_key LIKE 'LECTURE-%' OR v.source_key LIKE 'UMBRELLA-%')
  GROUP BY v.tenant_id,v.id
  HAVING bool_and(length(trim(c.text_content))>=60)
)
INSERT INTO material_fingerprints
SELECT tenant_id,course_id,role,'content',encode(sha256(convert_to(body,'UTF8')),'hex'),
  coalesce((metadata->>'firstPage')::int,1),coalesce((metadata->>'lastPage')::int,page_count),
  coalesce((metadata->>'documentPages')::int,page_count),id
FROM bodies ORDER BY created_at,id ON CONFLICT DO NOTHING;
ALTER TABLE material_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_fingerprints FORCE ROW LEVEL SECURITY;
CREATE POLICY fingerprint_tenant ON material_fingerprints
USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
