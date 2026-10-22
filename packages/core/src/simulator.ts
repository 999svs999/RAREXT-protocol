import type {
  Bit,
  Circuit,
  Component,
  InputValues,
  SimulationResult,
  Values,
} from "./types.ts";

const MAX_ITERATIONS = 64;

const ARITY: Record<Component["type"], number> = {
  INPUT: 0,
  OUTPUT: 1,
  NAND: 2,
  LATCH: 2,
};

export function validateCircuit(circuit: Circuit): void {
  const ids = new Set<string>();

  for (const component of circuit.components) {
    if (ids.has(component.id)) {
      throw new Error(`duplicate component id: ${component.id}`);
    }
    ids.add(component.id);
  }

  for (const component of circuit.components) {
    const inputs = component.inputs ?? [];
    const expected = ARITY[component.type];

    if (inputs.length !== expected) {
      throw new Error(
        `${component.id} (${component.type}) expects ${expected} inputs, got ${inputs.length}`,
      );
    }

    for (const input of inputs) {
      if (!ids.has(input)) {
        throw new Error(`${component.id} references unknown input: ${input}`);
      }
    }
  }
}

function evaluate(component: Component, values: Values): Bit {
  const inputs = component.inputs ?? [];

  if (component.type === "INPUT") {
    return values[component.id] ?? 0;
  }

  if (component.type === "OUTPUT") {
    return values[inputs[0] ?? ""] ?? 0;
  }

  if (component.type === "NAND") {
    const a = values[inputs[0] ?? ""] ?? 0;
    const b = values[inputs[1] ?? ""] ?? 0;
    return a === 1 && b === 1 ? 0 : 1;
  }

  const data = values[inputs[0] ?? ""] ?? 0;
  const enable = values[inputs[1] ?? ""] ?? 0;
  return enable === 1 ? data : values[component.id] ?? 0;
}

export function simulate(
  circuit: Circuit,
  inputs: InputValues,
  initial: Values = {},
): SimulationResult {
  validateCircuit(circuit);

  const values: Values = {};

  for (const component of circuit.components) {
    if (component.type === "INPUT") {
      const value = inputs[component.id];
      if (value !== 0 && value !== 1) {
        throw new Error(`missing or invalid input: ${component.id}`);
      }
      values[component.id] = value;
    } else {
      values[component.id] = initial[component.id] ?? 0;
    }
  }

  let iterations = 0;
  let settled = false;
  const trace: Values[] = [];

  for (let pass = 0; pass < MAX_ITERATIONS; pass++) {
    iterations = pass + 1;
    let changed = false;

    for (const component of circuit.components) {
      if (component.type === "INPUT") continue;

      const next = evaluate(component, values);
      if (next !== values[component.id]) {
        values[component.id] = next;
        changed = true;
      }
    }

    trace.push({ ...values });

    if (!changed) {
      settled = true;
      break;
    }
  }

  const outputs: Values = {};

  for (const component of circuit.components) {
    if (component.type === "OUTPUT") {
      outputs[component.id] = values[component.id] ?? 0;
    }
  }

  return { outputs, values, settled, iterations, trace };
}
