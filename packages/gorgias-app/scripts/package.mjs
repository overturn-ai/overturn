// Assembles the uploadable Gorgias app: manifest + assets + the built script.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
if (existsSync(path.join(root, "app"))) {
  cpSync(path.join(root, "app"), out, { recursive: true });
}
if (existsSync(path.join(root, "dist", "main.global.js"))) {
  cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "assets", "main.js"));
}

const zip = (name) => {
  const dest = path.join(root, "dist", name);
  rmSync(dest, { force: true });
  try {
    execFileSync("zip", ["-qr", dest, "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    // Fall back to python zipfile if zip binary is not in PATH
    try {
      execFileSync(
        "python3",
        [
          "-c",
          `import sys, zipfile, os
target = sys.argv[1]
src = sys.argv[2]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root_dir, dirs, files in os.walk(src):
        for file in files:
            full = os.path.join(root_dir, file)
            rel = os.path.relpath(full, src)
            zf.write(full, rel)
`,
          dest,
          out,
        ],
        { stdio: "inherit" },
      );
      console.log(`dist/${name}`);
    } catch (e) {
      console.log("dist/app (zip not created: " + (e?.message || e) + ")");
    }
  }
};

zip("overturn-gorgias-app.zip");
const manifestPath = path.join(out, "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, private: false }, null, 2)}\n`);
}
zip("overturn-gorgias-app-marketplace.zip");
