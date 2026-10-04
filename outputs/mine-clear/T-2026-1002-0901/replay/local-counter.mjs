// Audit-only connector. It performs no external action and records controlled calls.
export const TOOL_PATTERNS = ['audit.*'];
export function createToolExecutorForScope(scope) {
  return async (name, params) => {
    const state = globalThis.__growthAuditCounter;
    if (!state) throw new Error('Audit counter not configured');
    if (state.before) await state.before(name, params);
    state.calls.push({ name, params: structuredClone(params), scope, at: Date.now() });
    if (state.barrier) await state.barrier();
    return { result: { auditOnly: true, accepted: true }, receipt: { synced: true, mode: 'simulated' } };
  };
}
