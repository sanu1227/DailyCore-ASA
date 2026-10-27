export function codexResult(value, overrides = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { provider: 'codex', model: 'codex-test-model', text, value: text,
    usage: { total_tokens: 12, input_tokens: 8, output_tokens: 4 },
    firstTokenMs: 0, elapsedMs: 1, finishedAt: new Date().toISOString(), ...overrides };
}

export function fakeCodex(generate = async () => codexResult('알겠어.'), overrides = {}) {
  return { generate, probe: async () => ({ available: true, model: 'codex-test-model' }), close() {}, ...overrides };
}
