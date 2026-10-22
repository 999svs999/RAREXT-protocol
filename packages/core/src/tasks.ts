import type { Task } from "./types.ts";

export const tasks: Task[] = [
  {
    id: "half-adder",
    title: "Add two bits",
    description:
      "Turn the answer on when exactly one start is on. Turn the extra on when both starts are on.",
    inputs: ["a", "b"],
    outputs: ["sum", "carry"],
    referenceGateCount: 5,
    cases: [
      { inputs: { a: 0, b: 0 }, outputs: { sum: 0, carry: 0 } },
      { inputs: { a: 0, b: 1 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 0 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 1 }, outputs: { sum: 0, carry: 1 } },
    ],
  },
  {
    id: "majority",
    title: "Majority vote",
    description:
      "Turn the answer on when two or more of the three starts are on.",
    inputs: ["a", "b", "c"],
    outputs: ["y"],
    referenceGateCount: 9,
    cases: [
      { inputs: { a: 0, b: 0, c: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 0, c: 1 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, c: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, c: 1 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 0, c: 0 }, outputs: { y: 0 } },
      { inputs: { a: 1, b: 0, c: 1 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 1, c: 0 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 1, c: 1 }, outputs: { y: 1 } },
    ],
  },
  {
    id: "mux2",
    title: "Pick a signal",
    description:
      "The chooser picks which start reaches the answer. When the chooser is off, pick A. When it is on, pick B.",
    inputs: ["a", "b", "sel"],
    outputs: ["y"],
    referenceGateCount: 4,
    cases: [
      { inputs: { a: 0, b: 0, sel: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 0, sel: 1 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, sel: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, sel: 1 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 0, sel: 0 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 0, sel: 1 }, outputs: { y: 0 } },
      { inputs: { a: 1, b: 1, sel: 0 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 1, sel: 1 }, outputs: { y: 1 } },
    ],
  },
];

export function findTask(id: string): Task | undefined {
  return tasks.find((task) => task.id === id);
}
