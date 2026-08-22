import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['lib/', 'node_modules/', '*.tsbuildinfo']
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    },
    {
        // The client bundle is plain browser JS wrapped by the DSH ModuleLoader;
        // `require`/`module` come from the loader's factory scope and the DOM
        // globals are the web shell's. It is not Node code, so the Node globals
        // are intentionally off.
        files: ['src/client/**/*.js'],
        languageOptions: {
            globals: {
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                require: 'readonly',
                module: 'readonly',
                NodeJS: 'readonly'
            }
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            'no-undef': ['error', { typeof: false }]
        }
    }
);
