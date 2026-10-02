"use client";

import { useEffect } from "react";
import { letTheScreenTurn } from "@/lib/native-orientation";

/**
 * THIS SCREEN MAY BE TURNED SIDEWAYS. Mount it on a screen that gets better with width; leave it
 * off every other one, which is all of them today except the schedule's calendar.
 *
 * It draws nothing. On mount it tells the shell sideways is allowed; on unmount it takes that back,
 * and the shell turns the phone upright again by itself (ScreenTurnPlugin.swift). That second half
 * is the whole reason this is a component and not a one-off call: walking off the calendar while
 * holding the phone sideways would otherwise leave someone on a portrait-only screen squeezed into
 * 375pt of height, which is a dead end nobody asked for.
 *
 * Nothing here needs to succeed. On a phone browser with no Screen Orientation API (iOS Safari) and
 * in the installed web app (whose manifest is one value for the whole app, so it stays portrait),
 * both calls are quiet no-ops and the screen behaves exactly as it does today.
 */
export function TurnsSideways() {
  useEffect(() => {
    void letTheScreenTurn("sideways");
    return () => {
      void letTheScreenTurn("portrait");
    };
  }, []);
  return null;
}
