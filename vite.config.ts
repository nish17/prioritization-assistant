import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the board into one self-contained HTML file (dist/board/index.html).
// Claude's sandbox only runs inline scripts, so nothing may load from our domain.
export default defineConfig({
  root: "src/board",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist/board",
    emptyOutDir: true,
  },
});
