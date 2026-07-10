import { pathToFileURL } from "node:url";
import { startServer } from "./server.js";

export { server, handleTelegramCommand, startServer } from "./server.js";

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer();
}
