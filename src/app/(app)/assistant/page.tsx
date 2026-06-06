import { PageHeader } from "@/components/page-header";
import { AssistantChat } from "./assistant-chat";

export default function AssistantPage() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <PageHeader
        title="Assistant"
        description="Ask for quotes, material lists, scopes of work, and more."
      />
      <AssistantChat />
    </div>
  );
}
