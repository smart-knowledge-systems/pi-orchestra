/**
 * Conductor extension entrypoint.
 *
 * Initializes the pi-orchestra runtime on startup:
 *  - builds config from the repo root
 *  - creates the artifact store
 *  - loads or creates session state via the stage machine
 *
 * No raw repo file tools (read, bash, find, grep, ls, edit, write) are
 * exposed through this bootstrap — the conductor boundary is preserved.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createConfig } from '../src/runtime/config.ts';
import { ArtifactStore } from '../src/artifacts/store.ts';
import { StageMachine } from '../src/conductor/stage-machine.ts';

export default function (pi: ExtensionAPI) {
  const repoRoot = process.cwd();
  const config = createConfig(repoRoot);
  const store = new ArtifactStore(config);

  // Initialize the stage machine (loads or creates session state).
  // This is async but we fire-and-forget during boot — the machine
  // will be ready before any user interaction triggers a stage transition.
  const machineReady = StageMachine.init(config);

  // Stash references so later phases can access them from the extension
  // context without re-initializing.
  (pi as unknown as Record<string, unknown>).__orchestra = {
    config,
    store,
    machineReady,
  };
}
