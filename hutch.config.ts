// @hutch cli=0.28.2-canary.7 cottontail=0.7.3-canary.8
export default {
  scripts: {
    smoke: ["hutch", "examples/smoke.js"],
    "smoke:bun-toolchain": ["hutch", "scripts/bun-toolchain-smoke.js"],
    echo: "echo hutch config script",
    "push:canary": "node scripts/tag-release.js canary",
    "push:production": "node scripts/tag-release.js production",
  },
};
