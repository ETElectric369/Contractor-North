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
  redirect("/dashboard");
}

export async function signup(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const full_name = String(formData.get("full_name") ?? "");

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
    redirect("/dashboard");
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
  redirect("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
