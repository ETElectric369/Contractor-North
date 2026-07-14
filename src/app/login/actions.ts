"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function login(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/planner");
}

export async function signup(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const full_name = String(formData.get("full_name") ?? "");

  // INVITE-ONLY (migration 0125): the real gate is a BEFORE INSERT trigger on auth.users
  // (it also stops bots POSTing straight to GoTrue with the anon key). This pre-check just
  // turns the refusal into a clean message instead of a raw database error.
  const { data: allowed } = await supabase.rpc("signup_allowed", { p_email: email });
  if (allowed === false) {
    redirect(
      `/login?mode=signup&error=${encodeURIComponent(
        "Contractor North is invite-only right now. Ask for an invite and we'll open the door.",
      )}`,
    );
  }

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });

  if (error) {
    redirect(`/login?mode=signup&error=${encodeURIComponent(error.message)}`);
  }

  // If email confirmations are ON, the user must confirm first. If OFF (handy
  // for the first owner account), a session is created immediately.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    revalidatePath("/", "layout");
    redirect("/planner");
  }

  redirect(
    `/login?message=${encodeURIComponent(
      "Check your email to confirm your account, then sign in.",
    )}`,
  );
}

export async function requestPasswordReset(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect(`/forgot?error=${encodeURIComponent("Enter your email.")}`);

  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/reset`,
  });

  // Always show success (don't reveal whether an email exists).
  redirect(
    `/forgot?message=${encodeURIComponent(
      "If that email has an account, a reset link is on its way.",
    )}`,
  );
}

export async function updatePassword(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/forgot");

  const password = String(formData.get("password") ?? "");
  if (password.length < 6) {
    redirect(`/reset?error=${encodeURIComponent("Password must be at least 6 characters.")}`);
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(`/reset?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/planner");
}

const enc = encodeURIComponent;

/** Passwordless login — email the user a 6-digit code (no password to remember). Existing users
 *  only (new accounts sign up separately). The 6-digit code appears in the email IF the Supabase
 *  "Magic Link" template includes {{ .Token }}; the magic link in the same email also works. */
export async function sendLoginCode(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) redirect(`/login?mode=code&error=${enc("Enter your email.")}`);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback` },
  });
  if (error) redirect(`/login?mode=code&error=${enc(error.message)}`);
  redirect(`/login?mode=code&email=${enc(email)}&sent=1`);
}

/** Verify the 6-digit code the user typed → establishes a session. */
export async function verifyLoginCode(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const token = String(formData.get("code") ?? "").replace(/\D/g, "").slice(0, 6);
  const back = `/login?mode=code&email=${enc(email)}&sent=1`;
  if (!email || token.length < 6) redirect(`${back}&error=${enc("Enter the 6-digit code from your email.")}`);
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) redirect(`${back}&error=${enc(error.message)}`);
  revalidatePath("/", "layout");
  redirect("/planner");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
