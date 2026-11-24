import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@job-portal/db';
import { users } from './schema';
import { bearerFromHeader, tokensEqual } from './token';

/** The one definition of the user shape; the type and the MCP output schema derive from it. */
export const userSchema = z.object({ id: z.string(), email: z.string(), timezone: z.string() });
export type User = z.infer<typeof userSchema>;

export interface Accounts {
  /** Creates the single user if absent; safe to call on every start. */
  seedUser: (email: string) => Promise<User>;
  /** Resolves an `Authorization` header to the user, or null when missing or wrong. */
  authenticate: (authorizationHeader: string | undefined) => Promise<User | null>;
}

// The columns selected as a User. Keep in step with userSchema; the compiler rejects a mismatch in the row type.
const columns = { id: users.id, email: users.email, timezone: users.timezone };

/**
 * ponytail: one user, one env token. A token table per user arrives with multi-user, which is out of scope.
 */
export function createAccounts(db: Db, bearerToken: string): Accounts {
  const firstUser = async (): Promise<User | null> =>
    (await db.select(columns).from(users).orderBy(asc(users.createdAt)).limit(1))[0] ?? null;

  return {
    async seedUser(email) {
      return db.transaction(async (tx) => {
        const existing = (
          await tx.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1)
        )[0];
        const [user] = existing
          ? await tx
              .update(users)
              .set({ email })
              .where(eq(users.id, existing.id))
              .returning(columns)
          : await tx.insert(users).values({ email }).returning(columns);
        if (!user) throw new Error('seed failed: no user row');
        return user;
      });
    },
    async authenticate(header) {
      const token = bearerFromHeader(header);
      if (token === null || !tokensEqual(token, bearerToken)) return null;
      return firstUser();
    },
  };
}
