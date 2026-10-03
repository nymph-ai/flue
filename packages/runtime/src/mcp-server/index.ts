/**
 * Flue MCP Capability Projection.
 *
 * Flue owns one canonical capability model and projects it into core MCP 2026-07-28
 * plus supported official/experimental extensions (Skills, Tasks, Events, Apps, Variants).
 *
 * Reference: docs/mcp-capability-projection.md
 */

export * from './types.ts';
export * from './ports.ts';
export * from './registry.ts';
export * from './search.ts';
export * from './profiles.ts';
export * from './operations.ts';
export * from './events.ts';
export * from './skills.ts';
export * from './apps.ts';
export * from './interceptor.ts';
export * from './server-card.ts';
export * from './projection.ts';
export * from './router.ts';
