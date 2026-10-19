/**
 * `/ask` — ask a side question about the work in progress, without touching it.
 *
 * The Claude Code `/ask` semantics, rebuilt on dsh's own seams: the answer is
 * produced from the exact context the addressed agent already holds — the
 * assembled system prompt plus the durable, model-visible history — by a
 * bounded, **read-only** tool loop, streamed to the browser as it is written.
 * The exchange then settles as this command's own `command/run` /
 * `command/done` records.
 *
 * Why it cannot disturb the main task:
 *
 * - The request is assembled here and dispatched straight to the LLM service,
 *   so it never enters the agent's inbox. Steering, by contrast, is a durable
 *   `user/message` that the running loop reads at its next step boundary and
 *   answers with tools.
 * - `Session.deriveEventMessage()` projects only `user/message`,
 *   `system/message`, `assistant/message`, and `tool/result`, so the logged
 *   `command/run`/`command/done` pair is never part of a later request: the
 *   question, the answer, and every side tool call stay out of the model
 *   context for good.
 * - Only {@link READ_ONLY_TOOLS} are offered, so the loop can look things up
 *   without any way to modify the workspace.
 *
 * Known limits, inherited from that design:
 *
 * - The assistant message currently being streamed is not in the log yet, so
 *   `/ask` sees the conversation up to the last settled step.
 * - Auxiliary calls are not attributed to the session's token meter, so `/ask`
 *   does not appear in the context/cost readouts.
 * - Streaming rides a Cordis event forwarded to the browser, because the
 *   Remote assembly forwards a fixed allowlist of Host events. This plugin
 *   appends its own entry to that exported allowlist (see {@link apply}).
 *
 * Loaded per invocation by the stable `host.js` shell, content-stamped so an
 * edit is picked up without a server restart.
 *
 * @module dsh-ask-panel/implementation
 */
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockAssembler, ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { deadline } from '@deepseek-ai/dsh-timeout';

/**
 * Revision stamp for the self-report log, bumped with any plugin change — host
 * or client half. Two jobs: it makes "which revision is actually executing"
 * readable from outside a process that caches ES modules by URL, and changing it
 * changes the content-addressed host filename, which is what makes the host
 * re-activate and re-read the client bundle as well.
 */
const BUILD = 'markdown-1';

/** Where this module reports that it loaded and whether its frames went out. */
const LOAD_LOG = fileURLToPath(new URL('./ask-panel-load.log', import.meta.url));

/**
 * Append one diagnostic line. Best-effort by construction: diagnostics must
 * never be able to break the command they describe.
 *
 * @param line - what happened.
 */
function trace(line) {
    try {
        appendFileSync(LOAD_LOG, `${new Date().toISOString()} pid=${process.pid} ${BUILD} ${line}\n`);
    } catch {
        /* A diagnostic that cannot be written is not a reason to fail. */
    }
}

/** Shown when `ask` is invoked without a question. */
const USAGE = '用法：/ask <问题>（再次调用会接着上次的侧边对话追问；加 --new 可重新开始）';

/**
 * Side-channel framing for the side question. It is carried by the final user
 * message rather than merged into the system prompt, so the system string stays
 * byte-identical to the running agent's and the shared prefix stays cacheable.
 *
 * Wording follows kimi-code's side-question reminder, including the line about
 * disabled tools: the full tool list travels with every request for prompt-cache
 * reasons, so the model must be told that a visible tool will be refused.
 */
const FRAMING = [
    'This is a side-channel conversation with the human, opened while the task above is still running.',
    'Answer their questions directly.',
    '',
    'IMPORTANT:',
    '- You are a separate, lightweight instance. The main agent continues independently; do not act as if',
    '  it was interrupted, and never claim to have changed state on its behalf.',
    '- You may use the read-only tools Read (read), Grep, and Glob. You may also use the Write tool, but ONLY',
    '  to create a file that does not exist yet: writing to an existing path is rejected, because this side',
    '  channel must never modify what is already on disk. Every other tool is disabled',
    '  and will be rejected with an error even though its definition is visible in this request — the',
    '  definitions are present only so this request keeps the main conversation\'s prompt-cache prefix.',
    '- Prefer what the conversation already tells you; reach for those tools only when the answer',
    '  depends on file contents you have not seen.',
    '- Be economical: a few targeted reads beat many speculative ones. This is a side channel, and',
    '  every round it spends is a round the human waits.',
    '- Follow-up questions may arrive in this same side channel; keep the thread coherent.',
    '- The main conversation above is the CURRENT state. Earlier turns of this side channel are context',
    '  only and may describe a state that has since changed: when the two disagree, trust the main',
    '  conversation. If the difference matters for the answer, say which one you are relying on.',
    '- If you do not know, say so directly and briefly.',
].join('\n');

/** Time budget for one side answer; the LLM layer keeps its retry policy inside it. */
const TIMEOUT_MS = 300_000;

/** Capability-owned timeout code stamped onto the abort reason. */
const TIMEOUT_CODE = 'BTW_TIMEOUT';

/** The first text block of a message, shortened for one log line. */
function snippet(message) {
    if (message === undefined) return '-';
    const text = (message.content ?? []).map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('');
    return `${message.role}:${String(text).replace(/\s+/g, ' ').slice(0, 70)}`;
}

/** Record what one question was seeded with; diagnostics never break an answer. */
function traceSeed(sessionId, raw, kept) {
    try {
        appendFileSync(
            new URL('./ask-panel-load.log', import.meta.url),
            `${new Date().toISOString()} seed ${sessionId} raw=${raw.length} kept=${kept.length}`
                + ` first=${snippet(kept[0])} last=${snippet(kept.at(-1))}\n`,
        );
    } catch {
        /* a failed diagnostic is not a failed answer */
    }
}

/**
 * Tools a side answer may actually run. The full tool list still travels with
 * each request — dropping schemas would change the prompt-cache prefix — so this
 * is enforced at dispatch instead, exactly as kimi-code does: anything outside
 * the set comes back to the model as a refusal.
 */
const READ_ONLY_TOOLS = ['read', 'glob', 'grep'];

/**
 * Tools the side chat may use **only to create a file**. `write` overwrites, so it
 * is admitted on the condition that the target does not exist yet — checked here,
 * before dispatch, because by the time the tool reports anything the old bytes are
 * already gone. A refusal is recoverable; an overwrite is not.
 */
const CREATE_ONLY_TOOLS = ['write'];

/**
 * Bound on tool rounds, so one side question cannot spin forever. Counted in
 * model requests, not tool calls — six of them starved any question that needed
 * more than a couple of files, which is most of them.
 */
const MAX_TOOL_STEPS = 24;

/** Producer identity recorded on every side message this module builds. */
const PLUGIN_NAME = 'ask-panel';

/** Host event carrying live side-answer frames to the browser. */
const STREAM_EVENT = 'ask/stream';

/** Flush a pending text buffer once it reaches this many characters. */
const DELTA_FLUSH_CHARS = 48;

/** ...or once this long has passed, so a slow stream still types out. */
const DELTA_FLUSH_MS = 60;



/** `/ask --new <question>` starts a fresh side thread instead of continuing one. */
const NEW_THREAD_PREFIX = '--new';

/** `/ask --reset` drops the side thread and asks nothing. */
const RESET_FLAG = '--reset';



/**
 * Paths this side chat created, per session. Without this the create-only rule
 * would block its own follow-up edits: the file exists on the second write, so
 * the existence check alone cannot tell "we made it" from "the user had it".
 */
const createdBySideChat = new Map();

/**
 * Resolve the exact model route the addressed agent uses, so a side question
 * shares that conversation's prompt cache instead of paying for a cold prefix.
 *
 * The logged request header is authoritative (an agent may leave `options`
 * empty and receive its route from the `agent/request` waterfall); the other
 * two sources only matter before the session's first request.
 *
 * `maxTokens` is copied only when the conversation actually declares one:
 * inventing a smaller side-question budget truncated real answers, and an
 * absent field lets the adapter's own default apply instead.
 *
 * @param ctx - plugin context carrying the optional default-model service.
 * @param agent - the addressed agent.
 * @returns the resolved route, or `undefined` when no route is known yet.
 */
function resolveRoute(ctx, agent) {
    const logged = agent.session.requestHeader()?.config;
    const selection = logged?.provider && logged.model ? logged
        : agent.options.provider && agent.options.model ? agent.options
            : ctx.get('agentDefaultModel')?.currentSelection();
    if (!selection?.provider || !selection.model) return undefined;
    return {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        ...selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens },
    };
}

/**
 * Make a derived history safe for the provider without discarding it.
 *
 * The provider rejects a request as a whole when any assistant `tool-call` lacks
 * its `tool-result`, or any result lacks its call. A history that lost either
 * half — compaction is the usual way, since the summary replaces the covered
 * events — therefore used to be "repaired" by truncating at the first gap, which
 * silently dropped every later turn. That is why a compacted session showed this
 * side channel only its summary.
 *
 * Repair the gaps instead: remove the unanswered call blocks, then the orphan
 * result blocks, then any message the removal emptied. Everything that could be
 * said is still said.
 *
 * @param messages - the agent's model-visible history.
 * @returns a history the provider will accept.
 */
export function sanitizeHistory(messages) {
    const answered = new Set();
    for (const message of messages) {
        for (const block of message.content ?? []) {
            if (block.type === 'tool-result') answered.add(block.toolCallId);
        }
    }
    const called = new Set();
    for (const message of messages) {
        for (const block of message.content ?? []) {
            if (block.type === 'tool-call' && answered.has(block.id)) called.add(block.id);
        }
    }
    const kept = [];
    for (const message of messages) {
        const original = message.content ?? [];
        const blocks = original.filter((block) => {
            if (block.type === 'tool-call') return answered.has(block.id);
            if (block.type === 'tool-result') return called.has(block.toolCallId);
            return true;
        });
        if (blocks.length === 0) continue;
        // Derived messages are shared and deep-frozen: copy rather than mutate.
        kept.push(blocks.length === original.length ? message : { ...message, content: blocks });
    }
    return kept;
}

/**
 * Join the text blocks of one assembled response.
 *
 * @param blocks - assembled content blocks.
 * @returns the trimmed text, or `''` when the model produced none.
 */
function textOf(blocks) {
    return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
}

/**
 * Turn one terminal finish reason into a settled command result.
 *
 * @param finish - the assembled stream's finish reason.
 * @param blocks - the final round's content blocks (for the reasoning-only diagnosis).
 * @param answer - text accumulated across every round of the side answer.
 * @param signal - the dispatching UI request's signal.
 * @param callSignal - the deadline-fused signal handed to the model call.
 * @returns the command result to settle with.
 */
function settleFinish(finish, blocks, answer, signal, callSignal) {
    switch (finish.kind) {
        case 'stop':
            return answer.length === 0
                ? { kind: 'error', text: '模型没有返回任何内容。' }
                : { kind: 'success', text: answer };
        case 'max-tokens':
            if (answer.length > 0) return { kind: 'success', text: `${answer}\n\n（回答达到长度上限，已截断）` };
            return {
                kind: 'error',
                text: blocks.some((block) => block.type === 'reasoning')
                    ? '本次回答的长度预算被思考过程耗尽，没有产出正文，请重试。'
                    : '回答达到长度上限且没有可用文本。',
            };
        case 'tool-calls':
            return { kind: 'error', text: '模型尝试调用工具；/ask 是无工具通道，请重试或改用普通消息提问。' };
        case 'error':
        case 'aborted': {
            if (signal.aborted) return { kind: 'error', text: '已取消。' };
            if (callSignal.aborted) return { kind: 'error', text: `${TIMEOUT_MS / 1000} 秒内未返回，已放弃。` };
            const prefix = finish.kind === 'aborted' ? '调用被中断' : '模型调用失败';
            return { kind: 'error', text: `${prefix}：${finish.failure.message}` };
        }
        /* c8 ignore next 2 -- FinishReason is closed and every member is handled above */
        default:
            return { kind: 'error', text: `未知的结束原因：${String(finish.kind)}` };
    }
}

/**
 * Whether one tool name may run inside a side answer.
 *
 * @param name - the model's requested tool name.
 * @returns true only for {@link READ_ONLY_TOOLS}.
 */
function isReadOnlyTool(name) {
    return READ_ONLY_TOOLS.includes(name);
}

/** Whether one message is a plain human turn rather than a tool-result carrier. */
function isPlainUserTurn(message) {
    return message.role === 'user' && !(message.content ?? []).some((block) => block.type === 'tool-result');
}


/**
 * The single user message carrying the framing and the question.
 *
 * @param question - the human's question, already trimmed.
 * @returns the frozen user message appended to the side history.
 */
function questionMessage(question) {
    return createUserMessage({
        content: [{ type: 'text', text: `${FRAMING}\n\nSide question:\n${question}` }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
    });
}

/**
 * Run one model-requested tool call and turn its outcome into a tool-result
 * message, so the loop always has something to feed back — including when the
 * tool is not allowed here, the arguments are malformed, or the tool throws.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param agent - the addressed agent (tool scope and policy subject).
 * @param call - the model's tool-call block.
 * @param signal - deadline-fused cancellation for this call.
 * @returns the tool-result message to append to the side history.
 */
async function runToolCall(ctx, agent, call, signal) {
    const callId = ToolCallId(call.id);
    let args;
    try {
        args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createToolResultMessage({
            callId,
            isError: true,
            content: [{ type: 'text', text: `${call.name} 的参数不是合法 JSON：${reason}` }],
        });
    }
    const refusal = policyRefusal(call.name, args, agent);
    if (refusal !== undefined) {
        return createToolResultMessage({
            callId,
            isError: true,
            content: [{ type: 'text', text: refusal }],
        });
    }
    try {
        const result = await ctx.tools.execute({ callId, name: call.name, arguments: args, agent, signal });
        if (result.isError !== true && CREATE_ONLY_TOOLS.includes(call.name)) {
            const created = writeTarget(args);
            if (created !== undefined) markCreated(agent, resolveTarget(created, agent));
        }
        return createToolResultMessage({ callId, isError: result.isError, content: result.content });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createToolResultMessage({
            callId,
            isError: true,
            content: [{ type: 'text', text: `${call.name} 执行失败：${reason}` }],
        });
    }
}

/** The `file_path` one write call names, when it names one. */
function writeTarget(args) {
    return args !== null && typeof args === 'object' && typeof args.file_path === 'string'
        ? args.file_path
        : undefined;
}

/**
 * Canonical key for one write target, resolved the way the tools resolve it.
 *
 * @param target - the model-supplied `file_path`.
 * @param agent - the addressed agent, whose session carries the working directory.
 * @returns an absolute, normalized path.
 */
function resolveTarget(target, agent) {
    const cwd = agent?.session?.meta?.cwd ?? agent?.session?.cwd ?? process.cwd();
    return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

/** Whether this side chat is the one that created that path. */
function wasCreatedBySideChat(agent, key) {
    const owned = createdBySideChat.get(String(agent.session.id));
    return owned !== undefined && owned.has(key);
}

/** Record one successful create, so later turns may keep editing it. */
function markCreated(agent, key) {
    const sessionId = String(agent.session.id);
    const owned = createdBySideChat.get(sessionId) ?? new Set();
    owned.add(key);
    createdBySideChat.set(sessionId, owned);
}

/**
 * Whether something is already at that path.
 *
 * @param key - a {@link resolveTarget} key.
 * @returns whether the path exists; unsure answers `true`.
 */
function targetExists(key) {
    try {
        return existsSync(key);
    } catch {
        // Unsure means refuse: a refused create can be retried, an overwrite cannot.
        return true;
    }
}

/**
 * The side channel's tool policy, applied before dispatch.
 *
 * @param name - the model's requested tool name.
 * @param args - its parsed arguments.
 * @param agent - the addressed agent.
 * @returns a refusal message, or undefined when the call may run.
 */
function policyRefusal(name, args, agent) {
    if (isReadOnlyTool(name)) return undefined;
    if (CREATE_ONLY_TOOLS.includes(name)) {
        const target = writeTarget(args);
        if (target === undefined || target.trim().length === 0) return `${name} 需要一个 file_path 参数。`;
        const key = resolveTarget(target, agent);
        // A file this side chat created stays editable for the rest of the thread;
        // anything that was on disk before we touched it remains off limits.
        if (wasCreatedBySideChat(agent, key)) return undefined;
        if (targetExists(key)) {
            return `侧边问答只能新建文件，不能修改已有文件：${target} 已经存在。`
                + '请换一个路径，或直接在回答里给出内容。';
        }
        return undefined;
    }
    return `${name} 在侧边问答中不可用：只能调用 ${[...READ_ONLY_TOOLS, ...CREATE_ONLY_TOOLS].join('、')}`
        + `（其中 ${CREATE_ONLY_TOOLS.join('、')} 仅限新建文件）。请改用这些工具，或直接说明你无法查证。`;
}

/**
 * Publish live side-answer frames to the browser.
 *
 * Text is coalesced rather than sent per delta: one frame per model chunk would
 * put hundreds of websocket messages behind a single answer.
 *
 * @param ctx - host context whose `emit` reaches the forwarded-event source.
 * @param sessionId - owning session, so a client can ignore foreign frames.
 * @returns the frame emitters, each of which flushes pending text first.
 */
function createStream(ctx, sessionId) {
    let buffer = '';
    let bufferKind = null;
    let timer = null;
    let reported = false;
    const send = (frame) => {
        const payload = { sessionId, ...frame };
        // Emit on the root context: the Remote assembly's forwarding listener is
        // registered by another plugin, and root reaches every listener.
        const bus = ctx.root ?? ctx;
        try {
            bus.emit(STREAM_EVENT, payload);
            if (!reported) {
                reported = true;
                trace(`emit-ok ${frame.kind}`);
            }
        } catch (error) {
            trace(`emit-failed ${frame.kind}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const flush = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        if (buffer.length === 0) return;
        const text = buffer;
        const kind = bufferKind;
        buffer = '';
        bufferKind = null;
        send({ kind, text });
    };
    /**
     * Queue text under one frame kind, flushing first when the kind changes so the
     * browser never sees reasoning and answer text out of order.
     * @param kind - `delta` for answer text, `reasoning` for the model's thinking.
     * @param text - the chunk.
     */
    const queue = (kind, text) => {
        if (bufferKind !== null && bufferKind !== kind) flush();
        bufferKind = kind;
        buffer += text;
        if (buffer.length >= DELTA_FLUSH_CHARS) flush();
        else if (timer === null) {
            timer = setTimeout(flush, DELTA_FLUSH_MS);
            if (typeof timer.unref === 'function') timer.unref();
        }
    };
    return {
        start(question, fresh) {
            send({ kind: 'start', question, fresh });
        },
        push(text) {
            queue('delta', text);
        },
        /**
         * Publish thinking progress. Without it a high-effort reasoning model looks
         * frozen for the whole reasoning phase, because only answer text streams.
         * @param text - the reasoning chunk.
         */
        pushReasoning(text) {
            queue('reasoning', text);
        },
        tool(names) {
            flush();
            send({ kind: 'tool', names });
        },
        end(result) {
            flush();
            send({ kind: 'end', ok: result.kind === 'success', text: result.text ?? '' });
        },
    };
}

/**
 * Answer one side question without admitting anything to the agent's history.
 *
 * Runs a bounded tool loop: the model may ask for read-only tools, each result
 * is appended to the side history only, and the loop ends when the model stops
 * or {@link MAX_TOOL_STEPS} rounds are spent.
 *
 * @param ctx - plugin context carrying the command, LLM, prompt, and tool services.
 * @param invocation - the dispatching UI's invocation (agent, raw text, signal).
 * @returns the settled command result.
 */
export async function execute(ctx, invocation) {
    const raw = invocation.rawInput.trim();
    const { agent } = invocation;
    const sessionId = String(agent.session.id);

    // `/ask --reset` drops the side thread without asking anything: the panel's
    // reset control re-anchors the next question to a context with no side
    // history attached.
    if (raw === RESET_FLAG) {
        // Nothing server-side holds a side context any more: each question is answered
        // against the current main conversation. Only the file-creation claims reset,
        // so those paths count as pre-existing and are read-only again.
        createdBySideChat.delete(sessionId);
        return { kind: 'success', text: '已重置：下一问按当前主线上下文重新开始。' };
    }

    const startsNewThread = raw === NEW_THREAD_PREFIX || raw.startsWith(`${NEW_THREAD_PREFIX} `);
    const question = startsNewThread ? raw.slice(NEW_THREAD_PREFIX.length).trim() : raw;
    if (question.length === 0) return { kind: 'error', text: USAGE };

    const route = resolveRoute(ctx, agent);
    if (route === undefined) {
        return { kind: 'error', text: '无法确定模型路由：本会话还没有发出过模型请求，请先正常发送一条消息。' };
    }

    const stream = createStream(ctx, sessionId);
    const callDeadline = deadline(invocation.signal, TIMEOUT_MS, TIMEOUT_CODE);
    /** The side history once built; kept so a successful answer continues the thread. */
    let messages = null;
    const settle = (result) => {
        stream.end(result);
        return result;
    };

    try {
        const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, signal: invocation.signal });
        const tools = assembly.tools ?? [];
        const system = renderPrompt(assembly);
        // The seed is re-derived for EVERY question: the point of a standing side
        // panel is that each question is answered against the context as it is
        // now, not against a snapshot frozen when the panel opened. Only the side
        // turns carry over, which is what keeps a follow-up coherent.
        const derived = agent.session.deriveMessages();
        const seed = sanitizeHistory(derived);
        if (startsNewThread) createdBySideChat.delete(sessionId);
        // The panel's own history is DISPLAY state: it never enters the request.
        // Merging it used to let an old side thread outrank the fresh conversation,
        // and after trimming it could smuggle a tool result whose call was gone — the
        // provider then rejected the whole request. Each question is now answered from
        // the current main conversation alone.
        messages = [...seed, questionMessage(question)];
        traceSeed(sessionId, derived, seed);
        stream.start(question, true);

        // Accumulated across rounds: the browser already rendered every round's
        // text, so the settled result must not drop the earlier ones.
        let answer = '';

        for (let step = 0; ; step += 1) {
            const assembler = new BlockAssembler();
            for await (const chunk of ctx.llm.stream({
                ...route,
                messages,
                system,
                ...tools.length === 0 ? {} : { tools },
                sessionId: agent.session.id,
                signal: callDeadline.signal,
            })) {
                assembler.push(chunk);
                if (chunk.type === 'text-delta') stream.push(chunk.text);
                else if (chunk.type === 'reasoning-delta') stream.pushReasoning(chunk.text);
                callDeadline.signal.throwIfAborted();
            }
            callDeadline.signal.throwIfAborted();

            const blocks = assembler.blocks();
            answer += textOf(blocks);
            const calls = blocks.filter((block) => block.type === 'tool-call');
            if (assembler.finish.kind !== 'tool-calls' || calls.length === 0) {
                // Keep the answer in the thread too, or a follow-up would remember
                // only its own questions and lose every reply.
                if (blocks.length > 0) {
                    messages.push(createAssistantMessage({
                        content: blocks,
                        source: { provider: route.provider, model: route.model },
                    }));
                }
                return settle(settleFinish(assembler.finish, blocks, answer, invocation.signal, callDeadline.signal));
            }
            if (step >= MAX_TOOL_STEPS) {
                // Never discard what is already written: the accumulated answer is the
                // user's, and the stop is a footnote on it rather than a replacement.
                if (answer.length > 0) {
                    return settle({
                        kind: 'success',
                        text: `${answer}\n\n（已达工具调用轮数上限 ${MAX_TOOL_STEPS} 轮，停止继续查证）`,
                    });
                }
                return settle({ kind: 'error', text: `工具调用超过 ${MAX_TOOL_STEPS} 轮，已停止。` });
            }
            stream.tool(calls.map((call) => call.name));
            messages.push(createAssistantMessage({
                content: blocks,
                source: { provider: route.provider, model: route.model },
            }));
            for (const call of calls) {
                messages.push(await runToolCall(ctx, agent, call, callDeadline.signal));
            }
        }
    } catch (error) {
        if (invocation.signal.aborted) return settle({ kind: 'error', text: '已取消。' });
        if (callDeadline.signal.aborted) return settle({ kind: 'error', text: `${TIMEOUT_MS / 1000} 秒内未返回，已放弃。` });
        const reason = error instanceof Error ? error.message : String(error);
        return settle({ kind: 'error', text: `/ask 失败：${reason}` });
    } finally {
        callDeadline[Symbol.dispose]();
    }
}

/**
 * Register `/ask` for every composed human-command adapter.
 *
 * @param ctx - context carrying the command registry and its peer services.
 */
