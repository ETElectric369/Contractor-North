import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Next 16 ships its lint rules as flat configs and took `next lint` away, so `npm run lint` is plain
// `eslint .` and this file imports the two configs directly. (The compatibility wrapper this file used
// through Next 15 cannot load them: it dies turning a config with a circular plugin reference into JSON.)
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // CommonJS scripts (scripts/test-db/*.cjs) load their modules with require by definition.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // The config already ignores these four by itself; they are repeated so the list to add to is in view.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
