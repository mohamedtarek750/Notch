export type KGText = { ar: string; en: string };
export type KGKind = "major" | "course" | "lecture" | "concept";
export const semanticRelations = {
  prerequisite: "PREREQUISITE_OF",
  related: "RELATED_TO",
  optional_bridge: "OPTIONAL_BACKGROUND",
  is_a: "IS_A",
  part_of: "PART_OF",
  used_in: "USED_IN",
  solves: "SOLVES",
} as const;
export const semanticTypes = Object.keys(semanticRelations) as [
  keyof typeof semanticRelations, ...(keyof typeof semanticRelations)[],
];
export type KGRelation = "CONTAINS" | (typeof semanticRelations)[keyof typeof semanticRelations];
export type KGSourceCourse = { id: string; label: KGText; code?: string; lectureId: string };
export type KGNode = {
  kind: KGKind;
  id: string;
  label: KGText;
  majorId?: string;
  courseId?: string;
  lectureId?: string;
  code?: string;
  external?: boolean;
  sourceCourse?: KGSourceCourse;
};
export type KGEdge = { from: string; to: string; type: KGRelation };
export type KGView = { nodes: KGNode[]; edges: KGEdge[]; nextCursor: number | null };
export type KGRequirement = {
  concept: KGNode;
  target: KGNode;
  course?: KGSourceCourse;
  evidence: { id: string; courseId: string; title: string; page: number | null };
};
export type KGDetail = {
  node: KGNode;
  definition?: KGText;
  aliases: string[];
  parents: KGNode[];
  children: KGNode[];
  requirements?: KGRequirement[];
  relations: { node: KGNode; type: KGRelation; direction: "in" | "out" }[];
  resources: { id: string; title: string; courseId: string; page: number | null; section: string | null; excerpt?: string }[];
};
