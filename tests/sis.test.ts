import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import {
  LocalDemoSisAdapter,
  ExternalContractSisAdapter,
  SisResultSchema,
  applySisEvent,
  demoSisEvents,
  getOfficialGrades,
  syncSis,
  verifySisSignature,
  type SisQuery,
  type SisScope,
  type SisResultEvent,
} from "../src/server/sis";

// Real PostgreSQL engine in WASM, explicitly offline: these are not Neon tests.
const pg = new PGlite();
function scoped(tenantId: string): SisScope {
  const transaction = async <T>(fn: (tx: SisQuery) => Promise<T>): Promise<T> =>
    pg.transaction(async (raw) => {
      await raw.query("SET LOCAL ROLE tilwa_sis_test");
      await raw.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      return fn({
        query: async <R>(sql: string, params: unknown[] = []) => ({
          rows: (await raw.query(sql, params)).rows as R[],
        }),
      });
    });
  return {
    transaction,
    query: <T>(sql: string, params: unknown[] = []) =>
      transaction((tx) => tx.query<T>(sql, params)),
  };
}
const store = scoped("tenant-a");
const fixture = demoSisEvents("tenant-a", "registrar-salma")[1];
function revision(
  n: number,
  patch: Partial<SisResultEvent> = {},
): SisResultEvent {
  return { ...fixture, eventId: `result-${n}`, revision: n, ...patch };
}
beforeAll(async () => {
  await pg.waitReady;
  await pg.exec(
    await readFile(
      new URL("../migrations/001_core.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(
    await readFile(
      new URL("../migrations/004_sis.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(`CREATE ROLE tilwa_sis_test NOLOGIN;
    GRANT USAGE ON SCHEMA demo_sis TO tilwa_sis_test;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA demo_sis TO tilwa_sis_test;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA demo_sis TO tilwa_sis_test;
    GRANT SELECT ON records TO tilwa_sis_test;
    INSERT INTO tenants(id,name) VALUES ('tenant-a','Synthetic A'),('tenant-b','Synthetic B');
    INSERT INTO users(tenant_id,id,name) VALUES ('tenant-a','salma','{"ar":"سلمى","en":"Salma"}');
    INSERT INTO records(tenant_id,id,kind,course_id,owner_id,data) VALUES
      ('tenant-a','e1','learning_event','CET351','salma','{"correct":true,"objective":"recall.calculate"}'),
      ('tenant-a','m1','objective_state','CET351','salma','{"score":0.7,"model":"baseline-v1"}'),
      ('tenant-a','r1','recommendation','CET351','salma','{"next":"choose-metric"}');`);
  await store.query(
    `INSERT INTO demo_sis.external_students VALUES ('tenant-a','registrar-salma','salma')`,
  );
  await scoped("tenant-b").query(
    `INSERT INTO demo_sis.external_students VALUES ('tenant-b','registrar-salma','other-salma')`,
  );
}, 30000);
afterAll(() => pg.close());
describe("SIS contract and local PostgreSQL integration (offline, synthetic registrar)", () => {
  it("rejects invalid grades, revoked values, extra private payloads and missing version", () => {
    expect(
      SisResultSchema.safeParse({ ...fixture, grade: 21, scale: 20 }).success,
    ).toBe(false);
    expect(
      SisResultSchema.safeParse({ ...fixture, status: "revoked", grade: 2 })
        .success,
    ).toBe(false);
    expect(
      SisResultSchema.safeParse({ ...fixture, advisorNotes: "private" })
        .success,
    ).toBe(false);
    expect(SisResultSchema.safeParse({ ...fixture, version: 2 }).success).toBe(
      false,
    );
  });
  it("authenticates exact body and timestamp, rejects forgery, expired replay and missing secret", () => {
    const secret = "test-only-secret-with-at-least-32-characters";
    const time = "1794480000";
    const body = JSON.stringify({ events: [fixture] });
    const signature = `sha256=${createHmac("sha256", secret).update(`${time}.${body}`).digest("hex")}`;
    expect(
      verifySisSignature(body, time, signature, secret, Number(time) * 1000),
    ).toBe(true);
    expect(
      verifySisSignature(
        body + " ",
        time,
        signature,
        secret,
        Number(time) * 1000,
      ),
    ).toBe(false);
    expect(
      verifySisSignature(
        body,
        time,
        signature,
        secret,
        Number(time) * 1000 + 300001,
      ),
    ).toBe(false);
    expect(
      verifySisSignature(body, time, signature, undefined, Number(time) * 1000),
    ).toBe(false);
  });
  it("applies approved grade once and audits only one update under retries", async () => {
    expect(await applySisEvent(revision(1), "local-demo", store)).toBe(
      "applied",
    );
    expect(await applySisEvent(revision(1), "local-demo", store)).toBe(
      "duplicate",
    );
    const grades = await getOfficialGrades("tenant-a", "salma", store);
    expect(grades[0]).toMatchObject({
      grade: 17,
      scale: 20,
      revision: 1,
      source: "sis",
      synthetic: true,
    });
    const audit = await store.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM demo_sis.audit_events",
    );
    expect(audit.rows[0].count).toBe(1);
    await expect(
      applySisEvent(revision(1, { grade: 18 }), "local-demo", store),
    ).rejects.toThrow("EVENT_CONFLICT");
  });
  it("handles revised, out-of-order and revoked results without restoring a stale grade", async () => {
    expect(
      await applySisEvent(
        revision(3, { grade: 19 }),
        "external-contract",
        store,
      ),
    ).toBe("applied");
    expect(
      await applySisEvent(
        revision(2, { grade: 18 }),
        "external-contract",
        store,
      ),
    ).toBe("ignored-stale");
    expect(
      await applySisEvent(
        revision(3, { eventId: "same-revision-conflict", grade: 16 }),
        "external-contract",
        store,
      ),
    ).toBe("revision-conflict");
    expect((await getOfficialGrades("tenant-a", "salma", store))[0].grade).toBe(
      19,
    );
    expect(
      await applySisEvent(
        revision(4, { status: "revoked", grade: null }),
        "external-contract",
        store,
      ),
    ).toBe("applied");
    expect(
      await applySisEvent(
        revision(2, { eventId: "old-approved-after-revoke" }),
        "external-contract",
        store,
      ),
    ).toBe("ignored-stale");
    expect(
      (await getOfficialGrades("tenant-a", "salma", store))[0],
    ).toMatchObject({ status: "revoked", grade: null, revision: 4 });
  });
  it("adapter replacement preserves learning history, mastery and recommendations byte-for-byte", async () => {
    const before = await pg.query("SELECT * FROM records ORDER BY id");
    const fixtures = demoSisEvents("tenant-a", "registrar-salma").map((e) => ({
      ...e,
      eventId: `swap:${e.eventId}`,
      revision: 5,
    }));
    await syncSis(new LocalDemoSisAdapter(fixtures), "tenant-a", store);
    const afterLocal = await getOfficialGrades("tenant-a", "salma", store);
    const results = await syncSis(
      new ExternalContractSisAdapter(fixtures),
      "tenant-a",
      store,
    );
    expect(results.every((x) => x.disposition === "duplicate")).toBe(true);
    expect(await getOfficialGrades("tenant-a", "salma", store)).toEqual(
      afterLocal,
    );
    expect((await pg.query("SELECT * FROM records ORDER BY id")).rows).toEqual(
      before.rows,
    );
  });
  it("tenant RLS and student mappings isolate an identical registrar identifier under a non-owner role", async () => {
    expect(
      await getOfficialGrades("tenant-b", "other-salma", scoped("tenant-b")),
    ).toEqual([]);
    expect(
      (
        await scoped("tenant-b").query(
          "SELECT * FROM demo_sis.result_projections WHERE tenant_id=$1",
          ["tenant-a"],
        )
      ).rows,
    ).toEqual([]);
    await expect(
      applySisEvent(
        { ...revision(8), externalStudentId: "unknown" },
        "external-contract",
        store,
      ),
    ).rejects.toThrow("UNKNOWN_STUDENT");
    await expect(
      syncSis(
        new ExternalContractSisAdapter([fixture]),
        "tenant-b",
        scoped("tenant-b"),
      ),
    ).rejects.toThrow("TENANT_MISMATCH");
    await expect(
      applySisEvent(
        { ...revision(8), tenantId: "tenant-a" },
        "external-contract",
        scoped("tenant-b"),
      ),
    ).rejects.toThrow("UNKNOWN_STUDENT");
    expect(await getOfficialGrades("tenant-a", "other-salma", store)).toEqual(
      [],
    );
  });
});
