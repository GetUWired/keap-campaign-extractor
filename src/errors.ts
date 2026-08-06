/**
 * The session is no longer valid.
 *
 * Typed rather than message-matched: a bulk run has to tell "this campaign
 * failed" from "stop, everything after this will fail too", and that decision
 * must not depend on the wording of a string. Matching /Session expired/ works
 * until someone rewords the message, and then a run quietly degrades into
 * hundreds of identical failures instead of aborting.
 */
export class SessionExpiredError extends Error {
  /** Marker so detection survives instanceof failing across module realms. */
  readonly isSessionExpired = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export function isSessionExpired(error: unknown): error is SessionExpiredError {
  if (error instanceof SessionExpiredError) return true;
  return (
    error instanceof Error && (error as { isSessionExpired?: unknown }).isSessionExpired === true
  );
}
