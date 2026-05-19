module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  ignorePatterns: ["node_modules/", "main.js"],
  overrides: [
    {
      files: ["*.ts", "*.tsx"],
      rules: {
        // TypeScript handles globals/bindings.
        "no-undef": "off",
      },
    },
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
    // This codebase uses intentional `while (true)` loops for skill/tool iteration and queues.
    "no-constant-condition": "off",
    // Pragmatic typing: allow `any` for boundary surfaces (Obsidian/plugin interop).
    "@typescript-eslint/no-explicit-any": "off",
  },
};
