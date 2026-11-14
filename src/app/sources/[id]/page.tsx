import { SourceViewer } from "../../../components/SourceViewer";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SourceViewer id={id} />;
}
