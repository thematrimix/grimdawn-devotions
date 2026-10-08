// ABOUTME: A DevotionModel built from synthetic ReachCons, for tests that need stars (Find, fill):
// ABOUTME: each constellation is a chain unless predecessors are given; tagged constellations carry bonus "t".
import type { ReachCon } from "../../src/core/reachability";
import { AFFINITIES, type Constellation, type DevotionModel, type Star, type StarId } from "../../src/core/types";

export function modelOf(
  rcons: ReachCon[],
  tagged: Set<string> = new Set(),
  preds: Record<string, number[][]> = {},
): DevotionModel {
  const stars = new Map<StarId, Star>();
  const constellations = new Map<string, Constellation>();
  const mapOf = (v: number[]) => Object.fromEntries(AFFINITIES.map((a, i) => [a, v[i]!]).filter(([, n]) => n));
  for (const c of rcons) {
    const starIds: StarId[] = [];
    for (let i = 0; i < c.size; i++) {
      const id = `${c.id}:${i}` as StarId;
      starIds.push(id);
      const p = preds[c.id]?.[i] ?? (i ? [i - 1] : []);
      stars.set(id, {
        id,
        constellationId: c.id,
        index: i,
        predecessors: p.map((j) => `${c.id}:${j}` as StarId),
        position: { x: 0, y: 0 },
        bonuses: tagged.has(c.id) ? { t: 1 } : {},
        celestialPower: null,
        weaponRequirement: null,
      });
    }
    constellations.set(c.id, {
      id: c.id,
      nameTag: c.id,
      descriptionTag: null,
      tier: 1,
      affinityRequired: mapOf(c.req),
      affinityBonus: mapOf(c.grant),
      background: null,
      starIds,
    });
  }
  return { stars, constellations };
}
