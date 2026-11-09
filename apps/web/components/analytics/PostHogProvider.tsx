"use client";

import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { Suspense, useEffect } from "react";

// Project token is a public, write-only key (safe in client code per PostHog). The production default below
// is used only on the production host; set NEXT_PUBLIC_POSTHOG_KEY to override or to capture from previews.
const PROD_HOSTS = ["app.overturn.run", "www.app.overturn.run"];
const PROD_KEY = "phc_vWUxkGb2jZG3mjQfnSXN7XEqpVS5kaGtHJurf5sSc8ED";
const KEY =
  process.env.NEXT_PUBLIC_POSTHOG_KEY ||
  (typeof window !== "undefined" && PROD_HOSTS.includes(window.location.hostname) ? PROD_KEY : undefined);
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (typeof window !== "undefined" && KEY && !posthog.__loaded) {
  posthog.init(KEY, {
    api_host: HOST,
    capture_pageview: false, // manual, so App Router navigations count
    capture_pageleave: true,
    // Every page in the app can show a customer's ticket text, prompts or model output. Recordings
    // keep layout and clicks for funnel review and mask all text and inputs; nothing a customer
    // sent us reaches PostHog (docs/privacy).
    session_recording: { maskAllInputs: true, maskTextSelector: "*" },
    // Autocapture would send clicked elements' text; the funnel uses explicit track.* events.
    autocapture: false,
    persistence: "localStorage+cookie",
  });
}

function PageView() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    if (!KEY || !pathname) return;
    const url = window.origin + pathname + (search?.toString() ? `?${search}` : "");
    posthog.capture("$pageview", { $current_url: url });
  }, [pathname, search]);
  return null;
}

/** No-op when NEXT_PUBLIC_POSTHOG_KEY is unset. */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  if (!KEY) return <>{children}</>;
  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PageView />
      </Suspense>
      {children}
    </PHProvider>
  );
}

/** Funnel events — keep names in sync with CLAUDE.md "Funnel". */
export const track = {
  landingCta: (where: string) => posthog.capture("landing_cta_clicked", { where }),
  signupStarted: () => posthog.capture("signup_started"),
  apiKeyCreated: () => posthog.capture("api_key_created"),
  firstRunReceived: () => posthog.capture("first_run_received"),
  firstCorrection: (surface: string) => posthog.capture("first_correction", { surface }),
  firstReplay: (model: string) => posthog.capture("first_replay", { model }),
  scorecardForwarded: () => posthog.capture("scorecard_forwarded"),
};
