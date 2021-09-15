module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: ["eslint:recommended", "google"],
  rules: {
    quotes: ["error", "double"],
    indent: ["error", 2],
    "max-len": ["error", { code: 100 }],
    "object-curly-spacing": ["error", "always"],
    "quote-props": ["error", "as-needed", { keywords: false }],
    "linebreak-style": [
      "error",
      process.platform === "win32" ? "windows" : "unix",
    ],
  },
};
