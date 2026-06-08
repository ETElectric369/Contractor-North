import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-slate-300" />
    </div>
  );
}
