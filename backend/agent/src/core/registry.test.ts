import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEEP_ONLY_TOOLS } from '@lumina/contract';
import { ToolRegistry } from './registry.js';

/**
 * ToolRegistry — ARCHITECTURE.md §2.2: Map<name, ToolDef{name, description, zod schema,
 * execute, deepOnly?}>; forDepth('quick') STRUCTURALLY removes DEEP_ONLY_TOOLS ("a quick run
 * never calls plan_research" is a property of data flow, not a prompt instruction), and
 * dispatch enforces the same set — the R2 red line at the dispatch site, not just in the
 * advertised tool list.
 *
 * Invented API pinned here (flagged for green):
 *   - new ToolRegistry()                        no-arg constructor
 *   - register(def: ToolDef)                    def = {name, description, schema, execute, deepOnly?}
 *   - forDepth(depth): ToolDef[]                the depth-filtered advertisement list
 *   - dispatch(name, input, ctx): Promise<unknown>
 *     ctx is the ToolContext; it carries at least { depth } (dispatch filters by ctx.depth)
 *     and is passed through to execute untouched.
 */

interface Recorded {
  input: unknown;
  ctx: unknown;
}

function toolDef(
  name: string,
  overrides: Record<string, unknown> = {},
  record?: Recorded[]
) {
  return {
    name,
    description: `test tool ${name}`,
    schema: z.object({ query: z.string(), reason: z.string() }),
    execute: async (input: unknown, ctx: unknown) => {
      record?.push({ input, ctx });
      return { ranTool: name };
    },
    ...overrides
  };
}

function registryWithAllTools(record?: Recorded[]) {
  const registry = new ToolRegistry();
  registry.register(toolDef('web_search', {}, record));
  registry.register(toolDef('fetch_page', {}, record));
  registry.register(toolDef('plan_research', { deepOnly: true }, record));
  return registry;
}

describe('ToolRegistry.forDepth — depth-filtered advertisement', () => {
  it('excludes every DEEP_ONLY_TOOLS name from the quick tool list — the list simply lacks it', () => {
    const registry = registryWithAllTools();
    const quickNames = registry.forDepth('quick').map((t: { name: string }) => t.name);
    for (const deepOnly of DEEP_ONLY_TOOLS) {
      expect(quickNames).not.toContain(deepOnly);
    }
    expect(quickNames).toContain('web_search');
    expect(quickNames).toContain('fetch_page');
  });

  it('includes plan_research alongside the shared tools for deep', () => {
    const registry = registryWithAllTools();
    const deepNames = registry.forDepth('deep').map((t: { name: string }) => t.name);
    expect(deepNames).toContain('plan_research');
    expect(deepNames).toContain('web_search');
    expect(deepNames).toContain('fetch_page');
  });

  it('excludes a DEEP_ONLY_TOOLS name from quick even when it was registered without the deepOnly flag', () => {
    // The contract's DEEP_ONLY_TOOLS list is authoritative: a registration mistake
    // (forgetting the flag) must not be able to re-arm the R2 escalation.
    const registry = new ToolRegistry();
    registry.register(toolDef('web_search'));
    registry.register(toolDef('plan_research')); // note: no deepOnly flag
    const quickNames = registry.forDepth('quick').map((t: { name: string }) => t.name);
    expect(quickNames).not.toContain('plan_research');
  });
});

describe('ToolRegistry.dispatch — the R2 red line enforced at dispatch', () => {
  it('rejects a quick-depth dispatch of plan_research even though it is registered globally, without running execute', async () => {
    const record: Recorded[] = [];
    const registry = registryWithAllTools(record);
    await expect(
      registry.dispatch(
        'plan_research',
        { query: 'decompose this', reason: 'model asked for it' },
        { depth: 'quick' }
      )
    ).rejects.toThrow(/plan_research/);
    expect(record).toHaveLength(0);
  });

  it('dispatches plan_research at deep depth and returns the execute result', async () => {
    const registry = registryWithAllTools();
    await expect(
      registry.dispatch(
        'plan_research',
        { query: 'decompose this', reason: 'deep gear planning' },
        { depth: 'deep' }
      )
    ).resolves.toEqual({ ranTool: 'plan_research' });
  });

  it('rejects a tool name that was never registered', async () => {
    const registry = registryWithAllTools();
    await expect(
      registry.dispatch('make_presentation', { query: 'x', reason: 'y' }, { depth: 'deep' })
    ).rejects.toThrow();
  });
});

describe('ToolRegistry.dispatch — zod input validation', () => {
  it('rejects input that fails the tool zod schema, without running execute', async () => {
    const record: Recorded[] = [];
    const registry = registryWithAllTools(record);
    await expect(
      registry.dispatch('web_search', { query: 42, reason: 'wrong type' }, { depth: 'quick' })
    ).rejects.toThrow();
    expect(record).toHaveLength(0);
  });

  it('passes the schema-PARSED input (defaults applied) and the caller context through to execute, returning its result', async () => {
    const record: Recorded[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: 'web_search',
      description: 'search with a defaulted knob',
      schema: z.object({
        query: z.string(),
        reason: z.string(),
        maxResults: z.number().int().positive().default(3)
      }),
      execute: async (input: unknown, ctx: unknown) => {
        record.push({ input, ctx });
        return { ranTool: 'web_search' };
      }
    });
    const ctx = { depth: 'quick', requestId: 'req_test_1' };

    const result = await registry.dispatch(
      'web_search',
      { query: 'lumina', reason: 'find candidate pages' },
      ctx
    );

    expect(result).toEqual({ ranTool: 'web_search' });
    expect(record).toHaveLength(1);
    // Parsed, not raw: the schema default materialized.
    expect(record[0]!.input).toEqual({ query: 'lumina', reason: 'find candidate pages', maxResults: 3 });
    // The exact context object flows through untouched.
    expect(record[0]!.ctx).toBe(ctx);
  });
});
