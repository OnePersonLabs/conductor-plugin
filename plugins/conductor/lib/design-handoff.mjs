import { realpath } from 'node:fs/promises';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Conceptor owns semantic clearance. This adapter checks that its materialized
// result belongs to the request and worktree about to consume it.
export async function validateDesignHandoff({ config, payload, sourceIdentity, requestRevision, worktree, commonDir, execute, signal }) {
  if (!object(payload)) throw new Error('A reviewed designHandoff payload is required. Prepare it in the director/native planning path, then resume this original job.');
  const result = await execute(config.command, config.args, {
    cwd: worktree, signal, allowFailure: true, input: JSON.stringify({ ...payload, sourceIdentity, requestRevision }),
  });
  let packet;
  try { packet = JSON.parse(result.stdout); } catch {
    if (result.code !== undefined && result.code !== 0) throw new Error(`Design handoff adapter failed (${result.code}): ${result.stderr?.trim() || 'no structured diagnostic; inspect the adapter locally'}`);
    throw new Error('Design handoff adapter did not return valid JSON.');
  }
  const diagnostic = packet?.reason ?? packet?.summary ?? packet?.issues?.map(item => item.reason).filter(nonempty).join('; ');
  if (result.code !== undefined && result.code !== 0) throw new Error(`Design handoff adapter failed (${result.code}): ${diagnostic || result.stderr?.trim() || 'no structured diagnostic'}`);
  const bindings = packet?.bindings;
  if (packet?.format !== 'conceptor-design-handoff/1' || packet.status !== 'ready') throw new Error(`Design handoff is not ready: ${diagnostic || packet?.status || 'invalid format'}`);
  if (!object(bindings) || bindings.sourceIdentity !== sourceIdentity || bindings.requestRevision !== requestRevision || !nonempty(bindings.targetRoot) || await realpath(bindings.targetRoot) !== await realpath(worktree)) throw new Error('Design handoff belongs to a different request or target worktree.');
  if (!object(bindings.repository) || bindings.repository.kind !== 'git' || !nonempty(bindings.repository.commonDir) || commonDir && await realpath(bindings.repository.commonDir) !== await realpath(commonDir)) throw new Error('Design handoff belongs to a different Git repository.');
  for (const field of ['scopeHash', 'designHash', 'incrementHash', 'plannerId']) if (!nonempty(bindings[field])) throw new Error(`Design handoff lacks ${field}.`);
  const implementation = packet.implementation;
  if (!object(implementation) || !Array.isArray(implementation.capabilities) || !Array.isArray(implementation.sources) || !object(implementation.proposal) || !object(implementation.increment) || !object(implementation.context) || !Array.isArray(implementation.context.sections) || !Array.isArray(implementation.context.governing)) throw new Error('Design handoff lacks its materialized implementation context.');
  if (!nonempty(packet.review?.reviewerId) || packet.review.reviewerId === bindings.plannerId || !nonempty(packet.review.summary)) throw new Error('Design handoff lacks an independent reviewer result.');
  return packet;
}
