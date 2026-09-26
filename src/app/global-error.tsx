"use client";

import { useEffect } from "react";
import { reportClientError } from "@/app/report-client-error";
import { recoverFromChunkError } from "@/lib/chunk-reload";
import { useTryAgain } from "@/lib/try-again";

/** Catches errors thrown in the root layout itself. Must render <html>/<body>. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { tryAgain, trying } = useTryAgain(reset);
  useEffect(() => {
    if (recoverFromChunkError(error)) return; // stale chunk after a deploy → reload into the fresh build
    console.error(error);
    void reportClientError("global-error", error?.message ?? String(error), {
      digest: error?.digest,
      url: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8fafc",
          margin: 0,
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, color: "#0f172a" }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: "0.5rem", color: "#64748b", fontSize: "0.875rem" }}>
            Please try again.
          </p>
          <button
            onClick={tryAgain}
            disabled={trying}
            style={{
              marginTop: "1.25rem",
              background: "#0b57c4",
              color: "#fff",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.625rem 1.25rem",
              minHeight: "2.75rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {trying ? "Trying Again…" : "Try Again"}
          </button>
        </div>
      </body>
    </html>
  );
}
