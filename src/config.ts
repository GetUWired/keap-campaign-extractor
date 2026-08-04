export const BASE_URL = (process.env.KEAP_BASE_URL ?? 'https://jordan.infusionsoft.com').replace(
  /\/+$/,
  '',
);

export const STATE_PATH = process.env.KEAP_STATE_PATH ?? 'storageState.json';

/** URL fragments that indicate we have been bounced to a sign-in screen. */
export const LOGIN_URL_PATTERN = /(\/login|\/signin|signin\.|accounts\.infusionsoft\.com)/i;
