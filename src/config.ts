/**
 * URL fragments that indicate we have been bounced to a sign-in screen.
 *
 * Base URL and session path are per-app and live in src/app.ts. There is
 * deliberately no module-level BASE_URL: a single constant cannot describe a
 * run that may target any tenant, and one left over from a previous run is
 * exactly how a campaign ends up filed under the wrong client.
 */
export const LOGIN_URL_PATTERN = /(\/login|\/signin|signin\.|accounts\.infusionsoft\.com)/i;
