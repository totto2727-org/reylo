// The sqlcommenter comment (https://google.github.io/sqlcommenter/spec/) that ends every statement
// Reylo sends (src/execute.ts), unless the project file says `sqlcommenter: false`; the query's `sql`
// Leaves it out:
// `/*file='queries%2Fget_user.sql'*/`, the `.sql` file the statement came from. Datadog's Database Monitoring and PlanetScale's query insights read
// It as the statement's tags, and `pg_stat_activity` and a slow-query log show it as written. The
// File is its one tag, so the text is the same on every call, and a driver that keeps its statements
// Prepared by their text keeps this one.

/**
 * Add the source tag to a statement.
 * @param {string} text - The SQL statement.
 * @param {string} source - The source file path.
 * @returns {string} The statement with its source tag before a closing semicolon.
 */
export const withSqlcommenter = (text: string, source: string): string => {
  // The value is URL-encoded, and a quote, which encodeURIComponent leaves as it is, escaped.
  const tag = `/*file='${encodeURIComponent(source).replaceAll("'", String.raw`\'`)}'*/`;
  const body = text.replace(/[\s;]+$/u, "");
  const semicolon = text.slice(body.length).includes(";") ? ";" : "";
  // A line comment on the statement's last line (`--`, and MySQL's `#`) would take the tag in, so
  // After one the tag goes on a line of its own.
  const lineBreak = "\n";
  const last = body.slice(body.lastIndexOf(lineBreak) + lineBreak.length);
  return `${body}${/--|#/u.test(last) ? lineBreak : " "}${tag}${semicolon}`;
};
