import preset from '@totto2727/oxlint/preset/library'
import { defineConfig } from 'oxlint'

// oxlint-disable-next-line import/no-default-export -- Oxlint loads the default configuration export.
export default defineConfig({
  env: { node: true },
  extends: [preset],
  ignorePatterns: [
    // The HCL scanner generator owns these transition tables.
    'src/hclsyntax/scanner-tables.ts',
    'src/hclsyntax/string-literal-tables.ts',
  ],
  overrides: [
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
      // The published package and upstream consumers use this entry path.
      files: ['src/index.ts'],
      rules: { 'rules/no-index-filename': 'off' },
    },
  ],
})
