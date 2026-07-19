const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = [
  { ignores: ["dist/**", "dist-server/**", "node_modules/**"] },
  {
    files: ["src/server/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "commonjs",
      parserOptions: { project: false },
      globals: {
        process: "readonly",
        console: "readonly",
        module: "readonly",
        require: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/client/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        project: false,
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        HTMLElement: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
