import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "plugin");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "plugin"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "main.js"));
cpSync(path.join(root, "server.mjs"), path.join(out, "server.mjs"));

const name = "overturn-front-plugin.zip";
rmSync(path.join(root, "dist", name), { force: true });
console.log(`Ready to zip dist/plugin into dist/${name}`);
