import { db } from "../src/server/db";
import { migrateDatabase } from "../src/server/migrate";
async function main() {
  if (process.env.MIGRATION_DATABASE_URL)
    process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
  try {
    const applied = await migrateDatabase();
    console.log(
      JSON.stringify({
        database:
          process.env.LOCAL_DATABASE === "1"
            ? "local-postgresql-wasm"
            : "postgresql",
        migrations: applied,
        status: "passed",
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "Migration failed",
      }),
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
void main();
