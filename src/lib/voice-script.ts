// The recording script for the voice portal (/voice/[token]). Shared (NOT server-only) so the
// client recorder + the server page both read the same prompt list. A good ElevenLabs
// Professional Voice Clone wants clean, natural, phonetically-broad speech — so the script is a
// spoken consent statement + a phonetically-complete public-domain passage + open prompts that
// pull genuine, connected prosody (a clone reads *tone*, not canned lines).

export const CONSENT_VERSION = "2026-07-07";

/** The written agreement the invitee signs (types their name to) before recording. Plain-English
 *  and deliberately clear on scope + revocability — informed consent, not fine print. */
export const CONSENT_TEXT = [
  "I am giving my permission, freely and of my own choice, to have a synthetic (AI) model of my voice created from the recordings I make on this page.",
  "I understand this voice model will be used as the speaking voice of “Nort,” the assistant inside the Contractor North / North app, and may be used to read text aloud in that product.",
  "I understand no one is obligated to use my voice, and that I am not being asked to give up my name, my likeness, or any of my other rights — only to allow this specific voice model for this specific use.",
  "I understand I can withdraw this permission at any time by contacting the person who invited me, and that they will stop using the voice model and delete my recordings on request.",
  "I confirm the voice in these recordings is my own, and that I am at least 18 years old.",
] as const;

export type VoicePrompt = {
  key: string;
  kind: "consent" | "read" | "natural";
  label: string;
  instruction: string;
  /** For read/consent prompts: the exact words to read. For natural: empty (speak freely). */
  text?: string;
  /** Soft target so the UI can nudge length; not enforced. */
  targetSeconds?: number;
};

export const VOICE_PROMPTS: VoicePrompt[] = [
  {
    key: "consent-spoken",
    kind: "consent",
    label: "Spoken permission",
    instruction:
      "Read this aloud, replacing the bracketed part with your own full name. This recorded consent is kept with your signed agreement.",
    text:
      "I, [say your full name], am recording this today of my own free will. I give permission to create and use a synthetic model of my voice for the North assistant, Nort. This is my choice, and I understand I can withdraw it at any time.",
    targetSeconds: 20,
  },
  {
    key: "north-wind-1",
    kind: "read",
    label: "The North Wind and the Sun (1 of 2)",
    instruction: "Read at a relaxed, natural pace — the way you’d talk to a friend, not a newscast.",
    text:
      "The North Wind and the Sun were disputing which was the stronger, when a traveler came along wrapped in a warm cloak. They agreed that the one who first succeeded in making the traveler take his cloak off should be considered stronger than the other.",
    targetSeconds: 25,
  },
  {
    key: "north-wind-2",
    kind: "read",
    label: "The North Wind and the Sun (2 of 2)",
    instruction: "Same easy pace. If you stumble, just pause and pick the sentence back up — no need to restart.",
    text:
      "Then the North Wind blew as hard as he could, but the more he blew the more closely did the traveler fold his cloak around him; and at last the North Wind gave up the attempt. Then the Sun shone out warmly, and immediately the traveler took off his cloak. And so the North Wind was obliged to confess that the Sun was the stronger of the two.",
    targetSeconds: 35,
  },
  {
    key: "phonetic-1",
    kind: "read",
    label: "A few varied sentences (1 of 2)",
    instruction: "These cover a wide range of sounds. Natural pace, clear but unhurried.",
    text:
      "The quick brown fox jumps over the lazy dog. She sells sea shells by the shore. Six thick thistle sticks. How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
    targetSeconds: 25,
  },
  {
    key: "phonetic-2",
    kind: "read",
    label: "A few varied sentences (2 of 2)",
    instruction: "Read the numbers and the questions the way you’d actually say them out loud.",
    text:
      "It’s about a quarter past three on the fourteenth of July, two thousand twenty-six. Are you sure? Absolutely — I’ll be there at nine. Wow, that’s wonderful news! Please, thank you, and you’re very welcome.",
    targetSeconds: 25,
  },
  {
    key: "natural-why",
    kind: "natural",
    label: "In your own words",
    instruction:
      "No script — just talk. Speak for a minute or two, naturally, about why the work you do matters to you. Natural speech is the single best thing for the voice model.",
    targetSeconds: 90,
  },
  {
    key: "natural-day",
    kind: "natural",
    label: "One more, freely",
    instruction:
      "Again, no script. Describe your morning — where you are, what you see, how the day feels. Wander wherever you like; the more relaxed and real, the better.",
    targetSeconds: 90,
  },
];

/** File extension for a recorded clip's mime type. */
export function extForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "audio";
}
