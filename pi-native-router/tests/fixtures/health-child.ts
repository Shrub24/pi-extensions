// Child process for shared-health tests: one command against the shared store, printed as JSON.
import { HealthStore } from "../../src/health-store";
const [path, command, rawArgs] = process.argv.slice(2);
const args = JSON.parse(rawArgs ?? "[]") as unknown[];
const store = new HealthStore(path);
let result: unknown;
switch (command) {
  case "mark": store.mark(args[0] as string, "quota", args[1] as number, "quota"); result = "marked"; break;
  case "blocked": result = store.blocked(args as string[])?.key ?? null; break;
  case "admit": {
    const holder = args[1] as string;
    result = store.admitProbe(args[0] as string[], holder) !== undefined ? "granted" : "refused";
    break;
  }
  case "settle": store.settleProbe(args[0] as string, args[1] as boolean); result = "settled"; break;
  default: throw new Error(`unknown command ${command}`);
}
store.close();
console.log(JSON.stringify(result));
