import { closeAnalysisConnection, settleInBackground, withLoginRetry } from "./analysis-connection.ts";
import type { AnalysisConnection } from "./analysis-connection.ts";
import { refusedLogin } from "./connection.ts";
import { matchesUndefined } from "./native-predicates.ts";
import type { ResolvedProject } from "./project.ts";

interface ConnectionContext {
  open: (url: string) => Promise<AnalysisConnection>;
  project: () => Pick<ResolvedProject, "refreshUrl">;
}

export class ConnectionOwner {
  #context: ConnectionContext;
  #io: Promise<AnalysisConnection> | undefined;
  #url: string | undefined;

  public constructor(context: ConnectionContext) {
    this.#context = context;
  }

  public adopt(url: string | undefined): void {
    this.#url = url;
  }

  public hasPending(): boolean {
    return !matchesUndefined(this.#io);
  }

  /** Closes the connection; the next analysis opens another. */
  public async release(): Promise<void> {
    const pending = this.#io;
    this.#io = undefined;
    if (!matchesUndefined(pending)) {
      await closeAnalysisConnection(pending);
    }
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Return the same Promise so failure and release can distinguish it from a newer connection.
  public get(): Promise<AnalysisConnection> {
    const pending = this.#io;
    if (!matchesUndefined(pending)) {
      return pending;
    }
    const opened = this.#connect();
    this.#io = opened;
    settleInBackground(this.#discardFailedOpen(opened));
    return opened;
  }

  async #discardFailedOpen(pending: Promise<AnalysisConnection>): Promise<void> {
    try {
      await pending;
    } catch {
      if (this.#io === pending) {
        this.#io = undefined;
      }
    }
  }

  async #connect(): Promise<AnalysisConnection> {
    const first = await this.#openFirst();
    return matchesUndefined(this.#context.project().refreshUrl) ? first : withLoginRetry(first, async (cause) => this.#reopen(cause));
  }

  async #openFirst(): Promise<AnalysisConnection> {
    try {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Analysis supplies a project URL. Direct query calls without one retain the native open diagnostic.
      return await this.#context.open(this.#url!);
    } catch (error) {
      return this.#reopen(error);
    }
  }

  async #reopen(cause: unknown): Promise<AnalysisConnection> {
    const fresh = this.#freshUrl(cause);
    if (matchesUndefined(fresh)) {
      throw cause;
    }
    return this.#context.open(fresh);
  }

  /**
   * Forgets a connection a call found dead, and closes it, since one opened in its place with a
   * command's fresh output may be live. Only the connection that call ran on: a call that fails
   * late never ends one opened since.
   * @param {Promise<AnalysisConnection>} io The connection promise used by the failed operation.
   */
  public drop(io: Promise<AnalysisConnection>): void {
    if (this.#io !== io) {return;}
    this.#io = undefined;
    settleInBackground(closeAnalysisConnection(io));
  }

  /**
   * A URL to try instead, when the server refused the login and `direct_url`'s command now prints
   * something else, as when a short-lived password has expired; else undefined, so that nothing
   * is tried twice on the same password.
   * @param {unknown} cause The error from connecting with the current URL.
   * @returns {string | undefined} The refreshed URL if the configuration produced a different one.
   */
  #freshUrl(cause: unknown): string | undefined {
    if (!refusedLogin(cause)) {return undefined;}
    const fresh = this.#context.project().refreshUrl?.();
    if (matchesUndefined(fresh) || fresh === this.#url) {return undefined;}
    this.#url = fresh;
    return fresh;
  }
}
