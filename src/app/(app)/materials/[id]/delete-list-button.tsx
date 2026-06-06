"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteMaterialList } from "../actions";

export function DeleteListButton({ listId }: { listId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function onDelete() {
    if (!confirm("Delete this material list and all its items?")) return;
    start(async () => {
      const res = await deleteMaterialList(listId);
      if (res.ok) router.push("/materials");
    });
  }

  return (
    <Button variant="outline" onClick={onDelete} disabled={pending}>
      <Trash2 className="h-4 w-4" /> {pending ? "Deleting…" : "Delete"}
    </Button>
  );
}
