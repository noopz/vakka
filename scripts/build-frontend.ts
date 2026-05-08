import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const buildOptions: esbuild.BuildOptions = {
  entryPoints: ["src/frontend/index.tsx", "src/frontend/styles/app.css"],
  bundle: true,
  outdir: "public",
  format: "esm",
  target: "safari15",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  treeShaking: true,
  entryNames: "[name]",
  // JS entry produces public/index.js, CSS entry produces public/app.css
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  console.log("Build complete");
}
