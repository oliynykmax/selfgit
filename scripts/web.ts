import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = "web/dist";
const fonts = new Map<string, string>();

// Bun inlines small CSS assets as data: URIs. Fontsource ships one file per unicode range,
// so inlining would make every visitor download every script's glyphs before first paint.
const linkFonts: Bun.BunPlugin = {
  name: "link-fonts",
  setup(build) {
    build.onResolve({ filter: /\.woff2$/ }, ({ path, importer }) => {
      fonts.set(basename(path), resolve(dirname(importer), path));
      return { path: `/assets/fonts/${basename(path)}`, external: true };
    });
  },
};

export async function build() {
  await rm(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: ["web/index.html"],
    outdir,
    minify: true,
    splitting: true,
    publicPath: "/",
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [linkFonts, tailwind],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "web build failed");
  await mkdir(`${outdir}/assets/fonts`, { recursive: true });
  for (const [name, source] of fonts)
    await copyFile(source, `${outdir}/assets/fonts/${name}`);
  // The theme script must run before first paint, and script-src 'self' forbids inlining it, so it stays a separate classic script.
  await copyFile("web/theme-init.js", `${outdir}/theme-init.js`);
  const index = Bun.file(`${outdir}/index.html`);
  const html = new HTMLRewriter()
    .on("head", {
      element: (head) =>
        void head.prepend('<script src="/theme-init.js"></script>', {
          html: true,
        }),
    })
    .transform(await index.text());
  await Bun.write(index, html);
}

/** Builds the Astro landing pages; the Worker embeds the server bundle and serves the client files from web/dist. */
export async function buildAstro() {
  const astro = Bun.spawn(["bun", "run", "astro:build"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await astro.exited) !== 0) throw new Error("astro build failed");
  await cp("astro/dist/client", outdir, { recursive: true });
}

if (import.meta.main) {
  await build();
  await buildAstro();
}
