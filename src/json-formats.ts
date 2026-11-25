import { date, dateTime, time } from "./json-format-calendar.ts";
import { hostname } from "./json-format-hostname.ts";
import { email, ipv4, ipv6, uri } from "./json-format-network.ts";

const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

const regex = (value: string): boolean => {
  try {
    const pattern = new RegExp(value, "u");
    return pattern.unicode;
  } catch {
    return false;
  }
};

const formats = new Map<string, (value: string) => boolean>([
  ["date", date], ["date-time", dateTime], ["email", email], ["hostname", hostname], ["ipv4", ipv4],
  ["ipv6", ipv6], ["regex", regex], ["time", time], ["uri", uri], ["uuid", uuid],
]);

/**
 * Validate the formats that Reylo recognizes in an analyzed JSON Schema.
 * @param {string} name - The JSON Schema format name.
 * @param {string} value - The string to validate.
 * @returns {boolean} Whether the value passes or the schema names an unrecognized format.
 */
export const matchesJsonFormat = (name: string, value: string): boolean => formats.get(name)?.(value) ?? true;
