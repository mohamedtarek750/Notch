-- Published releases are immutable audit snapshots. These tables index their current
-- academic memberships and semantic relationships without renumbering learner records.
CREATE TABLE km_identities (
  tenant_id text REFERENCES tenants(id), id text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE km_memberships (
  tenant_id text NOT NULL, course_id text NOT NULL, concept_id text NOT NULL, release_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (tenant_id,course_id,concept_id),
  FOREIGN KEY (tenant_id,concept_id) REFERENCES km_identities(tenant_id,id),
  FOREIGN KEY (tenant_id,course_id,release_id) REFERENCES records(tenant_id,scope,id) ON DELETE CASCADE
);
CREATE INDEX km_membership_identity ON km_memberships(tenant_id,concept_id,course_id);
CREATE TABLE km_citations (
  tenant_id text NOT NULL, course_id text NOT NULL, concept_id text NOT NULL, evidence_id text NOT NULL,
  PRIMARY KEY (tenant_id,course_id,concept_id,evidence_id),
  FOREIGN KEY (tenant_id,course_id,concept_id) REFERENCES km_memberships ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,evidence_id) REFERENCES evidence_chunks ON DELETE CASCADE
);
CREATE INDEX km_citation_source ON km_citations(tenant_id,evidence_id,concept_id);
CREATE TABLE km_edges (
  tenant_id text NOT NULL, course_id text NOT NULL, source text NOT NULL, target text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prerequisite','related','optional_bridge','is_a','part_of','used_in','solves')),
  evidence jsonb NOT NULL, origin text, CHECK (source <> target),
  PRIMARY KEY (tenant_id,course_id,source,target,kind),
  FOREIGN KEY (tenant_id,course_id,source) REFERENCES km_memberships ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,course_id,target) REFERENCES km_memberships ON DELETE CASCADE
);
CREATE INDEX km_edges_forward ON km_edges(tenant_id,source,kind,target);
CREATE INDEX km_edges_reverse ON km_edges(tenant_id,target,kind,source);
CREATE INDEX km_latest_release ON records(tenant_id,course_id,created_at DESC,id DESC) WHERE kind='graph_release';
CREATE INDEX km_material_children ON material_versions(tenant_id,course_id,role,source_key) WHERE current_version;

CREATE FUNCTION km_index_release(t text, c text, r text, graph jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM km_memberships WHERE tenant_id=t AND course_id=c;
  INSERT INTO km_identities(tenant_id,id)
    SELECT t,node->>'id' FROM jsonb_array_elements(graph->'concepts') node
    ON CONFLICT DO NOTHING;
  INSERT INTO km_memberships
    SELECT t,c,node->>'id',r,node FROM jsonb_array_elements(graph->'concepts') node;
  INSERT INTO km_citations
    SELECT DISTINCT t,c,m.concept_id,e.id FROM km_memberships m
    CROSS JOIN LATERAL jsonb_array_elements_text(m.data->'evidenceIds') ids(id)
    JOIN evidence_chunks e ON e.tenant_id=t AND e.id=ids.id
    WHERE m.tenant_id=t AND m.course_id=c;
  INSERT INTO km_edges
    SELECT t,c,edge->>'from',edge->>'to',edge->>'type',COALESCE(edge->'evidenceIds','[]'),edge->>'origin'
    FROM jsonb_array_elements(graph->'edges') edge;
END $$;

DO $$ DECLARE r record; tenant record; BEGIN
  FOR tenant IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant.id, true);
    FOR r IN SELECT DISTINCT ON(course_id) tenant_id,course_id,id,data FROM records
      WHERE tenant_id=tenant.id AND kind='graph_release' AND course_id IS NOT NULL
      ORDER BY course_id,created_at DESC,id DESC LOOP
      PERFORM km_index_release(r.tenant_id,r.course_id,r.id,r.data->'graph');
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION km_on_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize even simultaneous publications in different courses sharing an identity.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id || ':km-publication'));
  IF EXISTS (SELECT 1 FROM records WHERE tenant_id=NEW.tenant_id AND course_id=NEW.course_id
    AND kind='graph_release' AND (created_at,id)>(NEW.created_at,NEW.id)) THEN RETURN NEW; END IF;
  PERFORM km_index_release(NEW.tenant_id,NEW.course_id,NEW.id,NEW.data->'graph');
  IF EXISTS (
    WITH RECURSIVE walks(start_id,at_id) AS (
      SELECT source,target FROM km_edges WHERE tenant_id=NEW.tenant_id AND course_id=NEW.course_id AND kind='prerequisite'
      UNION
      SELECT w.start_id,e.target FROM walks w JOIN km_edges e ON
        e.tenant_id=NEW.tenant_id AND e.kind='prerequisite' AND e.source=w.at_id
    ) SELECT 1 FROM walks WHERE start_id=at_id
  ) THEN RAISE EXCEPTION 'cycle' USING ERRCODE='23514', CONSTRAINT='km_prerequisite_acyclic'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER km_release AFTER INSERT ON records FOR EACH ROW
  WHEN (NEW.kind='graph_release' AND NEW.course_id IS NOT NULL) EXECUTE FUNCTION km_on_release();

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['km_identities','km_memberships','km_citations','km_edges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY km_tenant ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true))',tbl);
  END LOOP;
END $$;
