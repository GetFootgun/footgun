// Runs detect patterns off the main thread so a runaway regex can be stopped.
// Before each (file, detect) pair it records the detect index and bumps a counter
// in shared memory; the main thread watches the counter and terminates on a stall.

import { parentPort, workerData } from "node:worker_threads";
import { matchRule } from "./rules.mjs";

const { detects } = workerData;
const progress = new Int32Array(workerData.progress);

parentPort.on("message", (batch) => {
  batch.forEach((file, i) => {
    const hits = [];
    for (const d of file.ds) {
      Atomics.store(progress, 1, d);
      Atomics.add(progress, 0, 1);
      const lines = matchRule(detects[d], file.rel, file.text);
      if (lines.length) hits.push([d, lines]);
    }
    parentPort.postMessage({ i, hits });
  });
});

parentPort.postMessage("ready");
