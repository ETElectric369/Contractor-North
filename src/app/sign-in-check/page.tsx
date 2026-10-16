import { SignInCheckFailed } from "@/components/sign-in-check-failed";

/** Where the (app) layout sends a person whose sign-in check got NO ANSWER (not a sign-out):
 *  outside the app shell, so nothing here needs the check to pass, and under its own URL, so the
 *  offline page cache never keeps this screen in place of a page they had open. */
export const dynamic = "force-static";
export const metadata = { title: "Try Again" };

export default function SignInCheckPage() {
  return <SignInCheckFailed />;
}
