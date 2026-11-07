"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { PostHogProvider } from "@/components/analytics/PostHogProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <PostHogProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </PostHogProvider>
  );
}
