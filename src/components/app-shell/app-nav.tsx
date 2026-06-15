"use client";

import { useEffect, useState } from "react";
import { Dock } from "./dock";
import { Sidebar } from "./sidebar";

/**
 * Desktop left navigation. Defaults to the new glass Dock; a per-device toggle
 * (stored in localStorage) falls back to the classic text Sidebar so nothing
 * familiar disappears while the dock is still settling in the field.
 */
export function AppNav(props: {
  branding?: { name: string | null; logo: string | null };
  lang?: string;
  role?: string;
  badges?: Record<string, number>;
}) {
  const [mode, setMode] = useState<"dock" | "classic">("dock");

  useEffect(() => {
    try {
      if (localStorage.getItem("nav-mode") === "classic") setMode("classic");
    } catch {
      /* ignore */
    }
  }, []);

  function flip(next: "dock" | "classic") {
    setMode(next);
    try {
      localStorage.setItem("nav-mode", next);
    } catch {
      /* ignore */
    }
  }

  if (mode === "classic") {
    return (
      <div className="hidden lg:block">
        <Sidebar {...props} onFlip={() => flip("dock")} />
      </div>
    );
  }
  return <Dock branding={props.branding} role={props.role} badges={props.badges} onFlip={() => flip("classic")} />;
}
