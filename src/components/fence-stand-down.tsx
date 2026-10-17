"use client";

import { useEffect } from "react";
import { disarmFence } from "@/lib/native-geofence";

/**
 * NO CLOCK ENTRY IS OPEN: iOS's region monitor stands down. The fence monitor disarms on its own
 * unmount, which only happens when THIS page saw the clock-out; an entry closed from the office,
 * another device or the long-shift sweep left the region armed until the next clock-in, so a tech
 * off the clock could still be asked "Still on the clock?" (audit v1120, class 6). The layout
 * renders this whenever it renders no monitor; disarmFence is idempotent and a no-op off the shell.
 */
export function FenceStandDown() {
  useEffect(() => {
    void disarmFence();
  }, []);
  return null;
}
