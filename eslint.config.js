import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "web/dist/**", "data/**", "coverage/**", "notes/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": "error",
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // Amounts are integers. Floating-point parsing has no place in money code.
    files: ["shared/amounts.ts", "server/fees.ts", "server/quotes.ts", "server/verify.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "parseFloat", message: "Use BigInt for amounts." }],
      "no-restricted-properties": ["error", { object: "Number", property: "parseFloat", message: "Use BigInt for amounts." }],
    },
  },
  {
    files: ["test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
  { files: ["scripts/**"], rules: { "no-console": "off" } },
);
