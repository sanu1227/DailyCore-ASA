import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const RIN_MODEL = 'gpt-6.1-sol';

// Process-local overrides only. Never change the user's Codex config or copy credentials.
const disabledFeatures = ['apps', 'plugins', 'remote_plugin', 'shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'browser_use', 'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'multi_agent', 'multi_agent_v2', 'memories', 'hooks', 'skill_search', 'goals', 'sleep_tool', 'workspace_dependencies', 'step_model_switching'];
const overrides = [
  'approval_policy="never"', 'sandbox_mode="read-only"', 'forced_login_method="chatgpt"', 'model_provider="openai"',
  'project_doc_max_bytes=0', 'developer_instructions=""', 'web_search="disabled"',
  'mcp_servers={}', 'agents.enabled=false', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'memories.use_memories=false', 'memories.generate_memories=false', 'cloud.skills.enabled=false',
  'orchestrator.mcp.enabled=false', 'tools.update_plan.enabled=false', 'tools.experimental_request_user_input.enabled=false',
  'features.skip_host_skill_discovery=true', ...disabledFeatures.map(name => `features.${name}=false`),
];

export function findCodexExecutable(env = process.env) {
  if (env.RIN_CODEX_EXE) {
    if (!existsSync(env.RIN_CODEX_EXE)) throw failure('notInstalled');
    return env.RIN_CODEX_EXE;
  }
  const installed = join(env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (env.LOCALAPPDATA && existsSync(installed)) {
    const choices = readdirSync(installed, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => join(installed, entry.name, 'codex.exe')).filter(path => existsSync(path));
    choices.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (choices[0]) return choices[0];
  }
  for (const folder of (env.PATH || env.Path || '').split(delimiter)) {
    const path = join(folder, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (folder && existsSync(path)) return path;
  }
  throw failure('notInstalled');
}

function failure(code, cause) {
  const text = `${cause?.message || ''} ${JSON.stringify(cause?.codexErrorInfo || cause?.data || '')}`;
  if (/usageLimitExceeded|tooManyRequests|rate.?limit|quota|usage.?limit|insufficient.*credit|429/i.test(text)) code = 'quota';
  else if (/unauthorized|unauthenticated|token.*expired|not.?logged|authentication|401/i.test(text)) code = 'auth';
  const details = {
    notInstalled: [503, 'Codex 실행 파일을 찾지 못했어요. Codex 앱을 설치하거나 RIN_CODEX_EXE 경로를 확인해 주세요.'],
    auth: [401, 'Codex의 ChatGPT 로그인이 필요해요. Codex 앱에서 로그인한 뒤 다시 보내 주세요.'],
    quota: [429, 'Codex 사용 한도에 도달했어요. Codex에서 사용량·결제 상태를 확인하거나 한도 회복 후 다시 보내 주세요. 다른 모델로 전환하지 않았어요.'],
    timeout: [504, 'Codex 응답 시간이 초과됐어요. 잠시 후 다시 보내 주세요. 다른 모델로 전환하지 않았어요.'],
    cancelled: [499, 'Codex 요청을 취소했어요.'],
    stopped: [503, 'Codex 연결이 종료됐어요. 다시 보내 주세요.'],
    crash: [502, 'Codex 실행이 중단됐어요. 다시 보내면 Codex에 다시 연결해요.'],
    tools: [403, '이 대화에서는 컴퓨터 작업과 도구 실행을 허용하지 않아요.'],
    isolation: [503, 'Codex 대화 전용 설정을 확인하지 못해 요청을 중단했어요.'],
    modelChanged: [502, 'Codex가 설정과 다른 모델로 전환하려 해 요청을 중단했어요.'],
    incomplete: [502, 'Codex가 답변을 끝까지 완성하지 못했어요. 다시 보내 주세요.'],
    protocol: [502, 'Codex 응답을 읽지 못했어요. Codex 앱을 업데이트하고 다시 보내 주세요.'],
    request: [502, 'Codex 요청이 실패했어요. 잠시 후 다시 보내 주세요.'],
  };
  const [status, message] = details[code] || details.request;
  return Object.assign(new Error(message), { code, status });
}

export function createCodexClient({ spawnImpl = spawn, executable, cwd = join(tmpdir(), 'rin-codex-runtime'), timeoutMs = 90000, startupTimeoutMs = 15000 } = {}) {
  let child, ready, closed = false, nextId = 0, catalog = [];
  const pending = new Map(), turns = new Map();
  const directory = resolve(cwd);
  const send = value => {
    if (!child?.stdin?.writable) throw failure('crash');
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const rpc = (method, params, wait = startupTimeoutMs) => new Promise((resolveReply, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(failure('timeout')); }, wait);
    pending.set(id, { resolve: resolveReply, reject, timer });
    try { send({ id, method, params }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const stopAll = error => {
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); }
    pending.clear();
    for (const value of turns.values()) value.fail(error);
    turns.clear();
  };
  const interrupt = state => {
    if (state.turnId && child) void rpc('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }, 2000).catch(() => {});
  };
  const receive = message => {
    if (message.id !== undefined && !message.method) {
      const value = pending.get(message.id);
      if (!value) return;
      clearTimeout(value.timer); pending.delete(message.id);
      if (message.error) value.reject(failure('request', message.error));
      else value.resolve(message.result);
      return;
    }
    const data = message.params || {}, state = turns.get(data.threadId);
    if (message.id !== undefined) {
      // Never grant tool approvals, credentials, user input or dynamic tool execution.
      try { send({ id: message.id, error: { code: -32601, message: 'Tools are disabled in this chat client.' } }); } catch {}
      if (state) { interrupt(state); state.fail(failure('tools')); }
      return;
    }
    if (!state || state.settled) return;
    if (data.turnId && state.turnId && data.turnId !== state.turnId) return;
    if (message.method === 'turn/started') state.turnId = data.turn?.id;
    else if (message.method === 'model/rerouted') { interrupt(state); state.fail(failure('modelChanged')); }
    else if (message.method === 'item/started') {
      const item = data.item;
      if (!['agentMessage', 'reasoning', 'userMessage'].includes(item?.type)) { interrupt(state); state.fail(failure('tools')); return; }
      state.items.set(item.id, item);
    } else if (message.method === 'item/agentMessage/delta') {
      if (state.items.get(data.itemId)?.phase === 'commentary') return;
      if (typeof data.delta === 'string') state.emit(data.delta);
    } else if (message.method === 'item/completed' && data.item?.type === 'agentMessage') {
      state.items.set(data.item.id, data.item);
    } else if (message.method === 'thread/tokenUsage/updated') {
      const usage = data.tokenUsage?.total;
      if (usage) state.usage = { total_tokens: usage.totalTokens, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, reasoning_tokens: usage.reasoningOutputTokens, cached_input_tokens: usage.cachedInputTokens };
    } else if (message.method === 'turn/completed') {
      const turn = data.turn;
      if (turn?.status !== 'completed') { state.fail(failure(turn?.status === 'interrupted' ? 'cancelled' : 'incomplete', turn?.error)); return; }
      for (const item of turn.items || []) if (item.type === 'agentMessage') state.items.set(item.id, item);
      const finals = [...state.items.values()].filter(item => item.type === 'agentMessage' && item.phase !== 'commentary');
      const text = finals.at(-1)?.text?.trim();
      if (!text) { state.fail(failure('incomplete')); return; }
      if (state.schema) { try { JSON.parse(text); } catch { state.fail(failure('protocol')); return; } }
      if (state.visible.trim() !== text) { if (state.visible) state.onReset?.(); state.visible = ''; state.firstTokenMs = null; state.emit(text); }
      state.complete(text);
    } else if (message.method === 'error' && !data.willRetry) state.fail(failure('request', data.error));
  };
  const ensureReady = async () => {
    if (closed) throw failure('stopped');
    if (ready) return ready;
    ready = (async () => {
      mkdirSync(directory, { recursive: true });
      const args = ['app-server', '--stdio', '--strict-config', ...overrides.flatMap(value => ['-c', value])];
      const processChild = spawnImpl(executable || findCodexExecutable(), args, { cwd: directory, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child = processChild;
      let buffer = '';
      processChild.stdout.setEncoding('utf8');
      processChild.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 8_000_000) { stopAll(failure('protocol')); processChild.kill(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try { receive(JSON.parse(line)); } catch { stopAll(failure('protocol')); processChild.kill(); return; }
        }
      });
      processChild.stderr.resume(); // Do not expose subprocess logs or authentication data.
      processChild.stdin.on('error', () => {});
      const crashed = () => { if (child === processChild) { child = null; ready = null; stopAll(failure(closed ? 'stopped' : 'crash')); } };
      processChild.on('error', crashed); processChild.on('exit', crashed);
      await rpc('initialize', { clientInfo: { name: 'rin_chat', title: 'Rin chat', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized', params: {} });
      const [account, models] = await Promise.all([rpc('account/read', { refreshToken: false }), rpc('model/list', { includeHidden: true })]);
      if (account.account?.type !== 'chatgpt') throw failure('auth');
      catalog = models.data || [];
      return { available: true, model: RIN_MODEL };
    })();
    try { return await ready; }
    catch (error) { const current = child; child = null; ready = null; current?.kill(); stopAll(error); throw error; }
  };
  return {
    async probe() {
      try {
        const result = await ensureReady();
        const account = await rpc('account/read', { refreshToken: false });
        return account.account?.type === 'chatgpt' ? result : { available: false, model: RIN_MODEL, reason: failure('auth').message };
      } catch (error) { return { available: false, model: RIN_MODEL, reason: error.message }; }
    },
    async generate({ messages, onDelta, onReset, schema, signal, reasoningEffort = 'low' }) {
      const started = Date.now();
      if (signal?.aborted) throw failure('cancelled');
      await ensureReady();
      const system = messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => message.content).join('\n\n');
      const conversation = messages.filter(message => ['user', 'assistant'].includes(message.role)).map(({ role, content }) => ({ role, content }));
      const thread = await rpc('thread/start', {
        cwd: directory, model: RIN_MODEL, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        allowProviderModelFallback: false, environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], dynamicTools: [],
        baseInstructions: 'You are a text-only conversation assistant. Answer the final user message using the supplied conversation. Do not use tools, inspect files, run commands, or access external services. The client handles all storage and actions.',
        developerInstructions: system, experimentalRawEvents: false,
      });
      const threadId = thread.thread?.id;
      if (!threadId) throw failure('protocol');
      let state, timer, abort;
      try {
        if (!thread.model) throw failure('protocol');
        if (thread.model !== RIN_MODEL) throw Object.assign(failure('modelChanged'), { model: thread.model });
        if (signal?.aborted) throw failure('cancelled');
        // Reported instruction paths alone do not establish content size. The zero
        // document budget and developer persona configure chat; check permissions separately.
        if (thread.modelProvider !== 'openai' || thread.sandbox?.type !== 'readOnly' || thread.approvalPolicy !== 'never') throw failure('isolation');
        const completion = new Promise((resolveTurn, rejectTurn) => {
          state = { threadId, turnId: null, items: new Map(), visible: '', firstTokenMs: null, usage: null, schema, onReset, settled: false,
            emit(delta) { if (this.settled || !delta) return; if (this.firstTokenMs === null && delta.trim()) this.firstTokenMs = Date.now() - started; this.visible += delta; onDelta?.(delta); },
            fail(error) { if (this.settled) return; this.settled = true; if (this.visible) onReset?.(); this.visible = ''; rejectTurn(Object.assign(error, { model: thread.model, usage: this.usage })); },
            complete(text) { if (this.settled) return; this.settled = true; resolveTurn({ text, value: text, model: thread.model, provider: 'codex', usage: this.usage, firstTokenMs: this.firstTokenMs, elapsedMs: Date.now() - started, finishedAt: new Date().toISOString() }); },
          };
          turns.set(threadId, state);
          timer = setTimeout(() => { interrupt(state); state.fail(failure('timeout')); }, Math.max(1, timeoutMs - (Date.now() - started)));
          abort = () => { interrupt(state); state.fail(failure('cancelled')); };
          signal?.addEventListener('abort', abort, { once: true });
        });
        // Notifications can arrive before the turn/start response; register state first.
        const modelInfo = catalog.find(model => model.model === thread.model || model.id === thread.model);
        const effort = modelInfo?.supportedReasoningEfforts?.some(value => value.reasoningEffort === reasoningEffort) ? reasoningEffort : undefined;
        const launch = rpc('turn/start', { threadId, input: [{ type: 'text', text: `Conversation JSON (roles delimit prior messages):\n${JSON.stringify(conversation)}` }], ...(effort ? { effort } : {}), ...(schema ? { outputSchema: schema } : {}), environments: [] })
          .then(value => { state.turnId = value.turn?.id || state.turnId; if (state.settled) interrupt(state); }, error => state.fail(error));
        const result = await completion;
        await launch;
        return result;
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); turns.delete(threadId);
        if (child) await rpc('thread/unsubscribe', { threadId }, 2000).catch(() => {});
      }
    },
    close() {
      closed = true;
      stopAll(failure('stopped'));
      const current = child; child = null; ready = null;
      current?.stdin.end(); current?.kill();
    },
  };
}
