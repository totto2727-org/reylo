// oxlint-disable-next-line rules/no-node-imports -- The native worker protocol transfers its reply port between Node threads.
import type { MessagePort } from "node:worker_threads";

export const SIGNAL_INDEX = 0;
export const WAITING = 0;
export const COMPLETE = 1;

export interface SqlModuleRequest {
  path: string;
  source: string;
  port: MessagePort;
  done: Int32Array;
}

export type SqlModuleReply = { code: string } | { error: string };
