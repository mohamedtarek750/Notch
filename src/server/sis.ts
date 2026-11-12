import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "./db";

/** Contract v1 is the only boundary to a registrar. It carries no learning state. */
export const SisResultSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.string().min(1).max(100),
    eventId: z.string().min(1).max(150),
    externalStudentId: z.string().min(1).max(100),
    courseId: z.string().min(1).max(80),
    semester: z.string().min(1).max(80),
    assessmentId: z.string().min(1).max(100),
    revision: z.number().int().positive().max(2147483647),
    status: z.enum(["approved", "revoked"]),
    grade: z.number().finite().nonnegative().nullable(),
    scale: z.number().finite().positive().max(10000),
    occurredAt: z.string().datetime(),
    synthetic: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "revoked" && value.grade !== null)
      ctx.addIssue({
        code: "custom",
        message: "Revoked results must have no grade",
        path: ["grade"],
      });
    if (
      value.status === "approved" &&
      (value.grade === null || value.grade > value.scale)
    )
      ctx.addIssue({
        code: "custom",
        message: "Approved grade must fit the scale",
        path: ["grade"],
      });
  });
export type SisResultEvent = z.infer<typeof SisResultSchema>;
export type SisAdapterId = "local-demo" | "external-contract";
export type SisDisposition =
  "applied" | "duplicate" | "ignored-stale" | "revision-conflict";
export interface SisPort {
  readonly id: SisAdapterId;
  readonly description: string;
  events(): AsyncIterable<SisResultEvent>;
}
export interface SisQuery {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface SisScope extends SisQuery {
  transaction<T>(work: (tx: SisQuery) => Promise<T>): Promise<T>;
}

/** Explicitly synthetic registrar adapter. It cannot write learning records. */
export class LocalDemoSisAdapter implements SisPort {
  readonly id = "local-demo" as const;
  readonly description =
    "Synthetic local registrar / مسجّل تجريبي ببيانات مصطنعة";
  constructor(private readonly fixtures: readonly SisResultEvent[]) {}
  async *events() {
    for (const event of this.fixtures)
      yield SisResultSchema.parse({ ...event, synthetic: true });
  }
}
/** Contract fixture or verified webhook payloads, never a claim of a university connection. */
export class ExternalContractSisAdapter implements SisPort {
  readonly id = "external-contract" as const;
  readonly description =
    "Versioned registrar contract / عقد تكامل مسجّل بإصدار محدد";
  constructor(private readonly payloads: readonly unknown[]) {}
  async *events() {
    for (const payload of this.payloads) yield SisResultSchema.parse(payload);
  }
}
function scope(tenantId: string): SisScope {
  return db.tenant(tenantId) as SisScope;
}
function eventHash(event: SisResultEvent): string {
  // Schema.parse creates the same field order even when incoming JSON key order differs.
  return createHash("sha256")
    .update(JSON.stringify(SisResultSchema.parse(event)))
    .digest("hex");
}
export class SisContractError extends Error {
  constructor(
    public readonly code:
      "UNKNOWN_STUDENT" | "EVENT_CONFLICT" | "TENANT_MISMATCH",
  ) {
    super(code);
  }
}

export async function applySisEvent(
  raw: unknown,
  adapter: SisAdapterId,
  store?: SisScope,
): Promise<SisDisposition> {
  const event = SisResultSchema.parse(raw);
  const sql = store ?? scope(event.tenantId);
  return sql.transaction(async (tx) => {
    const mapping = await tx.query(
      "SELECT user_id FROM demo_sis.external_students WHERE tenant_id=$1 AND external_student_id=$2",
      [event.tenantId, event.externalStudentId],
    );
    if (!mapping.rows.length) throw new SisContractError("UNKNOWN_STUDENT");
    const hash = eventHash(event);
    const inserted = await tx.query(
      `INSERT INTO demo_sis.integration_inbox
      (tenant_id,event_id,external_student_id,course_id,semester,assessment_id,revision,payload,payload_hash,adapter,disposition)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'pending') ON CONFLICT DO NOTHING RETURNING event_id`,
      [
        event.tenantId,
        event.eventId,
        event.externalStudentId,
        event.courseId,
        event.semester,
        event.assessmentId,
        event.revision,
        JSON.stringify(event),
        hash,
        adapter,
      ],
    );
    if (!inserted.rows.length) {
      const prior = await tx.query<{ payload_hash: string }>(
        "SELECT payload_hash FROM demo_sis.integration_inbox WHERE tenant_id=$1 AND event_id=$2",
        [event.tenantId, event.eventId],
      );
      if (prior.rows[0]?.payload_hash !== hash)
        throw new SisContractError("EVENT_CONFLICT");
      return "duplicate";
    }
    const key = [
      event.tenantId,
      event.externalStudentId,
      event.courseId,
      event.semester,
      event.assessmentId,
    ];
    const before = await tx.query<{ revision: number }>(
      `SELECT revision FROM demo_sis.result_projections WHERE tenant_id=$1 AND external_student_id=$2 AND course_id=$3 AND semester=$4 AND assessment_id=$5 FOR UPDATE`,
      key,
    );
    // Monotonic upsert remains safe if concurrent transactions insert the first projection.
    const updated = await tx.query<{ revision: number }>(
      `INSERT INTO demo_sis.result_projections
      (tenant_id,external_student_id,course_id,semester,assessment_id,revision,status,grade,scale,occurred_at,event_id,synthetic,adapter)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (tenant_id,external_student_id,course_id,semester,assessment_id) DO UPDATE SET
      revision=excluded.revision,status=excluded.status,grade=excluded.grade,scale=excluded.scale,
      occurred_at=excluded.occurred_at,event_id=excluded.event_id,synthetic=excluded.synthetic,adapter=excluded.adapter
      WHERE demo_sis.result_projections.revision < excluded.revision RETURNING revision`,
      [
        ...key,
        event.revision,
        event.status,
        event.grade,
        event.scale,
        event.occurredAt,
        event.eventId,
        event.synthetic,
        adapter,
      ],
    );
    let disposition: SisDisposition = "applied";
    if (!updated.rows.length) {
      const current = await tx.query<{ revision: number }>(
        "SELECT revision FROM demo_sis.result_projections WHERE tenant_id=$1 AND external_student_id=$2 AND course_id=$3 AND semester=$4 AND assessment_id=$5",
        key,
      );
      disposition =
        current.rows[0]?.revision === event.revision
          ? "revision-conflict"
          : "ignored-stale";
    }
    await tx.query(
      "UPDATE demo_sis.integration_inbox SET disposition=$3 WHERE tenant_id=$1 AND event_id=$2",
      [event.tenantId, event.eventId, disposition],
    );
    await tx.query(
      `INSERT INTO demo_sis.audit_events (tenant_id,event_id,action,before_revision,after_revision,adapter) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        event.tenantId,
        event.eventId,
        disposition,
        before.rows[0]?.revision ?? null,
        updated.rows[0]?.revision ?? before.rows[0]?.revision ?? null,
        adapter,
      ],
    );
    return disposition;
  });
}
export async function syncSis(
  port: SisPort,
  tenantId: string,
  store?: SisScope,
): Promise<{ eventId: string; disposition: SisDisposition }[]> {
  const results: { eventId: string; disposition: SisDisposition }[] = [];
  for await (const event of port.events()) {
    if (event.tenantId !== tenantId)
      throw new SisContractError("TENANT_MISMATCH");
    if (results.length >= 100) throw new Error("SIS_BATCH_LIMIT");
    results.push({
      eventId: event.eventId,
      disposition: await applySisEvent(event, port.id, store),
    });
  }
  return results;
}

export interface OfficialGrade {
  id: string;
  courseId: string;
  semester: string;
  assessmentId: string;
  grade: number | null;
  scale: number;
  status: "approved" | "revoked";
  revision: number;
  occurredAt: string;
  synthetic: boolean;
  source: "sis";
  adapter: SisAdapterId;
}
export async function getOfficialGrades(
  tenantId: string,
  userId: string,
  store?: SisScope,
): Promise<OfficialGrade[]> {
  const result = await (store ?? scope(tenantId)).query<{
    event_id: string;
    course_id: string;
    semester: string;
    assessment_id: string;
    grade: string | number | null;
    scale: string | number;
    status: "approved" | "revoked";
    revision: number;
    occurred_at: string | Date;
    synthetic: boolean;
    adapter: SisAdapterId;
  }>(
    `SELECT r.* FROM demo_sis.result_projections r JOIN demo_sis.external_students m
    ON r.tenant_id=m.tenant_id AND r.external_student_id=m.external_student_id WHERE r.tenant_id=$1 AND m.user_id=$2 ORDER BY semester DESC, course_id`,
    [tenantId, userId],
  );
  return result.rows.map((r) => ({
    id: r.event_id,
    courseId: r.course_id,
    semester: r.semester,
    assessmentId: r.assessment_id,
    grade: r.grade === null ? null : Number(r.grade),
    scale: Number(r.scale),
    status: r.status,
    revision: r.revision,
    occurredAt: new Date(r.occurred_at).toISOString(),
    synthetic: r.synthetic,
    source: "sis",
    adapter: r.adapter,
  }));
}

/** Signature covers the exact request bytes and timestamp; replay is bounded and inbox deduplicated. */
export function verifySisSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (
    !secret ||
    secret.length < 32 ||
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature)
  )
    return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 300000) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  const received = Buffer.from(signature.slice(7), "hex");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
export function demoSisEvents(
  tenantId: string,
  externalStudentId: string,
): SisResultEvent[] {
  return [
    {
      version: 1,
      tenantId,
      eventId: "demo-calculus-2025-v1",
      externalStudentId,
      courseId: "MATH201",
      semester: "2025-S2",
      assessmentId: "final",
      revision: 1,
      status: "approved",
      grade: 84,
      scale: 100,
      occurredAt: "2025-06-30T12:00:00.000Z",
      synthetic: true,
    },
    {
      version: 1,
      tenantId,
      eventId: "demo-cet351-2026-v1",
      externalStudentId,
      courseId: "CET351",
      semester: "2026-S1",
      assessmentId: "midterm",
      revision: 1,
      status: "approved",
      grade: 17,
      scale: 20,
      occurredAt: "2026-11-01T12:00:00.000Z",
      synthetic: true,
    },
  ];
}
export async function seedSis(
  tenantId: string,
  studentId: string,
): Promise<void> {
  const sql = scope(tenantId);
  const externalId = `demo:${studentId}`;
  await sql.query(
    "INSERT INTO demo_sis.external_students(tenant_id,external_student_id,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [tenantId, externalId, studentId],
  );
  await syncSis(
    new LocalDemoSisAdapter(demoSisEvents(tenantId, externalId)),
    tenantId,
  );
}
