export type BuildStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type BuildDocument = {
  versionId: string;
  sourceKey: string;
  title: string;
  role: "instructor" | "umbrella";
  status: BuildStatus;
  completedSteps: number;
  proposalId: string | null;
  error: string | null;
};
export type BuildJob = {
  id: string;
  courseId: string;
  status: BuildStatus;
  documents: BuildDocument[];
  createdAt: string;
  updatedAt: string;
};
