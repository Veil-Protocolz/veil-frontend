// Bundles api/update-roots.js into a self-contained CJS file for Vercel.
// This sidesteps ESM/CJS interop issues with stellar-sdk v16 on older Node runtimes.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";

await build({
  entryPoints: ["api/update-roots.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "api/update-roots.bundle.js",
  logOverride: { "indirect-require": "silent" },
});

// esbuild wraps ESM default exports as module.exports.default.
// Vercel looks for module.exports directly, so append a re-export shim.
const bundle = readFileSync("api/update-roots.bundle.js", "utf8");
writeFileSync(
  "api/update-roots.bundle.js",
  bundle + "\n// Vercel handler shim\nmodule.exports = module.exports.default;\n"
);

console.log("API bundle written: api/update-roots.bundle.js");
