import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Cargo rebuilds and local test profiles contain locked files and can be
    // extremely large; none of them participate in frontend hot reload.
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/.npm-cache/**", "**/.test-data/**"] },
  },
});
