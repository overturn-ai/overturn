"use client";

import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { Suspense, useEffect } from "react";

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (typeof window !== "undefined" && KEY && !posthog.__loaded) {
  posthog.init(KEY, {
    api_host: HOST,
    capture_pageview: false, // manual, so App Router navigations count
    capture_pageleave: true,
    session_recording: { maskAllInputs: true, maskTextSelector: "[data-ph-mask]" },
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
