"use client";

import { useEffect, useState } from "react";

function greetingFor(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * Time-of-day greeting computed on the CLIENT, so it reflects the user's own
 * local time rather than the server's UTC clock. SSR renders a neutral
 * "Welcome" (keeping hydration stable); on mount we swap in the time-based
 * greeting.
 */
export function DashboardGreeting({ name }: { name?: string }) {
  const [greeting, setGreeting] = useState("Welcome");
  useEffect(() => {
    setGreeting(greetingFor(new Date().getHours()));
  }, []);
  return (
    <>
      {greeting}
      {name ? `, ${name}` : ""}
    </>
  );
}
