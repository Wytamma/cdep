import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "localhost", port: 5182, strictPort: true },
  preview: { host: "localhost", port: 5182, strictPort: true },
});
