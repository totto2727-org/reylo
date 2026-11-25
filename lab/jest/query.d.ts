// Jest and Vitest transform SQL at runtime. The fixture checks the resulting query.
declare module "*/query.sql" {
  const query: unknown;
  export default query;
}
