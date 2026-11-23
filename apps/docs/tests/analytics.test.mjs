// The marketing site's PostHog loader (public/analytics.js) and the CTAs it tracks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "../public/analytics.js"), "utf8");
const landing = readFileSync(path.join(here, "../site/index.html"), "utf8");
const config = readFileSync(path.join(here, "../astro.config.mjs"), "utf8");
const APP_KEY = readFileSync(path.join(here, "../../web/components/analytics/posthog-key.ts"), "utf8").match(
  /POSTHOG_PROD_KEY = "([^"]+)"/,
)[1];

/** Runs analytics.js `times` times against one fake page on `hostname`; returns what it did. */
function load(hostname, times = 1) {
  const appended = [];
  const listeners = {};
  let clickListeners = 0;
  const calls = { init: [], capture: [] };
  const window = { location: { hostname } };
  const document = {
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
      if (type === "click") clickListeners++;
    },
  };
  window.document = document;
  const context = vm.createContext({ window, document });
  for (let i = 0; i < times; i++) vm.runInContext(source, context);
  const loadLibrary = () => {
    window.posthog = {
      __loaded: false,
      init(key, opts) {
        calls.init.push({ key, opts });
        this.__loaded = true;
      },
      capture: (...args) => calls.capture.push(args),
    };
    appended[0].onload();
  };
  const click = (cta) =>
    listeners.click({ target: { closest: () => (cta ? { getAttribute: () => cta } : null) } });
  return { appended, listeners, calls, loadLibrary, click, clickListeners: () => clickListeners };
}

describe("analytics.js", () => {
  it("sends nothing off the production hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "overturn-ai.github.io", "overturn.run.evil.example"]) {
      const page = load(host);
      assert.equal(page.appended.length, 0, host);
      assert.equal(page.listeners.click, undefined, host);
    }
  });

  it("reports from the Framer landing hosts and the docs host", () => {
    for (const host of ["overturn.run", "www.overturn.run", "docs.overturn.run"]) {
      assert.equal(load(host).appended.length, 1, host);
    }
  });

  it("loads once per page when Framer mounts the landing page again", () => {
    const page = load("www.overturn.run", 2);
    assert.equal(page.appended.length, 1);
    assert.equal(page.clickListeners(), 1);
  });

  it("loads PostHog into the app's project, without autocapture or recordings", () => {
    const page = load("www.overturn.run");
    assert.equal(page.appended.length, 1);
    assert.equal(page.appended[0].src, "https://us-assets.i.posthog.com/static/array.js");
    page.loadLibrary();
    assert.equal(page.calls.init.length, 1);
    const { key, opts } = page.calls.init[0];
    assert.equal(key, APP_KEY);
    assert.equal(opts.api_host, "https://us.i.posthog.com");
    assert.equal(opts.capture_pageview, true);
    assert.equal(opts.autocapture, false);
    // the project's remote config must not be able to switch these on for the marketing site
    assert.equal(opts.enable_heatmaps, false);
    assert.equal(opts.capture_dead_clicks, false);
    assert.equal(opts.capture_performance, false);
    assert.equal(opts.capture_exceptions, false);
    assert.equal(opts.disable_surveys, true);
    assert.equal(opts.disable_session_recording, true);
    assert.equal(opts.cross_subdomain_cookie, true);
  });

  it("sends landing_cta_clicked with where for a data-cta click, once PostHog has loaded", () => {
    const page = load("www.overturn.run");
    page.click("hero_start_free"); // before the library loads: dropped, no throw
    assert.equal(page.calls.capture.length, 0);
    page.loadLibrary();
    page.click("hero_start_free");
    page.click(null); // a click outside any CTA
    // JSON round-trip: objects built inside the vm context have that realm's prototypes
    assert.deepEqual(JSON.parse(JSON.stringify(page.calls.capture)), [
      ["landing_cta_clicked", { where: "hero_start_free" }, { transport: "sendBeacon" }],
    ]);
  });
});

describe("landing page", () => {
  const ctas = (html) => [...html.matchAll(/<a [^>]*class="(?:btn|link)[^"]*"[^>]*>/g)].map((m) => m[0]);
  const block = (start, end) =>
    landing.slice(landing.indexOf(start), landing.indexOf(end, landing.indexOf(start)));

  it("tags every hero and quickstart button with a unique data-cta", () => {
    const hero = ctas(block('<div class="ctas">', "</div>"));
    const quickstart = ctas(block('<div class="foot">', "</div>"));
    assert.equal(hero.length, 3);
    assert.equal(quickstart.length, 2);
    const names = [...hero, ...quickstart].map((a) => a.match(/data-cta="([a-z_]+)"/)?.[1]);
    assert.ok(names.every(Boolean), `untagged: ${[...hero, ...quickstart].filter((_, i) => !names[i])}`);
    assert.equal(new Set(names).size, names.length);
  });

  it("carries the analytics loader and the CTA tags into the Framer module www.overturn.run mounts", () => {
    execFileSync(process.execPath, [path.join(here, "../scripts/assemble.mjs")], { stdio: "ignore" });
    const framer = path.join(here, "../dist/framer");
    const { file } = JSON.parse(readFileSync(path.join(framer, "manifest.json"), "utf8"));
    const mod = readFileSync(path.join(framer, file), "utf8");
    // the loader is code inside run(), not markup: an absolute URL, since the module runs on Framer's host
    assert.match(mod, /a\.src='https:\/\/docs\.overturn\.run\/docs\/analytics\.js'/);
    for (const cta of [
      "hero_quickstart",
      "hero_start_free",
      "hero_github",
      "quickstart_api_key",
      "quickstart_full",
    ]) {
      assert.ok(mod.includes(`data-cta=\\"${cta}\\"`), cta);
    }
  });

  it("loads analytics.js on every docs page", () => {
    assert.match(config, /src: "\/docs\/analytics\.js"/);
  });
});
