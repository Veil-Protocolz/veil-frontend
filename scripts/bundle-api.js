// Bundles api/update-roots-src.js → api/update-roots.js (CJS bundle)
// This sidesteps stellar-sdk v16 ESM/CJS conflicts on Vercel's Node runtime.
// api/package.json sets "type":"commonjs" so Vercel loads the output as CJS.
import { build } from "esbuild";

await build({
  entryPoints: ["api/update-roots-src.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "api/update-roots.js",
  // Suppress noisy warnings from stellar-sdk internals
  logOverride: { "indirect-require": "silent" },
  // Append Vercel handler shim: esbuild wraps default exports under .default
  footer: {
    js: "module.exports = module.exports.default ?? module.exports;",
  },
});

console.log("API bundle → api/update-roots.js");
