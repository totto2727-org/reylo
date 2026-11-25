import preset from '@totto2727/oxlint/preset/library'
import { defineConfig } from 'oxlint'

// oxlint-disable-next-line import/no-default-export -- Oxlint loads the default configuration export.
export default defineConfig({
  env: { node: true },
  extends: [preset],
  ignorePatterns: [
    // The SQL content mapper generates these declarations, and the lint command checks their bytes.
    'examples/bun/queries/*.d.sql.ts',
    'examples/hcl/sql-types.d.ts',
    'examples/nub/src/sql-types.d.ts',
    // The HCL scanner generator owns these transition tables.
    'src/hclsyntax/scanner-tables.ts',
    'src/hclsyntax/string-literal-tables.ts',
  ],
  overrides: [
    {
      // Jest loads these .cjs files through CommonJS. The declaration defines an ambient SQL module for the lab.
      files: [
        'lab/jest/fixture.cjs',
        'lab/jest/jest.cjs.config.cjs',
        'lab/jest/jest.esm.config.cjs',
        'lab/jest/query.d.ts',
        'lab/jest/query.test.cjs',
      ],
      rules: { 'import/unambiguous': 'off' },
    },
    {
      // The upstream generator uses the MySQL protocol number that starts each run.
      files: ['src/error-codes-mysql.ts'],
      rules: { 'eslint/no-magic-numbers': 'off' },
    },
    {
      // Keep the upstream-generated SQLite result codes in header order.
      files: ['src/error-codes-sqlite.ts'],
      rules: { 'eslint/sort-keys': 'off' },
    },
    {
      // Keep the vendored Standard Schema 1.1.0 declarations byte-identical to the copied spec.
      // Limit the exceptions to the upstream declaration, literal, and comment styles found here.
      files: ['src/standard.ts'],
      rules: {
        'eslint/capitalized-comments': 'off',
        'eslint/no-magic-numbers': 'off',
        'rules/no-readonly': 'off',
        'typescript/array-type': 'off',
        'typescript/ban-types': 'off',
        'typescript/no-duplicate-type-constituents': 'off',
        'typescript/no-empty-interface': 'off',
        'typescript/no-empty-object-type': 'off',
        'typescript/no-namespace': 'off',
        'typescript/no-unnecessary-qualifier': 'off',
      },
    },
    {
      // Keep the upstream descriptor and its checked examples byte-identical, including JSON key order and encoding labels.
      files: ['spec/type-descriptor.ts'],
      rules: {
        'eslint/max-lines': 'off',
        'eslint/sort-keys': 'off',
        'unicorn/numeric-separators-style': 'off',
        'unicorn/text-encoding-identifier-case': 'off',
      },
    },
    {
      // The published package and upstream consumers use this entry path.
      files: ['src/index.ts'],
      rules: { 'rules/no-index-filename': 'off' },
    },
  ],
})
