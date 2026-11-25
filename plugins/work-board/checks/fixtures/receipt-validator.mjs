import { readFileSync, writeFileSync } from "node:fs";

const [mode, log] = process.argv.slice(2);
if (mode === "exit-early") process.exit(0);
if (mode === "never-read") await new Promise(resolve => setTimeout(resolve, 30_000));
const envelope = JSON.parse(readFileSync(0, "utf8"));
if (log) writeFileSync(log, JSON.stringify(envelope));
console.error("validator diagnostic");
switch (mode) {
  case "reject": process.exit(1); break;
  case "empty": break;
  case "whitespace": console.log(" \t "); break;
  case "verbatim": process.stdout.write(" \t \r\n" + envelope.receipt + "\r\n"); break;
  case "invalid-utf8": process.stdout.write(Buffer.from([0x61, 0xc3])); break;
  case "signal": process.kill(process.pid, "SIGTERM"); break;
  case "long": console.log("a".repeat(501)); break;
  case "overflow": process.stdout.write("a".repeat(1_000_000)); break;
  default: console.log("\n  verified " + envelope.receipt.trim() + "  ");
}
