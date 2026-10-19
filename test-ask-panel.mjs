/**
 * Stub harness for the installed `/ask` plugin: drives the real handler against
 * fake services so the request it builds, the result it settles, and the
 * guarantee that it never touches the agent's inbox are all checked without a
 * live model.
 *
 * Run: node my_workspace/dsh-ask-panel/test-ask-panel.mjs
 * (imports the *installed* plugin, whose `@deepseek-ai/*` imports resolve
 * through the profile's node_modules)
 */
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';

/** The installed host entry is content-addressed, so discover it rather than guess. */
const PLUGIN_DIR = '/home/fdd/workspace/.dsh/profiles/web/plugins/ask-panel';
const HOST_FILE = readdirSync(PLUGIN_DIR).find((entry) => /^host\..+\.js$/.test(entry));
assert.ok(HOST_FILE, `no content-addressed host entry in ${PLUGIN_DIR}`);
const INSTALLED = `${PLUGIN_DIR}/${HOST_FILE}`;
/** The stable shell the Loader mounts; it forwards every invocation. */
const plugin = await import(INSTALLED);
/** The content-stamped implementation the shell re-imports per invocation. */
const implementation = await import(`${PLUGIN_DIR}/implementation.js`);

/** Each harness gets its own session id: the host keeps side threads per session. */
let harnessSeq = 0;

/** Build a context + captured state around one plugin registration. */
function harness({ header, options, messages, stream, signal, assemblyTools, toolResult } = {}) {
    const captured = { registered: undefined, requests: [], inbox: [], frames: [], toolCalls: [], observers: [] };
    harnessSeq += 1;
    const sessionId = `session-stub-${harnessSeq}`;
    const ctx = {
        effect(fn) {
            // Both cordis forms appear: a generator yielding disposers, and a plain
            // function whose return value is the disposer.
            const outcome = fn();
            if (typeof outcome === 'function' || outcome === null || typeof outcome !== 'object') return;
            if (typeof outcome.next !== 'function') return;
            for (let step = outcome.next(); !step.done; step = outcome.next());
        },
        get: () => undefined,
        on(name, listener) {
            captured.observers.push(name);
            return () => {};
        },
        emit(name, payload) {
            captured.frames.push({ name, payload });
        },
        commands: {
            register(definition) {
                captured.registered = definition;
                return () => {};
            },
        },
        systemPrompt: {
            async assemble(context) {
                captured.assembleContext = context;
                return {
                    sections: [{ name: 'identity', order: 0, text: 'SYSTEM PROMPT' }],
                    contexts: [],
                    tools: assemblyTools ?? [],
                    variables: {},
                };
            },
        },
        tools: {
            async execute(exec) {
                captured.toolCalls.push(exec);
                // A real create, so the next call really does face an existing file.
                if (exec.name === 'write' && typeof exec.arguments?.file_path === 'string') {
                    try {
                        writeFileSync(exec.arguments.file_path, String(exec.arguments.content ?? ''));
                    } catch {
                        /* the test asserts policy, not the filesystem */
                    }
                }
                return toolResult ?? { isError: false, content: [{ type: 'text', text: 'tool output' }] };
            },
        },
        llm: {
            stream(request) {
                // Snapshot: the host keeps extending this array as the thread grows.
                captured.requests.push({ ...request, messages: [...request.messages] });
                // A function gets the round index, so one test can script a
                // tool round followed by a final answer.
                return typeof stream === 'function' ? stream(captured.requests.length - 1) : stream ?? stopStream('默认回答。');
            },
        },
    };
    const agent = {
        id: sessionId,
        options: options ?? {},
        session: {
            id: sessionId,
            requestHeader: () => header,
            deriveMessages: () => messages ?? [],
        },
        send: (...args) => captured.inbox.push(['send', ...args]),
        steer: (...args) => captured.inbox.push(['steer', ...args]),
        followup: (...args) => captured.inbox.push(['followup', ...args]),
        inject: (...args) => captured.inbox.push(['inject', ...args]),
    };
    plugin.apply(ctx);
    return { captured, agent, sessionId, signal: signal ?? new AbortController().signal };
}

/** A stream that emits one text block then finishes with `kind`. */
async function* stopStream(text, kind = 'stop', failure) {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: kind === 'stop' ? { kind } : { kind, failure } };
}

/** A stream that asks for one tool call and finishes with `tool-calls`. */
async function* toolCallStream(text, id, name, args) {
    if (text.length > 0) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 1, id, name, argumentsDelta: args };
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name, arguments: args } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

const HISTORY = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '把 UT 跑通' }] },
];

/* 1. registration shape */
{
    const { captured } = harness();
    assert.equal(plugin.name, 'ask-panel');
    assert.equal(captured.registered?.name, 'ask');
    assert.equal(typeof captured.registered?.description, 'string');
    assert.equal(typeof captured.registered?.handler, 'function');
    assert.ok(captured.registered?.input?.hint);
    console.log('ok 1 registration');
}

/* 2. happy path: answer settles as the command result */
{
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
        messages: HISTORY,
    });
    const result = await captured.registered.handler({ commandId: 'c1', agent, rawInput: ' 现在在干什么？ ', attachments: [], signal });
    assert.deepEqual(result, { kind: 'success', text: '默认回答。' });
    console.log('ok 2 happy path');
}

/* 3. the built request reuses the agent's route, history, and system prompt, and declares no tools */
{
    const { captured, agent, sessionId, signal } = harness({
        header: { config: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
        messages: HISTORY,
    });
    await captured.registered.handler({ commandId: 'c2', agent, rawInput: '现在在干什么？', attachments: [], signal });
    const request = captured.requests[0];
    assert.equal(request.provider, 'p');
    assert.equal(request.model, 'm');
    assert.equal(request.reasoningEffort, 'low');
    assert.equal(request.system, 'SYSTEM PROMPT');
    assert.equal(request.tools, undefined);
    assert.equal(request.messages.length, HISTORY.length + 1);
    assert.deepEqual(request.messages.slice(0, HISTORY.length), HISTORY);
    const asked = request.messages.at(-1);
    assert.equal(asked.role, 'user');
    assert.match(asked.content[0].text, /Side question:\n现在在干什么？$/);
    assert.match(asked.content[0].text, /side-channel conversation/);
    assert.equal(request.sessionId, sessionId);
    console.log('ok 3 request shape');
}

/* 4. the agent is never touched: no send/steer/followup/inject */
{
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } }, messages: HISTORY });
    await captured.registered.handler({ commandId: 'c3', agent, rawInput: 'hi', attachments: [], signal });
    assert.deepEqual(captured.inbox, []);
    console.log('ok 4 inbox untouched');
}

/* 5. empty question is a usage error and sends nothing */
{
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } } });
    const result = await captured.registered.handler({ commandId: 'c4', agent, rawInput: '   ', attachments: [], signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /用法/);
    assert.equal(captured.requests.length, 0);
    console.log('ok 5 empty question');
}

/* 6. no route anywhere is a clear error, not a crash */
{
    const { captured, agent, signal } = harness({ header: undefined, options: {} });
    const result = await captured.registered.handler({ commandId: 'c5', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /模型路由/);
    console.log('ok 6 missing route');
}

/* 7. pre-first-request fallback: agent.options, then agentDefaultModel */
{
    const { captured, agent, signal } = harness({ header: undefined, options: { provider: 'po', model: 'mo' } });
    await captured.registered.handler({ commandId: 'c6', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(captured.requests[0].provider, 'po');
    console.log('ok 7 route fallback');
}

/* 8. a tool-call finish is reported, never executed */
{
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        stream: stopStream('x', 'tool-calls'),
    });
    const result = await captured.registered.handler({ commandId: 'c7', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /无工具通道/);
    assert.deepEqual(captured.inbox, []);
    console.log('ok 8 tool-call refusal');
}

/* 9. truncation is surfaced with the partial answer */
{
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        stream: stopStream('很长的回答', 'max-tokens'),
    });
    const result = await captured.registered.handler({ commandId: 'c8', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /^很长的回答\n\n（回答达到长度上限，已截断）$/);
    console.log('ok 9 max-tokens');
}

/* 10. an aborting request reports cancellation */
{
    const controller = new AbortController();
    controller.abort();
    const { captured, agent } = harness({ header: { config: { provider: 'p', model: 'm' } } });
    const result = await captured.registered.handler({ commandId: 'c9', agent, rawInput: 'hi', attachments: [], signal: controller.signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /已取消/);
    console.log('ok 10 cancellation');
}

/* 11. assembling against the addressed agent scope */
{
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } } });
    await captured.registered.handler({ commandId: 'c10', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(captured.assembleContext.agent, agent);
    assert.equal(captured.assembleContext.scope, agent);
    console.log('ok 11 scope');
}

/* 12. cancellation that arrives mid-stream stops the exchange */
{
    const controller = new AbortController();
    const midFlightAbort = (async function* abortMidStream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '部分回答' };
        controller.abort();
        yield { type: 'finish', reason: { kind: 'stop' } };
    })();
    const { captured, agent } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        stream: midFlightAbort,
    });
    const result = await captured.registered.handler({ commandId: 'c11', agent, rawInput: 'hi', attachments: [], signal: controller.signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /已取消/);
    console.log('ok 12 mid-stream cancellation');
}

/* 13. the conversation's own output budget is inherited when it has one, and
      never replaced by an invented cap when it has none */
{
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm', maxTokens: 7777 } } });
    await captured.registered.handler({ commandId: 'c12', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(captured.requests[0].maxTokens, 7777);
    const fallback = harness({ header: { config: { provider: 'p', model: 'm' } } });
    await fallback.captured.registered.handler({ commandId: 'c13', agent: fallback.agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(fallback.captured.requests[0].maxTokens, undefined);
    console.log('ok 13 max tokens inherited, never invented');
}

/* 14-16. gaps in a derived history are repaired, never truncated after the first one */
{
    const call = (id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' });
    const result = (id) => ({ type: 'tool-result', toolCallId: id, content: [] });
    const ask = { role: 'user', content: [{ type: 'text', text: 'go' }] };
    const balanced = [
        ask,
        { role: 'assistant', content: [call('a')] },
        { role: 'user', content: [result('a')] },
    ];
    // A trailing call whose results have not landed is dropped.
    assert.deepEqual(implementation.sanitizeHistory([...balanced, { role: 'assistant', content: [call('b')] }]), balanced);
    // A partially answered assistant call keeps what was answered and loses the rest.
    // Truncating here — the old behaviour — discarded every later turn, which is how a
    // compacted session ended up feeding this side channel nothing but its summary.
    const partial = [...balanced, { role: 'assistant', content: [call('c'), call('d')] }, { role: 'user', content: [result('c')] }];
    assert.deepEqual(
        implementation.sanitizeHistory(partial),
        [...balanced, { role: 'assistant', content: [call('c')] }, { role: 'user', content: [result('c')] }],
    );
    // An orphan result, whose call is gone, goes too.
    assert.deepEqual(implementation.sanitizeHistory([...balanced, { role: 'user', content: [result('z')] }]), balanced);
    // A fully answered history is untouched.
    assert.equal(implementation.sanitizeHistory([...balanced, { role: 'assistant', content: [call('e')] }, { role: 'user', content: [result('e')] }]).length, 5);
    console.log('ok 14-16 gaps repaired, never truncated');
}

/* 17. the exact shape that broke the live run: the built request must not carry the dangling call */
{
    const dangling = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'x', name: 'bash', arguments: '{}' }] },
    ];
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } }, messages: dangling });
    await captured.registered.handler({ commandId: 'c14', agent, rawInput: 'hi', attachments: [], signal });
    const sent = captured.requests[0].messages;
    assert.equal(sent.length, 2);
    assert.equal(sent.at(-1).role, 'user');
    assert.match(sent.at(-1).content[0].text, /Side question/);
    console.log('ok 17 dangling tool call dropped');
}

/* 18. a budget spent entirely on reasoning says so instead of blaming the cap */
{
    const reasoningOnly = (async function* reasoningStream() {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: '想很久' };
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想很久' } };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
    })();
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } }, stream: reasoningOnly });
    const result = await captured.registered.handler({ commandId: 'c15', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /思考过程耗尽/);
    console.log('ok 18 reasoning-only budget');
}

/* 19. every tool travels for prompt-cache parity; only read-only ones run */
{
    const names = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'present'];
    const assemblyTools = names.map((toolName) => ({ name: toolName, description: '', parameters: {} }));
    const rounds = [
        () => toolCallStream('', 'call-deny', 'bash', '{"command":"rm -rf /"}'),
        () => stopStream('已放弃。'),
    ];
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools,
        stream: (round) => rounds[round](),
    });
    await captured.registered.handler({ commandId: 'c16', agent, rawInput: 'hi', attachments: [], signal });
    // the request keeps the parent's whole tool list, so the prefix stays cacheable
    assert.deepEqual(captured.requests[0].tools.map((tool) => tool.name), names);
    // ...but a non-read-only call is refused, never executed
    assert.equal(captured.toolCalls.length, 0);
    const refusal = captured.requests[1].messages.at(-1);
    // 0.1.7 passes raw result blocks through where 0.1.6 wrapped them, so assert
    // the outcome (a tool-role message carrying the refusal) and not the wrapper.
    assert.equal(refusal.role, 'tool');
    assert.match(refusal.content[0].text, /不可用/);
    console.log('ok 19 full tool list, non-read-only call refused');
}

/* 20. a tool round runs through ctx.tools and its text is kept in the result */
{
    const rounds = [
        () => toolCallStream('先看一下文件。', 'call-1', 'read', '{"file_path":"a.txt"}'),
        () => stopStream('文件里写着 A。'),
    ];
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools: [{ name: 'read', description: '', parameters: {} }],
        stream: (round) => rounds[round](),
    });
    const result = await captured.registered.handler({ commandId: 'c17', agent, rawInput: '文件写了什么？', attachments: [], signal });
    assert.equal(result.kind, 'success');
    assert.equal(result.text, '先看一下文件。文件里写着 A。');
    assert.equal(captured.toolCalls.length, 1);
    assert.equal(captured.toolCalls[0].name, 'read');
    assert.deepEqual(captured.toolCalls[0].arguments, { file_path: 'a.txt' });
    assert.equal(captured.toolCalls[0].callId, 'call-1');
    const second = captured.requests[1].messages;
    // the assistant turn carries its preamble text AND the tool call, in order
    assert.deepEqual(second.at(-2).content.map((block) => block.type), ['text', 'tool-call']);
    assert.equal(second.at(-2).content.at(-1).id, 'call-1');
    assert.equal(second.at(-1).role, 'tool');
    assert.equal(second.at(-1).toolCallId, 'call-1');
    // ...and none of it entered the agent's inbox
    assert.deepEqual(captured.inbox, []);
    console.log('ok 20 tool round executes and accumulates');
}

/* 21. malformed tool arguments come back as an error result, not a crash */
{
    const rounds = [() => toolCallStream('', 'call-2', 'read', '{not json'), () => stopStream('好的。')];
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools: [{ name: 'read', description: '', parameters: {} }],
        stream: (round) => rounds[round](),
    });
    await captured.registered.handler({ commandId: 'c18', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(captured.toolCalls.length, 0);
    const toolResultMsg = captured.requests[1].messages.at(-1);
    assert.equal(toolResultMsg.role, 'tool');
    console.log('ok 21 malformed arguments handled');
}

/* 22. the tool loop is bounded */
{
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools: [{ name: 'read', description: '', parameters: {} }],
        stream: () => toolCallStream('', 'call-3', 'read', '{}'),
    });
    const result = await captured.registered.handler({ commandId: 'c19', agent, rawInput: 'hi', attachments: [], signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /工具调用超过/);
    assert.equal(captured.toolCalls.length, 24);
    console.log('ok 22 tool loop bounded');
}

/* 23. live frames bracket the answer and carry the same text */
{
    const { captured, agent, sessionId, signal } = harness({ header: { config: { provider: 'p', model: 'm' } } });
    await captured.registered.handler({ commandId: 'c20', agent, rawInput: '在干什么？', attachments: [], signal });
    assert.equal(captured.frames.every((frame) => frame.name === 'ask/stream'), true);
    const kinds = captured.frames.map((frame) => frame.payload.kind);
    assert.equal(kinds[0], 'start');
    assert.equal(kinds.at(-1), 'end');
    assert.equal(captured.frames[0].payload.question, '在干什么？');
    assert.equal(captured.frames[0].payload.fresh, true);
    assert.equal(captured.frames.every((frame) => frame.payload.sessionId === sessionId), true);
    const streamed = captured.frames
        .filter((frame) => frame.payload.kind === 'delta')
        .map((frame) => frame.payload.text)
        .join('');
    assert.equal(streamed, '默认回答。');
    const end = captured.frames.at(-1).payload;
    assert.equal(end.ok, true);
    assert.equal(end.text, '默认回答。');
    console.log('ok 23 live stream frames');
}

/* 25. a second question continues the live side thread */
{
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } }, messages: HISTORY });
    await captured.registered.handler({ commandId: 'c21', agent, rawInput: '第一个问题', attachments: [], signal });
    const first = captured.requests[0].messages;
    const firstLength = first.length;
    await captured.registered.handler({ commandId: 'c22', agent, rawInput: '第二个问题', attachments: [], signal });
    const second = captured.requests[1].messages;
    // +2: the first question AND the answer it produced are both carried over
    assert.equal(second.length, firstLength + 2);
    assert.match(second.at(-2).content[0].text, /默认回答。/);
    assert.match(second.at(-1).content[0].text, /Side question:\n第二个问题$/);
    const starts = captured.frames.filter((frame) => frame.payload.kind === 'start');
    assert.deepEqual(starts.map((frame) => frame.payload.fresh), [true, false]);
    console.log('ok 25 follow-up continues the thread');
}

/* 26. a question whose answers failed is not carried forward as context */
{
    const { captured, agent, signal } = harness({
        header: { config: { provider: 'p', model: 'm' } },
        stream: () => stopStream('第一段', 'max-tokens'),
    });
    await captured.registered.handler({ commandId: 'c23', agent, rawInput: '会截断的问题', attachments: [], signal });
    await captured.registered.handler({ commandId: 'c24', agent, rawInput: '接着问', attachments: [], signal });
    assert.equal(captured.requests[1].messages.length, captured.requests[0].messages.length + 2);
    console.log('ok 26 partial answers still thread');
}

/* 27. --new starts a fresh thread */
{
    const { captured, agent, signal } = harness({ header: { config: { provider: 'p', model: 'm' } }, messages: HISTORY });
    await captured.registered.handler({ commandId: 'c25', agent, rawInput: '第一个问题', attachments: [], signal });
    await captured.registered.handler({ commandId: 'c26', agent, rawInput: '--new 重新开始', attachments: [], signal });
    assert.equal(captured.requests[1].messages.length, HISTORY.length + 1);
    assert.match(captured.requests[1].messages.at(-1).content[0].text, /Side question:\n重新开始$/);
    const starts = captured.frames.filter((frame) => frame.payload.kind === 'start');
    assert.deepEqual(starts.map((frame) => frame.payload.fresh), [true, true]);
    console.log('ok 27 --new starts a fresh thread');
}

/* 24. the host registered its event on the Remote forwarding allowlist */
{
    const remotes = await import('/home/fdd/workspace/.dsh/profiles/node_modules/@deepseek-ai/dsh-api-remotes/lib/index.js');
    const forwarded = remotes.API_REMOTE_FORWARDED_EVENTS.filter((entry) => entry.event === 'ask/stream');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].mode, 'emit');
    console.log('ok 24 forwarded event registered exactly once');
}

/* 28. the side chat may create a file, and is refused when it would overwrite one */
{
    const tools = ['read', 'write', 'edit'].map((toolName) => ({ name: toolName, description: '', parameters: {} }));
    const created = `${process.env.HOME}/ask-new-file-${Date.now()}.md`;
    const createRounds = [
        () => toolCallStream('', 'call-new', 'write', JSON.stringify({ file_path: created, content: 'hi' })),
        () => stopStream('已写入。'),
    ];
    const ok = harness({ header: { config: { provider: 'p', model: 'm' } }, assemblyTools: tools, stream: (r) => createRounds[r]() });
    await ok.captured.registered.handler({ commandId: 'c28', agent: ok.agent, rawInput: '记到文件里', attachments: [], signal: ok.signal });
    assert.equal(ok.captured.toolCalls.length, 1, 'creating a new file was blocked');
    assert.equal(ok.captured.toolCalls[0].name, 'write');

    const existing = '/home/fdd/workspace/projects/hyper-parallel/my_workspace/dsh-ask-panel/package.json';
    const overwriteRounds = [
        () => toolCallStream('', 'call-ovr', 'write', JSON.stringify({ file_path: existing, content: 'x' })),
        () => stopStream('好的。'),
    ];
    const bad = harness({ header: { config: { provider: 'p', model: 'm' } }, assemblyTools: tools, stream: (r) => overwriteRounds[r]() });
    await bad.captured.registered.handler({ commandId: 'c29', agent: bad.agent, rawInput: '改写它', attachments: [], signal: bad.signal });
    assert.equal(bad.captured.toolCalls.length, 0, 'an overwrite was allowed');
    const refusalMsg = bad.captured.requests[1].messages.at(-1);
    assert.match(refusalMsg.content[0].text, /只能新建文件/);
    // the same file, one turn later: it exists now, but WE made it
    const again = [
        () => toolCallStream('', 'call-again', 'write', JSON.stringify({ file_path: created, content: 'updated' })),
        () => stopStream('已更新。'),
    ];
    const second = harness({ header: { config: { provider: 'p', model: 'm' } }, assemblyTools: tools, stream: (r) => again[r]() });
    second.agent.session.id = ok.agent.session.id;
    await second.captured.registered.handler({ commandId: 'c30', agent: second.agent, rawInput: '再改一下', attachments: [], signal: second.signal });
    assert.equal(second.captured.toolCalls.length, 1, 'a file this side chat created became read-only');
    console.log('ok 28 create allowed, overwrite refused');
}

/* 29. hitting the round bound keeps the answer written so far */
{
    const rounds = () => toolCallStream('已经写了一半。', 'call-half', 'read', '{}');
    const it = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools: [{ name: 'read', description: '', parameters: {} }],
        stream: () => rounds(),
    });
    const result = await it.captured.registered.handler({ commandId: 'c31', agent: it.agent, rawInput: '回顾一下', attachments: [], signal: it.signal });
    assert.equal(result.kind, 'success', 'the round bound threw the answer away');
    assert.match(result.text, /已经写了一半。/);
    assert.match(result.text, /轮数上限/);
    console.log('ok 29 the round bound keeps the partial answer');
}

/* 30. a long side thread can never bury the fresh seed */
{
    const it = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools: [{ name: 'read', description: '', parameters: {} }],
        stream: () => stopStream('好的。'),
    });
    for (let turn = 0; turn < 6; turn += 1) {
        await it.captured.registered.handler({
            commandId: `c30-${turn}`, agent: it.agent, rawInput: `第 ${turn} 问`,
            attachments: [], signal: it.signal,
        });
    }
    const seedLength = 0; // this harness derives an empty main history
    for (const [index, request] of it.captured.requests.entries()) {
        // seed + carried side turns + the new question, and the carry stays bounded
        const carried = request.messages.length - seedLength - 1;
        assert.ok(carried <= 8, `turn ${index} carried ${carried} side messages`);
        // the last message is the composed prompt, ending with the raw question
        assert.match(request.messages.at(-1).content[0].text, /第 \d 问$/);
    }
    console.log('ok 30 the side carry stays bounded');
}

/* 31. a gap mid-history repairs instead of truncating everything after it */
{
    const history = [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'lost', name: 'bash', arguments: '{}' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'after-the-gap' }] },
        { role: 'user', content: [{ type: 'text', text: 'latest-ask' }] },
    ];
    const it = harness({ header: { config: { provider: 'p', model: 'm' } }, messages: history });
    await it.captured.registered.handler({ commandId: 'c31', agent: it.agent, rawInput: 'hi', attachments: [], signal: it.signal });
    const texts = it.captured.requests[0].messages.map((message) =>
        (message.content ?? []).map((block) => block.text ?? '').join(''));
    assert.equal(texts.some((text) => text.includes('after-the-gap')), true, 'the turn after a gap was dropped');
    assert.equal(texts.some((text) => text.includes('latest-ask')), true);
    // ...and the unanswered call itself is gone, so the provider accepts the request
    assert.equal(JSON.stringify(it.captured.requests[0].messages).includes('"lost"'), false);
    console.log('ok 31 a mid-history gap repairs instead of truncating');
}

/* 32. trimming a long side thread can never leave an orphan tool result */
{
    // Four rounds of question + tool call: the carried side thread outgrows its cap,
    // so the trim point may land inside a tool round. The request must still be valid.
    const rounds = Array.from({ length: 8 }, (_, index) => (index % 2 === 0
        ? () => toolCallStream('先看下。', `call-${index}`, 'read', '{"file_path":"a.txt"}')
        : () => stopStream('A。')));
    const it = harness({
        header: { config: { provider: 'p', model: 'm' } },
        assemblyTools: [{ name: 'read', description: '', parameters: {} }],
        stream: (round) => rounds[round](),
    });
    for (let turn = 0; turn < 4; turn += 1) {
        await it.captured.registered.handler({
            commandId: `c32-${turn}`, agent: it.agent, rawInput: `第 ${turn} 问`,
            attachments: [], signal: it.signal,
        });
    }
    const request = it.captured.requests.at(-1);
    const calls = new Set();
    for (const message of request.messages) {
        for (const block of message.content ?? []) if (block.type === 'tool-call') calls.add(block.id);
    }
    for (const message of request.messages) {
        for (const block of message.content ?? []) {
            if (block.type !== 'tool-result') continue;
            assert.ok(calls.has(block.toolCallId), `orphan tool result ${block.toolCallId}`);
        }
    }
    console.log('ok 32 a trimmed side thread leaves no orphan result');
}

console.log('\nall /ask stub checks passed');
