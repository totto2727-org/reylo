import { fileURLToPath } from 'node:url'
import { defineConfig } from 'oxlint'

export default defineConfig({
  jsPlugins: [fileURLToPath(import.meta.resolve('@totto2727/oxlint'))],
  rules: {
    'rules/no-eslint-disable-comments': 'error',
    'rules/no-jsx-script-tag': 'error',
    'rules/no-optional-error-cause': 'error',
    'rules/require-disable-reason': 'error',
    'rules/require-import-extension': 'error',
  },
})
