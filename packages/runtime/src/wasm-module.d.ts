/** A compiled WebAssembly module imported at build time (workerd, `@cloudflare/vite-plugin`). */
declare module '*.wasm?module' {
	const module: WebAssembly.Module;
	export default module;
}
