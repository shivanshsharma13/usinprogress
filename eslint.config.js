// Only promise-safety rules: with an async database, a forgotten `await` can let a write run out of
// order or outside its transaction, and TypeScript alone doesn't always catch it.
import tseslint from 'typescript-eslint';

export default tseslint.config({ ignores: ['web/**', 'tests/**', 'dist/**', 'scripts/**', '*.config.*'] }, {
  files: ['server/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    '@typescript-eslint/await-thenable': 'error',
  },
});
