// Project token is a public, write-only key (safe in client code per PostHog). The production default
// is used only on the production host; set NEXT_PUBLIC_POSTHOG_KEY to override or to capture from previews.
export const POSTHOG_PROD_HOSTS = ["app.overturn.run", "www.app.overturn.run"];
export const POSTHOG_PROD_KEY = "phc_vWUxkGb2jZG3mjQfnSXN7XEqpVS5kaGtHJurf5sSc8ED";

/**
 * The PostHog project key for this page, or undefined to send nothing. An env value wins on any
 * host; otherwise only the production host gets the production key, so previews and localhost
 * never report into the production project.
 */
export function posthogKey(hostname: string | undefined, envKey: string | undefined): string | undefined {
  if (envKey) return envKey;
  return hostname && POSTHOG_PROD_HOSTS.includes(hostname) ? POSTHOG_PROD_KEY : undefined;
}
