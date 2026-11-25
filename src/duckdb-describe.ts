import type { DbConnection, NodeApi, NodeType, Prepared } from "./duckdb-api.ts";
import type { DuckdbDescribed, DuckdbType } from "./engine-core.ts";
import { matchesNullish, matchesUndefined, nonemptyText } from "./native-predicates.ts";

const UNTYPED = new Set(["INVALID", "ANY", "SQLNULL"]);
const FIRST_COLUMN = 0;
const FIRST_PARAMETER = 1;
const STEP = 1;

const basic = (api: NodeApi, type: NodeType): DuckdbType => {
  const result: DuckdbType = { id: api.DuckDBTypeId[type.typeId] ?? String(type.typeId), text: type.toString() };
  const alias = nonemptyText(type.alias);
  if (!matchesUndefined(alias)) {result.alias = alias;}
  const { width, scale } = type;
  if (!matchesUndefined(width) && !matchesUndefined(scale)) {
    result.width = width;
    result.scale = scale;
  }
  return result;
};

type Fields = NonNullable<DuckdbType["fields"]>;
type LogicalType = (type: NodeType) => DuckdbType;

const fieldTypes = (names: string[] | undefined, types: NodeType[] | undefined, logical: LogicalType): Fields | undefined => {
  if (matchesNullish(names) || matchesNullish(types)) {return undefined;}
  return names.map((name, index) => (
    // oxlint-disable-next-line typescript/no-non-null-assertion -- DuckDB exposes one logical type per name in its prepared statement layout.
    { name, type: logical(types[index]!) }
  ));
};

const appendFields = (type: NodeType, result: DuckdbType, logical: LogicalType): void => {
  if (!matchesUndefined(type.length) && result.id === "ARRAY") {result.size = type.length;}
  const fields = fieldTypes(type.entryNames, type.entryTypes, logical);
  if (!matchesUndefined(fields)) {result.fields = fields;}
  const members = fieldTypes(type.memberTags, type.memberTypes, logical);
  if (!matchesUndefined(members)) {result.fields = members;}
  if (!matchesNullish(type.values)) {result.values = [...type.values];}
};

const logical = (api: NodeApi, type: NodeType): DuckdbType => {
  const result = basic(api, type);
  const child = (value: NodeType): DuckdbType => logical(api, value);
  const { keyType, valueType } = type;
  if (!matchesNullish(keyType) && !matchesNullish(valueType)) {
    return Object.assign(result, { key: child(keyType), value: child(valueType) });
  }
  if (!matchesNullish(valueType)) {result.child = child(valueType);}
  appendFields(type, result, child);
  return result;
};

const available = (api: NodeApi, read: () => NodeType): DuckdbType | undefined => {
  try {
    return logical(api, read());
  } catch {
    return undefined;
  }
};

const parameters = (api: NodeApi, prepared: Prepared): DuckdbDescribed["params"] => {
  const params: DuckdbDescribed["params"] = [];
  const cursor = { index: FIRST_PARAMETER };
  while (cursor.index <= prepared.parameterCount) {
    const { index } = cursor;
    const id = api.DuckDBTypeId[prepared.parameterTypeId(index)] ?? "";
    const type = UNTYPED.has(id) ? undefined : available(api, () => prepared.parameterType(index));
    // oxlint-disable-next-line unicorn/no-null -- Unknown DuckDB parameter types are null in the engine protocol.
    params.push({ name: prepared.parameterName(index), type: type ?? null });
    cursor.index += STEP;
  }
  return params;
};

const columns = (api: NodeApi, prepared: Prepared): DuckdbDescribed["columns"] => {
  const output: DuckdbDescribed["columns"] = [];
  const cursor = { index: FIRST_COLUMN };
  while (cursor.index < prepared.columnCount) {
    const { index } = cursor;
    // A parameter whose type DuckDB could not infer can also leave a result column untyped.
    const value = available(api, () => prepared.columnType(index));
    output.push({ name: prepared.columnName(index), type: value ?? { id: "INVALID", text: "" } });
    cursor.index += STEP;
  }
  return output;
};

export const describe = async (api: NodeApi, connection: DbConnection, sql: string): Promise<DuckdbDescribed> => {
  const prepared = await connection.prepare(sql);
  try {
    const bound = parameters(api, prepared);
    const results = columns(api, prepared);
    // oxlint-disable-next-line eslint/sort-keys -- Keep the upstream DuckDB describe message in the same wire order.
    return { kind: "duckdb", statement: api.StatementType[prepared.statementType] ?? "", params: bound, columns: results };
  } finally {
    // oxlint-disable-next-line node/no-sync -- Release the prepared statement before the connection returns to the native caller.
    prepared.destroySync?.();
  }
};
