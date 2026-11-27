/**
 * THE PDF ENGINE'S BROWSER: the one place that knows how headless Chromium is started.
 *
 * Two packages do the work and they move TOGETHER, as a matched pair:
 *   - `puppeteer-core`, the driver, built and tested against one Chrome version;
 *   - `@sparticuz/chromium`, that same Chromium version built for Amazon Linux 2023, which is what a
 *     Vercel function runs on. Its major number IS the Chromium major.
 * package.json pins both exactly, and a test holds that the driver's Chrome major equals the
 * package's (pdf-browser.test.ts), so an update of one without the other fails here and not in
 * production.
 *
 * WHAT THE CHROMIUM PACKAGE NO LONGER GIVES US (131 did, 153 does not): a `headless` value and a
 * `defaultViewport`. Both are stated here now. Left unset, the driver starts the browser in its
 * newer headless mode, which is not the binary this package ships, and lays the page out in an
 * 800 x 600 window.
 *
 * THE FLAGS. `chromium.args` is the package's own list for a serverless machine (single process,
 * no sandbox, no zygote, SwiftShader). `launch()` adds the driver's own default flags to it and
 * merges the two `--disable-features` / `--enable-features` lists into one flag each. Measured on
 * 2026-11-27 with an executable that only records its arguments: handing `chromium.args` straight
 * to `launch()` gives the same set of flags as the vendor README's
 * `puppeteer.defaultArgs({ args: chromium.args, headless: "shell" })`, each flag once.
 *
 * THE SHARED LIBRARIES (law 1 of the engine, and the reason for the order of the lines below).
 * The package unpacks libnss3 and its friends, and points LD_LIBRARY_PATH at them, only when it
 * believes it is on Amazon Linux 2023, and it decides that WHEN IT IS IMPORTED. Version 131 did
 * not know Vercel, which strips the AWS names it looked for; 153 recognises Vercel by itself
 * (`VERCEL` set, Node 20 or later). The runtime name is still declared here first, before the
 * import, for two reasons: the same path then runs on CI's Linux machine, where no `VERCEL` is
 * set, and the engine does not depend on the package's own Vercel check staying as it is.
 */
import type { Browser } from "puppeteer-core";

/** The window the print page is loaded in before Chromium paginates it for paper. It is the value
 *  version 131 of the chromium package supplied as its own default, kept so nothing a print page
 *  measures on load changes with the update. */
export const PDF_VIEWPORT = {
  deviceScaleFactor: 1,
  hasTouch: false,
  height: 1080,
  isLandscape: true,
  isMobile: false,
  width: 1920,
} as const;

/** The runtime name that tells the chromium package it is on Amazon Linux 2023. Any of its
 *  "20.x" / "22.x" / "24.x" names selects the same library set. */
export const LAMBDA_RUNTIME = "nodejs22.x";

/** The headless mode of the binary the chromium package ships (chrome-headless-shell). */
export const LAMBDA_HEADLESS = "shell";

/**
 * Start the browser a PDF is rendered in.
 *
 * `lambda: true` is production (and CI's Linux check): the chromium package's own binary, unpacked
 * to the temp folder on first use. `lambda: false` is a developer's machine: a local Chrome, or
 * whatever `CHROME_PATH` names.
 *
 * The caller owns the browser and must close it.
 */
export async function launchPdfBrowser(opts: { lambda: boolean }): Promise<Browser> {
  if (!opts.lambda) {
    const { default: puppeteer } = await import("puppeteer-core");
    return puppeteer.launch({
      args: [],
      executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
  }
  // BEFORE the import of the chromium package: it reads this when it loads (see the header).
  if (!process.env.AWS_LAMBDA_JS_RUNTIME) process.env.AWS_LAMBDA_JS_RUNTIME = LAMBDA_RUNTIME;
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium"),
  ]);
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: { ...PDF_VIEWPORT },
    executablePath: await chromium.executablePath(),
    headless: LAMBDA_HEADLESS,
  });
}
