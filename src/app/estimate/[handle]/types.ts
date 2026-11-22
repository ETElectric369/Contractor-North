import type { DeckAnswers } from "@/lib/estimate/deck";
import type { EstimateLine, LeadBucket } from "@/lib/lead-triage";

/** The qualifying answers that drive the A/B/C bucket (separate from the deck measurements). */
export type Qualifying = {
  hasPlans: boolean;
  plansApproved: "yes" | "no" | "unsure" | null;
  /** How a no-plans customer can still be quoted. */
  noPlansPath: "sketch" | "dimensions" | "design_help" | null;
};

export type Contact = {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export type EstimatePayload = {
  answers: DeckAnswers;
  qualifying: Qualifying;
  contact: Contact;
  hp?: string; // honeypot
};

export type EstimateResult = {
  ok: boolean;
  error?: string;
  /** Whether the customer earned an instant firm number (ready A/B + under the size gate). */
  showInstantPrice?: boolean;
  siteInspectionRequired?: boolean;
  bucket?: LeadBucket;
  total?: number;
  lines?: EstimateLine[];
  assumptions?: string[];
  /** The lead this submit wrote or came back to (cn-v1180): the one key the same browser's
   *  "Request a Site Visit" tap attaches by. Never another lead's: only what this call returned. */
  leadId?: string;
};
