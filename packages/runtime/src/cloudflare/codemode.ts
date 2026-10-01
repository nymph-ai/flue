/**
 * `@flue/runtime/cloudflare/codemode`: QuickJS for Code Mode on Cloudflare
 * (docs/cloudflare-native.md rule 7). workerd cannot compile WebAssembly at
 * run time, so the QuickJS module is imported at build time, compiled, and
 * registered with the sandbox (`codemode/sandbox.ts`). The generated Worker
 * entry imports this module when an agent calls `useCodeMode()`, so apps
 * without Code Mode do not ship the 640 KB module.
 */
import quickjs from 'quickjs-wasi/quickjs.wasm?module';
import { registerQuickJSWasm } from '../codemode/sandbox.ts';

registerQuickJSWasm(quickjs);
