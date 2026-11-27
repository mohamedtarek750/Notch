"use client";
import { useEffect, useState } from "react";
import { request, type Translate } from "./Workspace";
import { KnowledgeTree } from "./KnowledgeTree";
import { BookOpen, GraduationCap, Lightbulb, PlayCircle, ChevronRight } from "lucide-react";

type Lang = "en" | "ar";
type Named = { en: string; ar: string };
type Data = {
  current: string;
  majors: { id: string; name: Named }[];
  courses: { id: string; code: string; title: Named; majorId: string | null; prerequisites?: string[] }[];
  materials: { id: string; courseId: string; title: string; role: string; versionIds: string[]; conceptIds: string[] }[];
  concepts: { id: string; label: Named; scope?: string; courses: string[]; mentionedIn: string[] }[];
  edges: { from: string; to: string; type: string; reason?: Named; courses: string[] }[];
};
const palette = { major: ["#dbeafe","#4168b4"], course: ["#dbeafe","#4168b4"], lecture: ["#ede9fe","#8061cc"], concept: ["#e6f6eb","#3b8b61"] };
type Level = keyof typeof palette;
export function HierarchicalKnowledgeMap({ lang, t, onError, go, courseId }: { lang: Lang; t: Translate; onError: (message: string) => void; go: (view: string) => void; courseId?: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [scope, setScope] = useState<"major"|"university">("major");
  const [major, setMajor] = useState("");
  const [course, setCourse] = useState("");
  const [lecture, setLecture] = useState("");
  const [concept, setConcept] = useState("");
  const [editor, setEditor] = useState(false);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let active = true;
    request("/api/catalog?tree=" + scope, undefined, lang, courseId).then((d: Data) => {
      if (!active) return;
      setData(d);
      setMajor(d.courses.find(c => c.id === (courseId || d.current))?.majorId || d.majors[0]?.id || "");
      setCourse(""); setLecture(""); setConcept("");
    }).catch(e => active && onError(e.message));
    return () => { active = false; };
  }, [scope, lang, courseId, onError]);
  if (editor) return <><button className="textbtn" onClick={() => setEditor(false)}>{t("العودة للخريطة الهرمية","Back to hierarchy")}</button><KnowledgeTree lang={lang} t={t} onError={onError} go={go} courseId={courseId} initialScope="major" /></>;
  if (!data) return <p role="status">{t("جارٍ التحميل…","Loading…")}</p>;
  const courses = data.courses.filter(c => !major || c.majorId === major);
  const lectures = data.materials.filter(m => m.role === "instructor" && m.courseId === course);
  const selectedLecture = lectures.find(m => m.id === lecture);
  const selectedCourse = data.courses.find(c => c.id === course);
  const selectedConcept = data.concepts.find(c => c.id === concept);
  const shown = data.concepts.filter(c => selectedLecture ? selectedLecture.conceptIds.includes(c.id) : course && c.courses.includes(course));
  const byId = (id: string) => data.concepts.find(c => c.id === id)?.label[lang] || id;
  const edgeName = (type: string) => type === "prerequisite" ? t("متطلب سابق","Prerequisite") : type === "optional_bridge" ? t("خلفية اختيارية","Optional background") : t("مرتبط بـ","Related");
  const edges = data.edges.filter(e => concept ? e.from === concept || e.to === concept : shown.some(c => c.id === e.from || c.id === e.to));
  const node = (level: Level, id: string, title: string, active: boolean, click: () => void) => {
    const Icon = {major:GraduationCap,course:BookOpen,lecture:PlayCircle,concept:Lightbulb}[level];
    const [fill, border] = palette[level];
    return <button key={id} type="button" aria-pressed={active} onClick={click} style={{background:fill,color:"#15254a",border: (active?"3px":"1px")+" solid "+border,borderRadius:12,padding:"13px 16px",minWidth:155,maxWidth:220,display:"flex",alignItems:"center",gap:10,textAlign:"start",boxShadow:active?"0 0 0 3px "+border+"30":"none"}}><Icon size={22}/><span><strong>{title}</strong><br/><small>{level === "major"?t("تخصص","Major"):level === "course"?t("مقرر","Course"):level === "lecture"?t("محاضرة","Lecture"):t("مفهوم","Concept")}</small></span></button>;
  };
  const tier = (children: React.ReactNode) => <div style={{display:"flex",justifyContent:"center",gap:14,flexWrap:"wrap",position:"relative",padding:"10px 0"}}>{children}</div>;
  const connector = () => <div aria-hidden="true" style={{textAlign:"center",fontSize:25,color:"#65729c"}}>↓</div>;
  const resources = data.materials.filter(m => m.courseId === course && (m.role === "umbrella" || m.id === lecture));
  return <section>
    <h1>{t("خريطة المعرفة","Knowledge graph")}</h1>
    <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:16}}>
      <select aria-label={t("نطاق العرض","View scope")} value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="major">{t("التخصص","Major")}</option><option value="university">{t("الجامعة","University")}</option></select>
      {data.majors.length > 1 && <select aria-label={t("التخصص","Major")} value={major} onChange={e=>{setMajor(e.target.value);setCourse("");setLecture("");setConcept("");}}>{data.majors.map(m=><option key={m.id} value={m.id}>{m.name[lang]}</option>)}</select>}
      <button onClick={()=>{setCourse("");setLecture("");setConcept("");}}>{t("المقررات","Courses")}</button><ChevronRight size={15}/><button disabled={!course} onClick={()=>{setLecture("");setConcept("");}}>{t("المحاضرات","Lectures")}</button><ChevronRight size={15}/><button disabled={!lecture} onClick={()=>setConcept("")}>{t("المفاهيم","Concepts")}</button>
      <button onClick={()=>setZoom(z=>Math.max(.6,z-.1))}>−</button><button onClick={()=>setZoom(1)}>{Math.round(zoom*100)}%</button><button onClick={()=>setZoom(z=>Math.min(1.8,z+.1))}>+</button>
      <button onClick={()=>setEditor(true)}>{t("محرر العلاقات","Relationship editor")}</button>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,320px),1fr))",gap:16,alignItems:"start"}}>
      <div style={{border:"1px solid #dbe1ee",borderRadius:14,background:"#f9fbff",padding:18,overflow:"auto",minHeight:450}}>
        <div style={{zoom}}>
          {tier(node("major",major,data.majors.find(m=>m.id===major)?.name[lang] || t("المقررات","Courses"),true,()=>{setCourse("");setLecture("");setConcept("");}))}
          {connector()}
          {tier(courses.map(c=>node("course",c.id,c.title?.[lang]||c.code,c.id===course,()=>{setCourse(c.id);setLecture("");setConcept("");})))}
          {course && <>{connector()}{tier(lectures.length?lectures.map(m=>node("lecture",m.id,m.title,m.id===lecture,()=>{setLecture(m.id);setConcept("");})): <small>{t("لا توجد محاضرات","No lectures uploaded")}</small>)}{connector()}{tier(shown.map(c=>node("concept",c.id,c.label[lang],c.id===concept,()=>setConcept(c.id))))}</>}
        </div>
        <div style={{marginTop:20,fontSize:12,color:"#53617d"}}>{t("الخط الرأسي: يحتوي على · العلاقات العلمية في لوحة التفاصيل","Vertical hierarchy: contains · Scientific relationships in details")}</div>
      </div>
      <aside style={{border:"1px solid #dbe1ee",borderRadius:14,padding:18}}>
        <h2>{selectedConcept?.label[lang] || selectedLecture?.title || selectedCourse?.title[lang] || t("تفاصيل الخريطة","Graph details")}</h2>
        {!course && <p>{t("اختر مقررًا لعرض المحاضرات والمفاهيم.","Select a course to explore lectures and concepts.")}</p>}
        {course && <><h3>{t("المفاهيم","Key concepts")}</h3>{shown.map(c=><button key={c.id} onClick={()=>setConcept(c.id)} style={{display:"block",marginBottom:6,width:"100%",textAlign:"start",background:"#e6f6eb",color:"#24543c",border:"1px solid #b6ddc5",borderRadius:8,padding:9}}>{c.label[lang]}</button>)}
        <h3>{t("العلاقات","Relationships")}</h3>
        {edges.map(e=><div key={e.from+"|"+e.to+"|"+e.type} style={{borderBottom:"1px solid #e0e5ef",padding:"8px 0"}}><strong>{byId(e.from)} → {byId(e.to)}</strong><br/><small>{edgeName(e.type)} · {e.reason?.[lang]}</small><br/><small>{e.courses.map(id=>data.courses.find(c=>c.id===id)?.title?.[lang]||id).join(" · ")}</small></div>)}
        <h3>{t("مصادر التعلم","Learning resources")}</h3>{resources.map(m=><div key={m.id}><strong>{m.title}</strong> · {m.role==="umbrella"?t("مرجع","Reference"):t("محاضرة","Lecture")}<ul>{m.versionIds.map((id,i)=><li key={id}><a href={"/sources/"+encodeURIComponent(id)}>{t("عرض المصدر","View source")} {m.versionIds.length>1?i+1:""}</a></li>)}</ul></div>)}</>}
      </aside>
    </div>
  </section>;
}
