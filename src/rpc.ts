import { matchesUndefined } from "./native-predicates.ts";
import { nativeErrorText } from "./native-error-text.ts";

// Minimal JSON-RPC 2.0 server over stdio with LSP-style Content-Length framing,
// Which is what tsc uses to talk to content mapper processes.

// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- The content mapper protocol requires this exact encoding name on the wire.
export const CONTENT_MAPPER_POSITION_ENCODING = "utf-8";

type Handler = (params: unknown) => unknown;
interface Request {
  id?: number | string;
  method: string;
  params?: unknown;
}
interface Response {
  error?: { code: number; message: string };
  id: Request["id"];
  jsonrpc: string;
  result?: unknown;
}

const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH = /Content-Length:\s*(?<length>\d+)/iu;
const BUFFER_START = 0;
const EMPTY_BUFFER_LENGTH = 0;
const CLEAN_EXIT = 0;
const JSON_RPC_VERSION = "2.0";
const INTERNAL_ERROR = -32_603;

const frameLength = (header: string): number => {
  const length = CONTENT_LENGTH.exec(header)?.groups?.length;
  if (matchesUndefined(length)) {
    // oxlint-disable-next-line rules/require-tagged-error -- Keep the native framing error emitted by the stdio server.
    throw new Error(`Bad header: ${header}`);
  }
  return Number(length);
};

const readFrame = (buffer: Buffer): { body: string; remaining: Buffer } | undefined => {
  const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
  if (headerEnd < BUFFER_START) {return undefined;}
  const header = buffer.subarray(BUFFER_START, headerEnd).toString("ascii");
  const bodyStart = headerEnd + HEADER_SEPARATOR.length;
  const bodyEnd = bodyStart + frameLength(header);
  if (buffer.length < bodyEnd) {return undefined;}
  return { body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"), remaining: buffer.subarray(bodyEnd) };
};

const writeResponse = (response: Response): void => {
  if (matchesUndefined(response.id)) {return;}
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}${HEADER_SEPARATOR}`);
  process.stdout.write(payload);
};

const dispatch = async (request: Request, handlers: Record<string, Handler>): Promise<void> => {
  const handler = handlers[request.method];
  // oxlint-disable-next-line eslint/sort-keys -- Preserve field order in serialized responses.
  const response: Response = { jsonrpc: JSON_RPC_VERSION, id: request.id };
  try {
    if (!handler) {
      // oxlint-disable-next-line rules/require-tagged-error -- Report an unknown RPC method with its native stack.
      throw new Error(`Unknown method ${request.method}`);
    }
    response.result = await handler(request.params) ?? {};
  } catch (error) {
    response.error = { code: INTERNAL_ERROR, message: nativeErrorText(error, "stack") };
  }
  writeResponse(response);
};

export const serve = (handlers: Record<string, Handler>): void => {
  // oxlint-disable-next-line rules/no-let -- The stdio data listener retains bytes from partial requests across chunks.
  let pending: Buffer = Buffer.alloc(EMPTY_BUFFER_LENGTH);
  // oxlint-disable-next-line unicorn/no-process-exit -- When TypeScript closes stdio, the mapper must exit even if a driver is waiting to reconnect.
  process.stdin.on("end", () => process.exit(CLEAN_EXIT));
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > EMPTY_BUFFER_LENGTH) {
      const frame = readFrame(pending);
      if (matchesUndefined(frame)) {return;}
      pending = frame.remaining;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript sends these requests over its private mapper pipe.
      const request = JSON.parse(frame.body) as Request;
      // oxlint-disable-next-line eslint/no-void -- Dispatch complete frames independently so later requests can run while earlier handlers await a database.
      void dispatch(request, handlers);
    }
  });
};
