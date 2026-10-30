import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The bin entry needs the executable bit when installed from a checkout.
chmodSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)), 0o755);
