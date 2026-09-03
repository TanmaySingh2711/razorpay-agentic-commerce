/**
 * Is this hostname a connection *pooler*, or the database itself?
 *
 * `DATABASE_URL` must reach the application's provider through a pooled
 * endpoint: a serverless runtime opens and abandons connections far faster than
 * PostgreSQL can afford, and the pooler is what stands between that and a
 * database that runs out of backends. `DIRECT_URL` is the opposite endpoint on
 * purpose - migrations and schema inspection need a real session, which a
 * transaction pooler cannot give them.
 *
 * The check used to be `hostname.startsWith("pooled.")`, which is not a fact
 * about pooling at all - it was the naming convention of one hosted provider,
 * and it rejected the correctly configured pooled endpoint of the next one.
 * Providers place the marker differently:
 *
 *   a leading label   pooled.db.example.test
 *   a label suffix    ep-something-123456-pooler.region.aws.neon.tech   (Neon)
 *   its own label     aws-0-ap-south-1.pooler.example.test
 *
 * What they share is that the hostname *says* so. So the rule below is about
 * the word rather than its position: a hostname is pooled when one of its
 * name parts is exactly `pooled` or `pooler`. This deployment runs on Neon,
 * whose pooled endpoint is the second form, but nothing here is Neon-specific -
 * that is the point, so a future move needs no code change.
 *
 * Matching whole parts, rather than searching for a substring anywhere in the
 * string, is what keeps this from being a weakening. A provider's *direct*
 * endpoint - `ep-abc-123.region.aws.neon.tech`, `db.example.test` - contains no
 * such part, so it is still refused, which is the case the verifier exists to
 * catch.
 */

/** The hostname parts that name a pooler, whatever the provider calls it. */
const POOLING_TOKENS = new Set(["pooled", "pooler", "pooling"]);

/**
 * Splits a hostname the way its provider composed it: dots separate labels,
 * hyphens separate words within a label.
 */
function hostnameParts(hostname: string): readonly string[] {
  return hostname.toLowerCase().split(/[.-]/);
}

/** True when the hostname names a pooled endpoint under any known convention. */
export function isPooledHostname(hostname: string): boolean {
  return hostnameParts(hostname).some((part) => POOLING_TOKENS.has(part));
}

/**
 * The accepted conventions, for an error message that tells the reader what to
 * fix rather than naming one vendor's console.
 */
export const POOLED_HOSTNAME_CONVENTIONS =
  "a pooled hostname names itself, in one of three shapes: `pooled.…`, " +
  "`…-pooler.…` (Neon) or `….pooler.…`. Use the provider's pooled connection " +
  "string for DATABASE_URL and keep the direct one for DIRECT_URL";
