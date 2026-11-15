import { Workspace } from "../components/Workspace";
import { connection } from "next/server";
import { isInviteOnlyPilot, openPilotTenant } from "../server/access-mode";
export default async function Page() {
  await connection();
  return (
    <Workspace
      inviteOnlyPilot={isInviteOnlyPilot()}
      openPilot={openPilotTenant() !== null}
    />
  );
}
