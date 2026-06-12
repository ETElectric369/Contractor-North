import { PageHeader } from "@/components/page-header";
import { ToolsView } from "./tools-view";

export default function ToolsPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Tools"
        description="Field calculators — voltage drop, conduit fill, Ohm's law, board feet."
      />
      <ToolsView />
    </div>
  );
}
