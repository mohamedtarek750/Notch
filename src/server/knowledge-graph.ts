import { z } from "zod";
import { authorizeCourseInTransaction, type AuthContext } from "./auth";
import { db, type Queryable } from "./db";
import { SourceError } from "./sources";
import {
  semanticRelations, type KGDetail, type KGEdge, type KGKind, type KGNode, type KGText, type KGView,
} from "../lib/knowledge-graph";

const kinds = ["major", "course", "lecture", "concept"] as const;
const key = z.string().min(1).max(200);
const input = z.object({
  level: z.enum(kinds).optional(), kind: z.enum(kinds).optional(), id: key.optional(),
  majorId: key.optional(), courseId: key.optional(), lectureId: key.optional(),
  cursor: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
const PAGE = 30;
const unassigned = "~unassigned";
const text = (v: KGText | string | null, fallback: string): KGText =>
  v && typeof v === "object" ? { en: v.en || fallback, ar: v.ar || fallback } :
    { en: v || fallback, ar: v || fallback };
type Row = { id: string; label: KGText | string; major_id?: string; course_id?: string; code?: string };
function node(kind: KGKind, r: Row): KGNode {
  return { kind, id: r.id, label: text(r.label, r.id),
    ...(r.major_id && { majorId: r.major_id }), ...(r.course_id && { courseId: r.course_id }),
    ...(r.code && { code: r.code }), ...(kind === "lecture" && { lectureId: r.id }) };
}
const lectureKey = `CASE WHEN v.metadata->>'documentPages' IS NOT NULL AND
  COALESCE(NULLIF(v.metadata->>'firstPage',''),'1') <> '' AND
  ((v.metadata->>'firstPage')::int > 1 OR (v.metadata->>'lastPage')::int < (v.metadata->>'documentPages')::int)
  THEN COALESCE(v.metadata->>'documentHash',v.source_key) ELSE v.source_key END`;

// Every query, including reverse lookups from external concepts, starts from active access.
const visible = `WITH visible AS (
  SELECT a.course_id, COALESCE(m.id,'~unassigned') major_id, m.data->'name' major_label,
    COALESCE(c.data->'title',to_jsonb(a.course_id)) label, COALESCE(c.data->>'code',a.course_id) code,
    COALESCE(c.data->'prerequisites','[]') prerequisites
  FROM course_access a JOIN memberships u ON u.tenant_id=a.tenant_id AND u.user_id=a.user_id
  LEFT JOIN records c ON c.tenant_id=a.tenant_id AND c.kind='course' AND c.course_id=a.course_id
  LEFT JOIN records m ON m.tenant_id=a.tenant_id AND m.kind='major' AND m.id=c.data->>'majorId'
  WHERE a.tenant_id=$1 AND a.user_id=$2 AND u.role=$3 AND u.active AND a.active
)`;
const lectureRows = `SELECT DISTINCT ON (v.course_id,${lectureKey}) ${lectureKey} id,
  COALESCE(v.metadata->>'originalFilename',v.title) label,v.course_id,a.major_id
  FROM material_versions v JOIN visible a ON a.course_id=v.course_id
  WHERE v.tenant_id=$1 AND v.current_version AND v.role='instructor'`;
const evidenceJoins = `FROM km_citations k
  JOIN visible a ON a.course_id=k.course_id
  JOIN evidence_chunks e ON e.tenant_id=k.tenant_id AND e.id=k.evidence_id AND e.status='approved'
  JOIN material_versions v ON v.tenant_id=e.tenant_id AND v.id=e.version_id AND v.current_version
  JOIN visible material_access ON material_access.course_id=v.course_id
  WHERE k.tenant_id=$1 AND v.rights->>'displayExcerpt'='true'`;
type StoredEdge = { source: string; target: string; kind: keyof typeof semanticRelations };
const mapEdge = (e: StoredEdge): KGEdge => ({ from: e.source, to: e.target, type: semanticRelations[e.kind] });
const contains = (parent: KGNode, children: KGNode[]): KGEdge[] =>
  children.map((child) => ({ from: parent.id, to: child.id, type: "CONTAINS" }));
const emptyDetail = (n: KGNode): KGDetail => ({ node: n, aliases: [], parents: [], children: [], relations: [], resources: [] });
const missing = (): never => { throw new SourceError("source_missing", 404); };

export async function readKnowledgeGraph(ctx: AuthContext, params: URLSearchParams) {
  const q = input.parse(Object.fromEntries(params));
  if (!(q.level || (q.kind && q.id))) throw new SourceError("invalid_input", 400);
  return db.tenant(ctx.tenantId).transaction(async (tx) => {
    await authorizeCourseInTransaction(ctx, q.courseId || ctx.courseId, "read", tx);
    return graphReader(tx, ctx, q);
  });
}

async function graphReader(tx: Queryable, ctx: AuthContext, q: z.infer<typeof input>) {
  const rows = async <T>(sql: string, args: unknown[] = []) =>
    (await tx.query<T>(visible + " " + sql, [ctx.tenantId, ctx.userId, ctx.role, ...args])).rows;
  const majors = async (id?: string) => (await rows<Row>(
    `SELECT DISTINCT major_id id, major_id, COALESCE(major_label,'{"en":"Unassigned courses","ar":"مقررات غير مصنفة"}'::jsonb) label
     FROM visible WHERE ($4::text IS NULL OR major_id=$4) ORDER BY id LIMIT $5 OFFSET $6`, [id ?? null, PAGE+1, id ? 0 : q.cursor],
  )).map(r=>node("major",r));
  const courses = async (major?: string, id?: string, offset=0) => (await rows<Row>(
    `SELECT course_id id,course_id,label,major_id,code FROM visible
     WHERE ($4::text IS NULL OR major_id=$4) AND ($5::text IS NULL OR course_id=$5)
     ORDER BY id LIMIT $6 OFFSET $7`, [major ?? null,id ?? null,PAGE+1,offset],
  )).map(r=>node("course",r));
  const lectures = async (course: string, id?: string, offset=0) => (await rows<Row>(
    `${lectureRows} AND v.course_id=$4 AND ($5::text IS NULL OR ${lectureKey}=$5)
     ORDER BY v.course_id,${lectureKey},v.created_at LIMIT $6 OFFSET $7`, [course,id??null,PAGE+1,offset],
  )).map(r=>node("lecture",r));
  const lectureConcepts = async (course: string, lecture: string, offset=0) => (await rows<Row>(
    `SELECT DISTINCT k.concept_id id,m.data->'label' label,k.course_id,a.major_id
     FROM km_memberships m JOIN (
       SELECT DISTINCT k.course_id,k.concept_id ${evidenceJoins} AND k.course_id=$4 AND v.course_id=$4
       AND v.role='instructor' AND ${lectureKey}=$5
     ) k ON k.course_id=m.course_id AND k.concept_id=m.concept_id
     JOIN visible a ON a.course_id=k.course_id WHERE m.tenant_id=$1 AND COALESCE(m.data->>'scope','course') <> 'foundation'
     ORDER BY id LIMIT $6 OFFSET $7`, [course,lecture,PAGE+1,offset],
  )).map(r=>({...node("concept",r),lectureId:lecture,external:false}));
  const conceptNodes = async (ids: string[], preferred?: string) => (await rows<Row>(
    `SELECT DISTINCT ON (m.concept_id) m.concept_id id,m.data->'label' label,m.course_id,a.major_id
     FROM km_memberships m JOIN visible a ON a.course_id=m.course_id
     WHERE m.tenant_id=$1 AND m.concept_id=ANY($4::text[])
     ORDER BY m.concept_id,(COALESCE(m.data->>'scope','course')='foundation'),(m.course_id=$5) DESC,m.course_id`,
    [ids,preferred??null],
  )).map(r=>node("concept",r));
  const adjacent = async (ids: string[]) => (await rows<StoredEdge>(
    `SELECT DISTINCT e.source,e.target,e.kind FROM km_edges e JOIN visible a ON a.course_id=e.course_id
     WHERE e.tenant_id=$1 AND (e.source=ANY($4::text[]) OR e.target=ANY($4::text[]))
     ORDER BY e.kind,e.source,e.target LIMIT 150`, [ids],
  )).map(mapEdge);
  const courseLinks = async (ids: string[], both: boolean) => (await rows<StoredEdge>(
    `SELECT DISTINCT s.source,s.target,'prerequisite' kind FROM (
       SELECT p.id source,a.course_id target FROM visible a CROSS JOIN LATERAL jsonb_array_elements_text(a.prerequisites) p(id)
       JOIN visible before ON before.course_id=p.id
       UNION
       SELECT base.course_id,e.course_id FROM km_edges e
       JOIN visible a ON a.course_id=e.course_id
       JOIN km_memberships here ON here.tenant_id=e.tenant_id AND here.course_id=e.course_id AND here.concept_id=e.source
       JOIN km_memberships base ON base.tenant_id=e.tenant_id AND base.concept_id=e.source
       JOIN visible b ON b.course_id=base.course_id
       JOIN km_memberships target ON target.tenant_id=e.tenant_id AND target.course_id=e.course_id AND target.concept_id=e.target
       WHERE e.tenant_id=$1 AND e.kind='prerequisite' AND here.data->>'scope'='foundation'
       AND COALESCE(base.data->>'scope','course')<>'foundation' AND COALESCE(target.data->>'scope','course')<>'foundation'
     ) s WHERE s.source<>s.target AND
       (CASE WHEN $5::boolean THEN s.source=ANY($4::text[]) AND s.target=ANY($4::text[])
       ELSE s.source=ANY($4::text[]) OR s.target=ANY($4::text[]) END)
     ORDER BY source,target LIMIT 100`, [ids,both],
  )).map(mapEdge);
  const view = (children: KGNode[], parent?: KGNode): KGView => {
    const nextCursor = children.length>PAGE ? q.cursor+PAGE : null;
    const page = children.slice(0,PAGE);
    return {nodes: parent ? [parent,...page] : page,edges:parent ? contains(parent,page) : [],nextCursor};
  };
  const lectureView = async (course: string, lecture: string, offset: number) => {
    const parent = (await lectures(course,lecture))[0] ?? missing();
    const data = view(await lectureConcepts(course,lecture,offset),parent);
    const direct = data.nodes.filter(n=>n.kind==="concept").map(n=>n.id);
    const edges = direct.length ? await adjacent(direct) : [];
    const externalIds = [...new Set(edges.flatMap(e=>[e.from,e.to]).filter(id=>!direct.includes(id)))];
    // A direct concept shown on another page remains direct here too.
    const alsoDirect = externalIds.length ? new Set((await rows<{id:string}>(
      `SELECT DISTINCT k.concept_id id ${evidenceJoins} AND k.course_id=$4 AND v.course_id=$4
       AND v.role='instructor' AND ${lectureKey}=$5 AND k.concept_id=ANY($6::text[])
       AND EXISTS (SELECT 1 FROM km_memberships m WHERE m.tenant_id=k.tenant_id AND m.course_id=k.course_id
       AND m.concept_id=k.concept_id AND COALESCE(m.data->>'scope','course')<>'foundation')`,
      [course,lecture,externalIds],
    )).map(r=>r.id)) : new Set<string>();
    const neighbors = (await conceptNodes(externalIds.slice(0,PAGE),course))
      .map(n=>({...n,external:!alsoDirect.has(n.id)}));
    data.nodes.push(...neighbors);
    data.edges.push(...contains(parent,neighbors.filter(n=>!n.external)));
    const present = new Set(data.nodes.map(n=>n.id));
    data.edges.push(...edges.filter(e=>present.has(e.from)&&present.has(e.to)));
    return data;
  };
  if (!q.kind) {
    if (q.level==="major") return view(await majors());
    if (q.level==="course" && q.majorId) {
      const parent = (await majors(q.majorId))[0] ?? missing();
      const data = view(await courses(q.majorId,undefined,q.cursor),parent);
      data.edges.push(...await courseLinks(data.nodes.filter(n=>n.kind==="course").map(n=>n.id),true));
      return data;
    }
    if (q.level==="lecture" && q.courseId) return view(await lectures(q.courseId,undefined,q.cursor),(await courses(undefined,q.courseId))[0] ?? missing());
    if (q.level==="concept" && q.courseId && q.lectureId) return lectureView(q.courseId,q.lectureId,q.cursor);
    throw new SourceError("invalid_input",400);
  }
  const id = q.id ?? missing();
  if (q.kind==="major") {
    const detail = emptyDetail((await majors(id))[0] ?? missing());
    detail.children = (await courses(id)).slice(0,PAGE);
    return detail;
  }
  if (q.kind==="course") {
    const course = (await courses(undefined,id))[0] ?? missing();
    const detail = emptyDetail(course);
    detail.parents = await majors(course.majorId);
    detail.children = (await lectures(id)).slice(0,PAGE);
    const links = await courseLinks([id],false);
    const other = [...new Set(links.flatMap(e=>[e.from,e.to]).filter(n=>n!==id))];
    const siblings = (await rows<Row>("SELECT course_id id,course_id,label,major_id,code FROM visible WHERE course_id=ANY($4::text[])",[other])).map(r=>node("course",r));
    for(const e of links) {
      const n=siblings.find(n=>n.id===(e.from===id?e.to:e.from));
      if(n) detail.relations.push({node:n,type:e.type,direction:e.from===id?"out":"in"});
    }
    detail.resources = await rows(`SELECT v.id,v.title,v.course_id AS "courseId", NULL::int page,NULL::text section
      FROM material_versions v JOIN visible a ON a.course_id=v.course_id WHERE v.tenant_id=$1 AND v.course_id=$4
      AND v.current_version AND v.role='umbrella' AND v.rights->>'displayExcerpt'='true' ORDER BY v.title,v.id LIMIT 100`,[id]);
    return detail;
  }
  if (q.kind==="lecture" && q.courseId) {
    const data=await lectureView(q.courseId,id,0);
    const detail=emptyDetail(data.nodes[0]);
    detail.parents=await courses(undefined,q.courseId);
    detail.children=data.nodes.filter(n=>n.kind==="concept"&&!n.external);
    const direct=new Set(detail.children.map(n=>n.id));
    for(const e of data.edges.filter(e=>e.type!=="CONTAINS")) {
      const n=data.nodes.find(n=>n.external && (n.id===e.from||n.id===e.to));
      if(n) detail.relations.push({node:n,type:e.type,direction:direct.has(e.to)?"in":"out"});
    }
    const related = await rows<Row>(`SELECT DISTINCT ${lectureKey} id,v.title label,v.course_id,material_access.major_id
      ${evidenceJoins} AND v.role='instructor' AND v.course_id=k.course_id AND k.concept_id=ANY($4::text[])
      AND NOT (v.course_id=$5 AND ${lectureKey}=$6) ORDER BY v.course_id,id LIMIT 30`,
      [[...new Set(data.nodes.filter(n=>n.kind==="concept").map(n=>n.id))],q.courseId,id]);
    for (const r of related) detail.relations.push({node:node("lecture",r),type:"RELATED_TO",direction:"out"});
    detail.resources=await rows(`SELECT v.id,v.title,v.course_id "courseId",NULL::int page,NULL::text section FROM material_versions v
      JOIN visible a ON a.course_id=v.course_id WHERE v.tenant_id=$1 AND v.course_id=$4 AND v.current_version
      AND v.role='instructor' AND ${lectureKey}=$5 AND v.rights->>'displayExcerpt'='true' ORDER BY v.id LIMIT 100`,[q.courseId,id]);
    return detail;
  }
  if (q.kind!=="concept") throw new SourceError("invalid_input",400);
  const concept=(await conceptNodes([id],q.courseId))[0]??missing();
  const detail=emptyDetail(concept);
  const facts=await rows<{data:{summary?:KGText;aliases?:string[]};has_evidence:boolean}>(
    `SELECT m.data,EXISTS(SELECT 1 ${evidenceJoins} AND k.course_id=m.course_id AND k.concept_id=m.concept_id) has_evidence
     FROM km_memberships m JOIN visible a ON a.course_id=m.course_id WHERE m.tenant_id=$1 AND m.concept_id=$4
     ORDER BY (m.course_id=$5) DESC,m.course_id`,[id,concept.courseId]);
  detail.definition=facts.find(f=>f.has_evidence&&f.data.summary)?.data.summary;
  detail.aliases=[...new Set(facts.flatMap(f=>f.data.aliases??[]))];
  const locations=await rows<Row>(`SELECT DISTINCT ${lectureKey} id,COALESCE(v.metadata->>'originalFilename',v.title) label,v.course_id,material_access.major_id
    ${evidenceJoins} AND k.concept_id=$4 AND v.role='instructor' AND v.course_id=k.course_id
    AND EXISTS (SELECT 1 FROM km_memberships m WHERE m.tenant_id=k.tenant_id AND m.course_id=k.course_id AND m.concept_id=k.concept_id AND COALESCE(m.data->>'scope','course')<>'foundation')
    ORDER BY v.course_id,id LIMIT 100`,[id]);
  detail.parents=locations.map(r=>node("lecture",r));
  const academic=await rows<Row>(`SELECT a.course_id id,a.course_id,a.label,a.major_id,a.code FROM km_memberships m
    JOIN visible a ON a.course_id=m.course_id WHERE m.tenant_id=$1 AND m.concept_id=$4 AND COALESCE(m.data->>'scope','course')<>'foundation' ORDER BY a.course_id LIMIT 100`,[id]);
  detail.parents.push(...academic.map(r=>node("course",r)));
  detail.node.external=!locations.some(r=>r.course_id===(q.courseId??concept.courseId)&&(!q.lectureId||r.id===q.lectureId));
  detail.resources=await rows(`SELECT DISTINCT v.id,v.title,v.course_id "courseId",e.page,e.section,left(e.text_content,420) excerpt
    ${evidenceJoins} AND k.concept_id=$4 ORDER BY v.title,e.page,e.section LIMIT 100`,[id]);
  const links=await adjacent([id]);
  const neighbors=await conceptNodes([...new Set(links.flatMap(e=>[e.from,e.to]).filter(n=>n!==id))],q.courseId);
  for(const e of links) {
    const n=neighbors.find(n=>n.id===(e.to===id?e.from:e.to));
    if(n) detail.relations.push({node:n,type:e.type,direction:e.to===id?"in":"out"});
  }
  return detail;
}
