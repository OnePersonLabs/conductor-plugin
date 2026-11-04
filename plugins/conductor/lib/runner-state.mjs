import { hostname } from 'node:os';
import { processExists } from './state.mjs';

export const RUNNER_PAUSED_MESSAGE = 'PAUSED -- run conductor resume to continue';

export function isLiveOwner(owner) {
  return Boolean(owner && owner.hostname === hostname() && owner.platform === process.platform && processExists(owner.pid));
}

// Callers inspecting disk must supply the owner, including null when missing.
// In-process callers use the already reconciled, persisted execution gate.
export function runnerPause(state, owner = undefined) {
  if (state.runnerPause) return state.runnerPause;
  if (owner !== undefined && state.running === true &&
      (!isLiveOwner(owner) || (state.ownerToken && state.ownerToken !== owner.token))) {
    return { reason: 'Previous runner exited before shutdown completed', at: state.updatedAt ?? null, interrupted: true };
  }
  return null;
}
