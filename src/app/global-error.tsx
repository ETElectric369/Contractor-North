"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/** Catches errors thrown in the root layout itself. Must render <html>/<body>. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error); // no-op until a DSN is configured
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
            onClick={reset}
            style={{
              marginTop: "1.25rem",
              background: "#0b57c4",
              color: "#fff",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.625rem 1.25rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
