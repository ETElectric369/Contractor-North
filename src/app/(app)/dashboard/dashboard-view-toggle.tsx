"use client";

import { useEffect, useState } from "react";

/**
 * Switches the dashboard body between the mind-map launcher and the normal
 * stats view. Defaults to the mind map (the owner's preferred home); the choice
 * persists per device.
 */
export function DashboardViewToggle({
  map,
  children,
}: {
  map: React.ReactNode;
  children: React.ReactNode;
}) {
  const [view, setView] = useState<"map" | "normal">("map");
  useEffect(() => {
    try {
      const v = localStorage.getItem("dashboard_view");
      if (v === "normal" || v === "map") setView(v);
    } catch {
      /* ignore */
    }
  }, []);

  function pick(v: "map" | "normal") {
    setView(v);
    try {
      localStorage.setItem("dashboard_view", v);
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <div className="mb-4 flex justify-center">
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm">
          <button
            onClick={() => pick("map")}
            className={`rounded-md px-3 py-1 font-medium ${view === "map" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
          >
            Mind map
          </button>
          <button
            onClick={() => pick("normal")}
            className={`rounded-md px-3 py-1 font-medium ${view === "normal" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
          >
            Normal
          </button>
        </div>
      </div>
      {view === "map" ? map : children}
    </div>
  );
}
