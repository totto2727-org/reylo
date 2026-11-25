import type { Answer, Need } from "./engine-core.ts";

const DEFAULT_TTL = { session: 60_000, statement: 5000 };

// oxlint-disable-next-line rules/no-js-date -- The native engine cache uses the host clock and remains usable without Effect.
const now = (): number => Date.now();

/**
 * Answers the host may reuse. A session answer is about the database as a whole (which
 * operators return sets, which built-ins are shadowed); a statement answer is about a
 * statement's relations and types. Both go stale when the schema changes, so both expire:
 * a migration shows up within seconds, and a transform of the same text a moment later
 * costs no round trip.
 */
export class AnswerCache {
  #entries = new Map<string, { at: number; answer: Answer }>();
  #ttl: { session: number; statement: number };
  public constructor(ttl = DEFAULT_TTL) {
    this.#ttl = ttl;
  }

  public async get(need: Need, load: () => Promise<Answer>): Promise<Answer> {
    const ttl = need.kind === "query" && need.scope === "session" ? this.#ttl.session : this.#ttl.statement;
    const hit = this.#entries.get(need.id);
    if (hit && now() - hit.at < ttl) {return hit.answer;}
    const answer = await load();
    // A failure is not knowledge: the next transform asks again.
    if (!("error" in answer)) {this.#entries.set(need.id, { answer, at: now() });}
    return answer;
  }

  public clear(): void {
    this.#entries.clear();
  }
}
