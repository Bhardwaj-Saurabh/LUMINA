/**
 * ToolRegistry — ARCHITECTURE.md §2.2: Map<name, ToolDef>; forDepth('quick') STRUCTURALLY
 * removes DEEP_ONLY_TOOLS, and dispatch enforces the same set (R2 at the dispatch site,
 * not just in the advertised tool list). The contract's DEEP_ONLY_TOOLS list is
 * authoritative even when a registration forgot the deepOnly flag.
 */
import type { z } from 'zod';
import { DEEP_ONLY_TOOLS, type Depth } from '@lumina/contract';

/** Carried through to execute untouched; `depth` is what dispatch gates on. */
export interface ToolContext {
  depth: string;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** JSON-schema advertisement for the provider; zod v3 can't derive it, so tools declare both. */
  inputJsonSchema?: Record<string, unknown>;
  // Method syntax on purpose: bivariant params let a tool declare its parsed input type.
  execute(input: unknown, ctx: ToolContext): Promise<unknown>;
  deepOnly?: boolean;
}

const DEEP_ONLY = new Set<string>(DEEP_ONLY_TOOLS);

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  forDepth(depth: Depth): ToolDef[] {
    return [...this.tools.values()].filter((def) => this.allowedAt(def, depth));
  }

  async dispatch(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const def = this.tools.get(name);
    if (!def) throw new Error(`unknown tool: ${name}`);
    if (!this.allowedAt(def, ctx.depth)) {
      throw new Error(`tool ${name} is deep-only and cannot run at depth ${ctx.depth} (R2)`);
    }
    const parsed: unknown = def.schema.parse(input);
    return def.execute(parsed, ctx);
  }

  private allowedAt(def: ToolDef, depth: string): boolean {
    if (depth === 'deep') return true;
    return !def.deepOnly && !DEEP_ONLY.has(def.name);
  }
}
