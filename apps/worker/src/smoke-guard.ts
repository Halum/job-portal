/** Why the live smoke run must not start in this environment, or null when it may. */
export function smokeRefusal(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === 'test')
    return 'refusing to run with NODE_ENV=test: the smoke run talks to live services';
  if (env.CI !== undefined && env.CI !== '')
    return 'refusing to run when CI is set: the smoke run is manual only';
  return null;
}
