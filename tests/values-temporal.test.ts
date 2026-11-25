// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Compare native decoder and driver results with the test runner's assertions.
import assert from "node:assert/strict";
import { coerce, duration, instant, postgresInterval, postgresYear, textDecoder } from "#reylo-source/values.ts";
import { nativeDriverDate, SQL_NULL } from "./helpers.ts";

// These tests use the Node runtime's own Temporal conversions.
interface TemporalValue { toString: () => string }
interface TemporalInstant extends TemporalValue { epochNanoseconds: bigint }
interface TemporalFactory<Result extends TemporalValue> { from: (text: string) => Result }

declare const Temporal: {
  Duration: TemporalFactory<TemporalValue>;
  Instant: TemporalFactory<TemporalInstant>;
  PlainDate: TemporalFactory<TemporalValue>;
  PlainDateTime: TemporalFactory<TemporalValue>;
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("interval: an ISO 8601 duration with its sign in front, which Temporal reads, and each part signed where the parts' signs differ", () => {
  // Postgres's text in IntervalStyle postgres, Reylo's value, and Postgres's own in iso_8601, as Postgres 18 writes them.
  Iterator.from([
    ["1 mon", "P1M", "P1M"],
    ["1 year 2 mons 3 days 04:05:06.789", "P1Y2M3DT4H5M6.789S", "P1Y2M3DT4H5M6.789S"],
    ["00:00:00", "PT0S", "PT0S"],
    ["48:00:00", "PT48H", "PT48H"],
    ["00:00:00.000001", "PT0.000001S", "PT0.000001S"],
    ["-1 days", "-P1D", "P-1D"],
    ["-1 years -2 mons", "-P1Y2M", "P-1Y-2M"],
    ["-1 mons -2 days -00:00:03", "-P1M2DT3S", "P-1M-2DT-3S"],
    ["-178956970 years -7 mons -2147483647 days -2562047788:00:54.775807", "-P178956970Y7M2147483647DT2562047788H54.775807S", "P-178956970Y-7M-2147483647DT-2562047788H-54.775807S"],
  ] as [string, string, string][]).forEach(([text, iso, postgres]) => {
    assert.equal(duration(text), iso, text);
    assert.equal(Temporal.Duration.from(iso).toString(), iso, `${text}: Temporal reads it`);
    assert.equal(postgresInterval(iso), postgres, `${text}: as a parameter, in the form Postgres reads`);
  });
  // Parts of different signs have no ISO 8601 form: Postgres's own, which Temporal refuses.
  Iterator.from([
    ["1 mon -1 days", "P1M-1D"],
    ["-1 days +01:00:00", "P-1DT1H"],
    ["1 day -01:30:00.5", "P1DT-1H-30M-0.5S"],
  ] as [string, string][]).forEach(([text, iso]) => {
    assert.equal(duration(text), iso, text);
    assert.equal(postgresInterval(iso), iso, `${text}: already the form Postgres reads`);
  });
  assert.equal(duration("infinity"), "infinity");
  assert.equal(duration("-infinity"), "-infinity");
  // Any other text, such as a parameter in Postgres's own words, goes as it is.
  assert.equal(postgresInterval("-1 days"), "-1 days");
  assert.equal(postgresInterval("+P1D"), "P1D");
  assert.deepEqual(textDecoder("interval[]")('{"1 day",NULL,-00:00:03}'), ["P1D", SQL_NULL, "-PT3S"]);
  assert.equal(coerce("interval", "-1 days", "span"), "-P1D", "a driver's text, as Bun.sql gives it");
});

const checkUnboundedDates = function (date: ReturnType<typeof textDecoder>, timestamp: ReturnType<typeof textDecoder>): void {
  // A date past 999999 AD, which only Postgres's date reaches (5874897), keeps a sign before the
  // Digits it needs; Temporal holds no such date, and the parameter still reads it back.
  assert.equal(date("5874897-12-31"), "+5874897-12-31");
  assert.equal(date("1000000-01-01"), "+1000000-01-01");
  assert.equal(postgresYear("+5874897-12-31"), "5874897-12-31");
  assert.throws(() => Temporal.PlainDate.from("+5874897-12-31"), RangeError);
  Iterator.from(["infinity", "-infinity"]).forEach((word) => {
    assert.equal(date(word), word);
    assert.equal(timestamp(word), word);
  });
  // Arrays: each element as a scalar's, a BC element quoted in Postgres's text.
  assert.deepEqual(textDecoder("date[]")('{"0002-06-01 BC",12345-01-01,2026-10-20,NULL,infinity}'), ["-000001-06-01", "+012345-01-01", "2026-10-20", SQL_NULL, "infinity"]);
  assert.deepEqual(textDecoder("timestamp[]")('{"0002-06-01 12:00:00 BC","10000-01-01 00:00:00",-infinity}'), ["-000001-06-01T12:00:00", "+010000-01-01T00:00:00", "-infinity"]);
  // A driver's Date (Bun.sql's, read as UTC) gives the same text as the server's.
  assert.equal(coerce("date", nativeDriverDate("+012345-01-01T00:00:00Z"), "d"), "+012345-01-01");
  assert.equal(coerce("timestamp", nativeDriverDate("+010000-01-01T00:00:00.250Z"), "t"), "+010000-01-01T00:00:00.25");
  assert.equal(coerce("timestamp", nativeDriverDate("-000001-06-01T12:00:00Z"), "t"), "-000001-06-01T12:00:00");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("date and timestamp: a year outside 0000 to 9999 in ISO 8601's extended form, as timestamptz's, which Temporal reads and a parameter takes back", () => {
  const date = textDecoder("date");
  const timestamp = textDecoder("timestamp");
  Iterator.from([
    ["2026-10-20", "2026-10-20"],
    ["0001-01-01", "0001-01-01"],
    ["9999-12-31", "9999-12-31"],
    ["0001-12-31 BC", "0000-12-31"],
    ["0002-06-01 BC", "-000001-06-01"],
    ["4714-11-24 BC", "-004713-11-24"],
    ["10000-01-01", "+010000-01-01"],
    ["12345-01-01", "+012345-01-01"],
    ["275760-09-13", "+275760-09-13"],
  ] as const).forEach(([text, iso]) => {
    assert.equal(date(text), iso, text);
    assert.equal(Temporal.PlainDate.from(iso).toString(), iso, iso);
    // The round-trip rule: the parameter is the text the server wrote, which it reads as the same date.
    assert.equal(postgresYear(iso), text, iso);
  });
  Iterator.from([
    ["2026-10-20 10:00:00.123456", "2026-10-20T10:00:00.123456"],
    ["0001-12-31 23:59:59.999999 BC", "0000-12-31T23:59:59.999999"],
    ["0002-06-01 12:00:00 BC", "-000001-06-01T12:00:00"],
    ["4714-11-24 00:00:00 BC", "-004713-11-24T00:00:00"],
    ["10000-01-01 00:00:00", "+010000-01-01T00:00:00"],
    ["123456-01-01 00:00:00.5", "+123456-01-01T00:00:00.5"],
    ["275760-09-13 00:00:00", "+275760-09-13T00:00:00"],
  ] as const).forEach(([text, iso]) => {
    assert.equal(timestamp(text), iso, text);
    assert.equal(Temporal.PlainDateTime.from(iso).toString(), iso, iso);
    assert.equal(postgresYear(iso), text.replace(" ", "T"), iso);
  });
  checkUnboundedDates(date, timestamp);
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("timestamptz: the instant's ISO 8601 text in UTC, the server's fraction kept, which new Date(text) gets wrong for BC, year 1 and offsets with seconds", () => {
  Iterator.from([
    ["2026-10-20 03:03:00.123456-07", "2026-10-20T10:03:00.123456Z"],
    ["2026-10-20 10:00:00+00", "2026-10-20T10:00:00Z"],
    ["2026-10-20 10:00:00.5+05:30", "2026-10-20T04:30:00.5Z"],
    ["2026-12-31 23:30:00-01", "2027-01-01T00:30:00Z"],
    ["0001-01-01 00:00:00+00", "0001-01-01T00:00:00Z"],
    ["0001-01-01 00:30:00+01", "0000-12-31T23:30:00Z"],
    ["1883-11-18 12:00:00-07:52:58", "1883-11-18T19:52:58Z"],
    ["1900-01-01 00:00:00+00:00:36", "1899-12-31T23:59:24Z"],
    ["0001-12-31 23:59:59.999999+00 BC", "0000-12-31T23:59:59.999999Z"],
    ["0002-06-01 12:00:00+00 BC", "-000001-06-01T12:00:00Z"],
    ["0044-03-15 12:00:00+00 BC", "-000043-03-15T12:00:00Z"],
    ["4713-11-24 00:00:00+00 BC", "-004712-11-24T00:00:00Z"],
    ["9999-12-31 23:59:59.999999-01", "+010000-01-01T00:59:59.999999Z"],
    ["12345-01-01 00:00:00+05:30", "+012344-12-31T18:30:00Z"],
    ["2000-02-29 12:00:00+00", "2000-02-29T12:00:00Z"],
    ["1900-03-01 00:00:00+01", "1900-02-28T23:00:00Z"],
  ] as const).forEach(([text, iso]) => {
    assert.equal(instant(text), iso, text);
    // Temporal reads each back to the same text: an ISO 8601 instant, the year extended outside 0000 to 9999.
    assert.equal(Temporal.Instant.from(iso).toString(), iso, iso);
  });
  // Each to the nanosecond against Temporal's own reading of the server's offset (its microseconds kept).
  assert.equal(Temporal.Instant.from(instant("2026-10-20 03:03:00.123456-07")).epochNanoseconds, Temporal.Instant.from("2026-10-20T03:03:00.123456-07:00").epochNanoseconds);
  // Past Temporal's range (±10^8 days), which Postgres's reaches (294276 AD): still ISO 8601 text.
  assert.equal(instant("294276-12-31 23:59:59.999999+00"), "+294276-12-31T23:59:59.999999Z");
  assert.throws(() => Temporal.Instant.from("+294276-12-31T23:59:59.999999Z"), RangeError);
  assert.equal(instant("infinity"), "infinity");
  assert.equal(instant("-infinity"), "-infinity");
  // The failing control: what postgres.js and PGlite use, and what a Date holds.
  assert.equal(nativeDriverDate("0001-01-01 00:00:00+00").getUTCFullYear(), 2001);
  assert.equal(nativeDriverDate("2026-10-20T03:03:00.123456-07:00").toISOString(), "2026-10-20T10:03:00.123Z");
});
