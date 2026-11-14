import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "./db";
export async function migrateDatabase(): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const files = (await readdir(resolve("migrations")))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const applied: string[] = [];
  for (const name of files) {
    const existing = await db.query(
      "SELECT name FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (existing.rows.length) continue;
    const sql = await readFile(resolve("migrations", name), "utf8");
    await db.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    });
    applied.push(name);
  }
  // A deployment login may be granted membership of this least-privilege group.
  await db.query(
    `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tilwa_runtime') THEN CREATE ROLE tilwa_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;`,
  );
  await db.query(
    "GRANT USAGE ON SCHEMA public TO tilwa_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO tilwa_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO tilwa_runtime; REVOKE ALL ON schema_migrations FROM tilwa_runtime; REVOKE INSERT,UPDATE,DELETE ON policy_versions FROM tilwa_runtime;",
  );
  const sis = await db.query(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name='demo_sis'",
  );
  if (sis.rows.length)
    await db.query(
      "GRANT USAGE ON SCHEMA demo_sis TO tilwa_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA demo_sis TO tilwa_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA demo_sis TO tilwa_runtime;",
    );
  return applied;
}
