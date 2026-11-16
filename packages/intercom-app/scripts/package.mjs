// Assembles the deployable Intercom app: built server + Canvas Kit endpoint config + install notes.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "app"), { recursive: true });
cpSync(path.join(root, "dist", "index.js"), path.join(out, "index.js"));
cpSync(path.join(root, "dist", "capture.js"), path.join(out, "capture.js"));
cpSync(path.join(root, "dist", "bin.js"), path.join(out, "bin.js"));
cpSync(path.join(root, "app"), path.join(out, "app"), { recursive: true });
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      main: "./index.js",
      scripts: { start: "node bin.js" },
    },
    null,
    2,
  )}\n`,
);

// Intercom installs by pointing Canvas Kit at the deployed URLs, not by uploading this zip.
// The zip is the reviewable/deployable bundle: server, endpoint config and install notes.
const zip = (name) => {
  try {
    rmSync(path.join(root, "dist", name), { force: true });
    execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log("dist/app (zip not available; deploy the folder)");
  }
};
zip("overturn-intercom-app.zip");
