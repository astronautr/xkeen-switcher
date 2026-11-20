import path from "node:path";
import { fileURLToPath } from "node:url";
export const directory = path.dirname(fileURLToPath(import.meta.url));
export const alias = { "@": path.join(directory, "src") };
