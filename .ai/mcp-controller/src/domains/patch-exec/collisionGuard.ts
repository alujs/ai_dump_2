export interface IntendedEffectSet {
  files: string[];
  symbols: string[];
  graphMutations: string[];
  externalSideEffects: string[];
}

interface Reservation {
  operationId: string;
  effects: IntendedEffectSet;
}

export class CollisionGuard {
  private readonly reservations = new Map<string, Reservation[]>();

  assertAndReserve(input: {
    sessionKey: string;
    operationId: string;
    effects: IntendedEffectSet;
    approvedExternalGates: string[];
  }): { ok: true } | { ok: false; rejectionCode: "EXEC_SIDE_EFFECT_COLLISION" | "EXEC_UNGATED_SIDE_EFFECT"; reason: string } {
    if (input.effects.externalSideEffects.length > 0) {
      const unauthorized = input.effects.externalSideEffects.filter(
        (effect) => !input.approvedExternalGates.includes(effect)
      );
      if (unauthorized.length > 0) {
        return {
          ok: false,
          rejectionCode: "EXEC_UNGATED_SIDE_EFFECT",
          reason: `External side effects lack commit gate: ${unauthorized.join(",")}`
        };
      }
    }

    const current = this.reservations.get(input.sessionKey) ?? [];
    for (const reservation of current) {
      if (reservation.operationId === input.operationId) {
        continue;
      }
      if (hasIntersection(reservation.effects.files, input.effects.files)) {
        return {
          ok: false,
          rejectionCode: "EXEC_SIDE_EFFECT_COLLISION",
          reason: "File mutation collision detected."
        };
      }
      if (hasIntersection(reservation.effects.symbols, input.effects.symbols)) {
        return {
          ok: false,
          rejectionCode: "EXEC_SIDE_EFFECT_COLLISION",
          reason: "Symbol reservation collision detected."
        };
      }
      if (hasIntersection(reservation.effects.graphMutations, input.effects.graphMutations)) {
        return {
          ok: false,
          rejectionCode: "EXEC_SIDE_EFFECT_COLLISION",
          reason: "Graph mutation collision detected."
        };
      }
      if (hasIntersection(reservation.effects.externalSideEffects, input.effects.externalSideEffects)) {
        return {
          ok: false,
          rejectionCode: "EXEC_SIDE_EFFECT_COLLISION",
          reason: "External side-effect collision detected."
        };
      }
    }

    current.push({
      operationId: input.operationId,
      effects: normalizeEffects(input.effects)
    });
    this.reservations.set(input.sessionKey, current);
    return { ok: true };
  }
}

function hasIntersection(left: string[], right: string[]): boolean {
  const set = new Set(left);
  return right.some((value) => set.has(value));
}

function normalizeEffects(value: IntendedEffectSet): IntendedEffectSet {
  return {
    files: dedupe(value.files),
    symbols: dedupe(value.symbols),
    graphMutations: dedupe(value.graphMutations),
    externalSideEffects: dedupe(value.externalSideEffects)
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter((item) => item.length > 0))];
}
