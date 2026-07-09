import { ToastProvider } from "@/components/toast";

/**
 * The external site-collaborator surface — a deliberately MINIMAL shell that lives OUTSIDE the
 * operational app (app) layout. An SEO/content collaborator is not an org member, so they never
 * enter the app; they land here and see only their granted org's Articles. ToastProvider is mounted
 * locally (the app one is scoped to (app)) so save/delete feedback works here too.
 */
export default function ContentLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
