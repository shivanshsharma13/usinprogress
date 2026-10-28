// Promise-safety rules for the data layer: a forgotten `await` there can report success before a
// write has finished, and TypeScript alone doesn't always catch it.
import tseslint from 'typescript-eslint';

export default tseslint.config({ ignores: ['dist/**', 'supabase/**', '*.config.*'] }, {
  files: ['web/src/data/**/*.ts', 'web/src/lib/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    '@typescript-eslint/await-thenable': 'error',
  },
});
