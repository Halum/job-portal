import { asc } from 'drizzle-orm';
import type { Db } from '@job-portal/db';
import { users } from './schema';
import { bearerFromHeader, tokensEqual } from './token';

export interface User {
  id: string;
  email: string;
  timezone: string;
}

export interface Accounts {
  /** Creates the single user if absent; safe to call on every start. */
  seedUser: (email: string) => Promise<User>;
  /** Resolves an `Authorization` header to the user, or null when missing or wrong. */
  authenticate: (authorizationHeader: string | undefined) => Promise<User | null>;
}

const columns = { id: users.id, email: users.email, timezone: users.timezone };

/**
 * ponytail: one user, one env token. A token table per user arrives with multi-user, which is out of scope.
 */
export function createAccounts(db: Db, bearerToken: string): Accounts {
  const firstUser = async (): Promise<User | null> =>
    (await db.select(columns).from(users).orderBy(asc(users.createdAt)).limit(1))[0] ?? null;

  return {
    async seedUser(email) {
      await db.insert(users).values({ email }).onConflictDoNothing();
      const user = await firstUser();
      if (!user) throw new Error('seed failed: no user row');
      return user;
    },
    async authenticate(header) {
      const token = bearerFromHeader(header);
      if (token === null || !tokensEqual(token, bearerToken)) return null;
      return firstUser();
    },
  };
}
