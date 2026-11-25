import { NotMysql, Unreachable } from "./connection.ts";
import { Channel } from "./engine-channel.ts";
import type { ChannelAnswer } from "./engine-channel.ts";
import type { Analysis, Described, Dialect } from "./engine-core.ts";
import { hostUrl } from "./host-url.ts";
import type { HostUrl } from "./host-url.ts";
import { matchesUndefined, nonemptyText } from "./native-predicates.ts";

/** What a session asks of a connection the engine holds. */
export interface Connection {
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public method type and its variance.
  analyze(sql: string): Promise<Analysis>;
  /** Run the engine's query and return catalog rows. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public method type and its variance.
  query(sql: string, params: unknown[]): Promise<unknown[][]>;
  /** Return the description supplied by the engine. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public method type and its variance.
  describe(sql: string): Promise<Described>;
  /** Drop retained answers for this connection after a schema change. */
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public method type and its variance.
  forget(): Promise<void>;
  // oxlint-disable-next-line typescript/method-signature-style -- Preserve the public method declaration and its compatibility.
  close(): Promise<void>;
}

const nativeField = <Field extends keyof ChannelAnswer>(
  answer: ChannelAnswer, field: Field,
): NonNullable<ChannelAnswer[Field]> =>
  // oxlint-disable-next-line typescript/no-non-null-assertion -- The native engine supplies the requested field on success. Keep the wire values unchanged.
  answer[field]!;

const transportError = (answer: ChannelAnswer): Error => {
  // oxlint-disable-next-line rules/require-tagged-error -- Connection errors carry the native server code for existing driver callers.
  const error = new Error(answer.message);
  const coded = Boolean(answer.code);
  return Object.assign(error, coded ? { code: answer.code } : undefined);
};

const checkedResponse = (answer: ChannelAnswer): ChannelAnswer => {
  if (answer.status === "notMysql") {throw new NotMysql(nativeField(answer, "server"));}
  if (answer.status === "unreachable" || answer.status === "refused") {
    throw new Unreachable(transportError(answer));
  }
  if (answer.status === "error") {throw transportError(answer);}
  return answer;
};

type Ask = (request: object) => Promise<ChannelAnswer>;

const askSession = async (channel: Channel, request: object): Promise<ChannelAnswer> =>
  checkedResponse(await channel.ask(request));

const openConnection = async (channel: Channel, target: HostUrl): Promise<number> => {
  try {
    const bridge = nonemptyText(target.bridge);
    const answer = await askSession(channel, { op: "open", url: target.url, ...(matchesUndefined(bridge) ? {} : { bridge }) });
    return nativeField(answer, "conn");
  } catch (error) {
    channel.end();
    target.close();
    const failure = target.failure?.();
    throw failure ? new Unreachable(failure) : error;
  }
};

const describeConnection = async (ask: Ask, conn: number, sql: string): Promise<Described> => {
  // oxlint-disable-next-line eslint/sort-keys -- Preserve describe request serialization for the native engine.
  const answer = await ask({ op: "describe", conn, sql });
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public description's enumeration order.
  return { params: nativeField(answer, "params").map((oid) => ({ oid })), columns: nativeField(answer, "columns") };
};

const session = (channel: Channel, target: HostUrl, conn: number): Connection => {
  const ask = async (request: object): Promise<ChannelAnswer> => askSession(channel, request);
  // oxlint-disable-next-line eslint/sort-keys -- Preserve the public connection methods' enumeration order.
  return {
    analyze: async (sql) => {
      // oxlint-disable-next-line eslint/sort-keys -- Preserve run request serialization for the native engine.
      const result = await ask({ op: "run", conn, sql });
      return nativeField(result, "analysis");
    },
    query: async (sql, params) => {
      // oxlint-disable-next-line eslint/sort-keys -- Preserve query request serialization for the native engine.
      const result = await ask({ op: "query", conn, sql, params });
      return nativeField(result, "rows");
    },
    describe: async (sql) => describeConnection(ask, conn, sql),
    forget: async () => {
      // oxlint-disable-next-line eslint/sort-keys -- Preserve forget request serialization for the native engine.
      await ask({ op: "forget", conn });
    },
    close: async () => {
      try {
        // oxlint-disable-next-line eslint/sort-keys -- Preserve close request serialization for the native engine.
        await ask({ op: "close", conn });
      } catch {
        // Close both resources even if the native child has already stopped.
      }
      channel.end();
      target.close();
    },
  };
};

const closeLocalFile = (): void => {
  // Local file paths have no host bridge to close.
};

export const openEngineSession = async (binary: string, dialect: Dialect, url: string): Promise<Connection> => {
  const target = url.includes("://") ? await hostUrl(url) : { close: closeLocalFile, url };
  const channel = new Channel(binary, dialect);
  const conn = await openConnection(channel, target);
  return session(channel, target, conn);
};
