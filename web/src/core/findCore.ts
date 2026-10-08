// ABOUTME: The Find core: the stars the user chose, as distinct from support Find suggested. Find computes
// ABOUTME: from the core so it can swap its own earlier suggestions out. null means "core = selection".
import type { StarId } from "./types";

/**
 * Carry the core across one selection change: stars the change added join it (the user clicked them),
 * stars it removed leave it. Wholesale replacements (import, save load, reset, baseline restore, a hash
 * without fc=) do not come through here; their callers reset the core to null instead. A core that ends
 * equal to the selection, or empty, collapses to null.
 */
export function reconcileCore(core: Set<StarId> | null, prev: Set<StarId>, next: Set<StarId>): Set<StarId> | null {
  if (!core) return null;
  const out = new Set<StarId>();
  for (const s of core) if (next.has(s)) out.add(s);
  for (const s of next) if (!prev.has(s)) out.add(s);
  // out is a subset of next, so equal size means equal sets.
  return out.size === 0 || out.size === next.size ? null : out;
}
