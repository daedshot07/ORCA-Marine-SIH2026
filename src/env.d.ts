/// <reference types="vite/client" />

// Vite turns a CSS import into a side effect that injects the stylesheet.
// TypeScript needs telling that the module exists and exports nothing.
declare module "*.css";

interface ImportMetaEnv {
  /** Chat assistant. On in .env.staging, off in .env.production. */
  readonly VITE_FLAG_CHAT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
