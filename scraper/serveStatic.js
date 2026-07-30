// Tiny static file server for local preview of the GitHub Pages build (docs/).
// This does NOT scrape or schedule anything — it just serves the static site
// exactly as GitHub Pages would. Use `npm run server` for the full live backend.
import express from "express";
import path from "node:path";
import { ROOT } from "./lib.js";

const app = express();
const port = process.env.PORT || 8080;
app.use(express.static(path.join(ROOT, "docs")));
app.listen(port, () => {
  console.log(`[serve-static] http://localhost:${port}  (serving docs/)`);
});
