import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How the PDF engine's browser is started (lib/pdf-browser), held without a browser: both packages
 * are stand-ins here. The real binary is started where it can run, on Linux, in
 * tests/pdf-engine-on-linux.test.ts.
 */
const seen = vi.hoisted(() => ({
  /** What AWS_LAMBDA_JS_RUNTIME held at the moment the chromium package was loaded. */
  runtimeAtChromiumLoad: undefined as string | null | undefined,
  launches: [] as Record<string, unknown>[],
  unpacked: 0,
}));

vi.mock("puppeteer-core", () => ({
  default: {
    launch: vi.fn(async (options: Record<string, unknown>) => {
      seen.launches.push(options);
      return { stand: "in" };
    }),
  },
}));

/** The stand-in for the chromium package. It is registered again before every test (doMock, below),
 *  so each test LOADS it afresh and what it saw at load time belongs to that test. */
const chromiumStandIn = () => {
  seen.runtimeAtChromiumLoad = process.env.AWS_LAMBDA_JS_RUNTIME ?? null;
  return {
    default: {
      get args() {
        return ["--single-process", "--no-sandbox"];
      },
      executablePath: vi.fn(async () => {
        seen.unpacked += 1;
        return "/tmp/chromium";
      }),
    },
  };
};

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const kept = { runtime: process.env.AWS_LAMBDA_JS_RUNTIME, chrome: process.env.CHROME_PATH };
const put = (name: "AWS_LAMBDA_JS_RUNTIME" | "CHROME_PATH", value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  vi.resetModules();
  vi.doMock("@sparticuz/chromium", chromiumStandIn);
  seen.runtimeAtChromiumLoad = undefined;
  seen.launches.length = 0;
  seen.unpacked = 0;
  put("AWS_LAMBDA_JS_RUNTIME", undefined);
  put("CHROME_PATH", undefined);
});

afterEach(() => {
  put("AWS_LAMBDA_JS_RUNTIME", kept.runtime);
  put("CHROME_PATH", kept.chrome);
});

describe("the serverless browser", () => {
  it("declares the runtime BEFORE the chromium package loads, because the package decides about its libraries as it loads", async () => {
    const { launchPdfBrowser, LAMBDA_RUNTIME } = await import("./pdf-browser");
    await launchPdfBrowser({ lambda: true });
    expect(LAMBDA_RUNTIME).toBe("nodejs22.x");
    expect(seen.runtimeAtChromiumLoad).toBe("nodejs22.x");
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBe("nodejs22.x");
  });

  it("leaves a runtime name the platform already gave", async () => {
    put("AWS_LAMBDA_JS_RUNTIME", "nodejs24.x");
    const { launchPdfBrowser } = await import("./pdf-browser");
    await launchPdfBrowser({ lambda: true });
    expect(seen.runtimeAtChromiumLoad).toBe("nodejs24.x");
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBe("nodejs24.x");
  });

  it("starts the package's own binary in its own headless mode, in the 1920 x 1080 window, with the package's flags and nothing else", async () => {
    const { launchPdfBrowser, PDF_VIEWPORT } = await import("./pdf-browser");
    const browser = await launchPdfBrowser({ lambda: true });
    expect(browser).toEqual({ stand: "in" });
    expect(seen.unpacked).toBe(1);
    expect(seen.launches).toEqual([
      {
        args: ["--single-process", "--no-sandbox"],
        defaultViewport: { deviceScaleFactor: 1, hasTouch: false, height: 1080, isLandscape: true, isMobile: false, width: 1920 },
        executablePath: "/tmp/chromium",
        headless: "shell",
      },
    ]);
    // The viewport handed to the driver is a copy: the driver may write to what it is given.
    expect(seen.launches[0].defaultViewport).not.toBe(PDF_VIEWPORT);
  });

  it("a binary that cannot be unpacked fails the launch, and no browser is started", async () => {
    const chromium = (await import("@sparticuz/chromium")).default as unknown as { executablePath: ReturnType<typeof vi.fn> };
    chromium.executablePath.mockRejectedValueOnce(new Error("no bin folder"));
    const { launchPdfBrowser } = await import("./pdf-browser");
    await expect(launchPdfBrowser({ lambda: true })).rejects.toThrow("no bin folder");
    expect(seen.launches).toEqual([]);
  });
});

describe("a developer's machine", () => {
  it("never loads the chromium package and never declares a runtime", async () => {
    const { launchPdfBrowser } = await import("./pdf-browser");
    await launchPdfBrowser({ lambda: false });
    expect(seen.runtimeAtChromiumLoad).toBeUndefined();
    expect(process.env.AWS_LAMBDA_JS_RUNTIME).toBeUndefined();
    expect(seen.unpacked).toBe(0);
    expect(seen.launches).toEqual([
      { args: [], executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true },
    ]);
  });

  it("uses the browser CHROME_PATH names", async () => {
    put("CHROME_PATH", "/opt/some/browser");
    const { launchPdfBrowser } = await import("./pdf-browser");
    await launchPdfBrowser({ lambda: false });
    expect(seen.launches[0].executablePath).toBe("/opt/some/browser");
  });
});

describe("the two packages are one pair", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  const major = (v: string) => Number.parseInt(v.split(".")[0] ?? "", 10);

  it("package.json pins both to one exact version, so neither moves alone on an update", () => {
    for (const name of ["puppeteer-core", "@sparticuz/chromium"]) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("the Chrome the driver was built for is the Chromium the other package ships", () => {
    const revisions = read("node_modules/puppeteer-core/lib/puppeteer/revisions.js");
    const built = /chrome: '(\d+)\.[\d.]+'/.exec(revisions);
    expect(built, "the driver's revisions file names a Chrome version").not.toBeNull();
    const shipped = JSON.parse(read("node_modules/@sparticuz/chromium/package.json")) as { version: string };
    expect(major(shipped.version)).toBe(Number(built![1]));
    // What is installed is what package.json pins.
    expect(shipped.version).toBe(pkg.dependencies["@sparticuz/chromium"]);
    const driver = JSON.parse(read("node_modules/puppeteer-core/package.json")) as { version: string };
    expect(driver.version).toBe(pkg.dependencies["puppeteer-core"]);
  });

  it("the chromium package still ships the four files the function bundle carries", () => {
    const bin = "node_modules/@sparticuz/chromium/bin/";
    for (const f of ["chromium.br", "al2023.tar.br", "fonts.tar.br", "swiftshader.tar.br"]) {
      expect(() => readFileSync(join(root, bin + f)), f).not.toThrow();
    }
  });
});

describe("where the start lives", () => {
  const lib = read("src/lib/pdf-browser.ts");
  const route = read("src/app/api/pdf/[doc]/[id]/route.ts");
  const config = read("next.config.ts");

  it("the library sets the runtime name on a line above the import of the chromium package", () => {
    const set = lib.indexOf("process.env.AWS_LAMBDA_JS_RUNTIME = LAMBDA_RUNTIME");
    const load = lib.indexOf('import("@sparticuz/chromium")');
    expect(set).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(set);
    // And never at the top of the file: a static import would load the package before any line runs.
    expect(lib).not.toMatch(/^import (?!type )[^;]*@sparticuz\/chromium/m);
    expect(lib).not.toMatch(/^import (?!type )[^;]*from "puppeteer-core"/m);
  });

  it("the route starts the browser through the library and names neither package itself", () => {
    expect(route).toContain('import { launchPdfBrowser } from "@/lib/pdf-browser";');
    expect(route).toContain("browser = await launchPdfBrowser({ lambda: !!process.env.VERCEL });");
    expect(route).not.toMatch(/import\(["'](puppeteer-core|@sparticuz\/chromium)["']\)/);
    expect(route).not.toContain("chromium.headless");
    expect(route).not.toContain("chromium.defaultViewport");
  });

  it("the build keeps both packages out of the bundle and carries the binary folder with the PDF route", () => {
    expect(config).toContain('serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"]');
    expect(config).toContain('"/api/pdf/**": ["./node_modules/@sparticuz/chromium/bin/**"]');
  });
});
