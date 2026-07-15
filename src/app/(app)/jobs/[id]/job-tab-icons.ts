"use client";

// The job hub is a SERVER component, but the tab defs carry LucideIcon COMPONENT
// references (the More-panel chip icons — the shared TabBarItem contract). A raw
// lucide-react import is a plain function to the RSC serializer ("Functions
// cannot be passed directly to Client Components"); re-exporting through this
// "use client" module turns each icon into a client reference, which crosses the
// server→client boundary legally and resolves to the real component in <Tabs>.
export {
  LayoutDashboard,
  Clock,
  Package,
  Camera,
  ListChecks,
  CalendarDays,
  ClipboardCheck,
  FileText,
  // Costs is DollarSign, NOT Wallet — at chip size a wallet and a box (Package/
  // Materials) read as the same rounded-rect silhouette at 60mph. $ vs box is
  // unmistakable (Erik's field feedback, 2026-07-14).
  DollarSign,
  Receipt,
  StickyNote,
  Stamp,
  FileDiff,
} from "lucide-react";
