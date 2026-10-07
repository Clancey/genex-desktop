import { spawn } from "node:child_process";
import { localNetworkElectron, resolveElectron } from "./electron-runtime.mjs";

// `npm start`: the normal profile, launched like `electron .` but with Genex's macOS identity.
const checkout = process.cwd();
const child = spawn(localNetworkElectron(resolveElectron(checkout), checkout), [".", ...process.argv.slice(2)], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
