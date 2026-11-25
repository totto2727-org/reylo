// Copyright IBM Corp. 2014, 2025
// SPDX-License-Identifier: MPL-2.0
// oxlint-disable-next-line rules/no-node-imports -- Reject malformed records emitted by the pinned Go oracle.
import assert from "node:assert/strict";
import { isRecord, matchesString } from "#reylo-source/native-predicates.ts";

type Api = "lexConfig" | "lexExpression" | "lexTemplate" | "parseConfig" | "parseExpression" | "parseTemplate" | "scanStringLit" | "validIdentifier";

interface OracleFixture {
  api: Api;
  diagnostics: unknown;
  extra: unknown;
  filename: string;
  name: string;
  result: unknown;
  source: string;
  start: unknown;
}

const api = (value: unknown): Api => {
  switch (value) {
    case "lexConfig": case "lexExpression": case "lexTemplate":
    case "parseConfig": case "parseExpression": case "parseTemplate":
    case "scanStringLit": case "validIdentifier": {return value;}
    default: {return assert.fail(`Unexpected Go oracle API ${String(value)}`);}
  }
};

export const readFixture = (line: string): OracleFixture => {
  const value: unknown = JSON.parse(line);
  assert.ok(isRecord(value));
  const { diagnostics, extra, filename, name, result, source, start } = value;
  assert.ok(matchesString(filename) && matchesString(name) && matchesString(source));
  return { api: api(value.api), diagnostics, extra, filename, name, result, source, start };
};
