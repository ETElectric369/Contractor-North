import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Hammer, type LucideIcon } from "lucide-react";

export function ComingSoon({
  title,
  description,
  icon: Icon = Hammer,
  planned,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  planned: string[];
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={title} description={description} />
      <Card>
        <CardContent className="py-8">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-light">
              <Icon className="h-5 w-5 text-brand" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                On the roadmap
              </h3>
              <p className="text-sm text-slate-500">
                Scaffolded and wired into the app — implementation coming next.
              </p>
            </div>
          </div>
          <ul className="space-y-2">
            {planned.map((p) => (
              <li
                key={p}
                className="flex items-start gap-2 text-sm text-slate-600"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                {p}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
