import { simulate } from "./simulator.ts";
import type { Circuit, DesignScore, Task } from "./types.ts";

export function countGates(circuit: Circuit): number {
  return circuit.components.filter(
    (component) => component.type === "NAND" || component.type === "LATCH",
  ).length;
}

export function score(circuit: Circuit, task: Task): DesignScore {
  let passed = 0;

  for (const testCase of task.cases) {
    const result = simulate(circuit, testCase.inputs);

    if (!result.settled) continue;

    const ok = task.outputs.every(
      (name) => result.outputs[name] === testCase.outputs[name],
    );

    if (ok) passed++;
  }

  const gateCount = countGates(circuit);
  const correct = passed === task.cases.length;
  const efficiency = gateCount === 0 ? 0 : task.referenceGateCount / gateCount;

  return {
    taskId: task.id,
    correct,
    passed,
    total: task.cases.length,
    gateCount,
    efficiency,
    score: correct ? Math.round(efficiency * 1000) : 0,
  };
}
