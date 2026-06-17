import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { TabBar } from "@/components/tabs";
import { CalendarPanel } from "./calendar-panel";
import { AppointmentsPanel } from "./appointments-panel";
import { MapPanel } from "./map-panel";

export const dynamic = "force-dynamic";

// Unified "Scheduler" hub. The Calendar IS the scheduling surface (month/week/day
// inside it, colour-coded per employee); Appointments and Map are the other two
// views (?view=). The old standalone "Day/Week" crew timelines ("everyone's day")
// are retired — any old ?view=day|week link folds back into the calendar.
const VIEWS = [
  { id: "calendar", label: "Calendar", href: "/schedule" },
  { id: "appointments", label: "Appointments", href: "/schedule?view=appointments" },
  { id: "map", label: "Map", href: "/schedule?view=map" },
];

function ScheduleFrame({ view, children }: { view: string; children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="Scheduler" description="Calendar, appointments and map — colour-coded by person, all in one place." />
      <TabBar items={VIEWS} activeId={view} />
      {children}
    </div>
  );
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  // Retired crew-timeline views: send old bookmarks to the live calendar.
  if (sp.view === "day" || sp.view === "week") redirect("/schedule");

  const view = ["calendar", "appointments", "map"].includes(sp.view ?? "") ? (sp.view as string) : "calendar";

  if (view === "appointments")
    return (
      <ScheduleFrame view="appointments">
        <AppointmentsPanel />
      </ScheduleFrame>
    );
  if (view === "map")
    return (
      <ScheduleFrame view="map">
        <MapPanel />
      </ScheduleFrame>
    );

  // Default → the Calendar (the one scheduling surface).
  return (
    <ScheduleFrame view="calendar">
      <CalendarPanel />
    </ScheduleFrame>
  );
}
