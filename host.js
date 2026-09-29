/**
 * `/ask` host shell: a stable plugin face over a content-stamped implementation.
 *
 * Why this indirection exists. The host applies a profile's patch layer once and
 * does **not** re-import a row's module afterwards — not even when the row's
 * specifier changes to a brand-new file, which is what a content-addressed entry
 * name was for. Every host-side edit therefore needed a full `dsh web` restart,
 * which is untenable while the feature is still moving.
 *
 * So this file stays put and stays small: it owns the plugin face the Loader
 * sees, registers the command, and forwards each invocation to
 * `./implementation.js`, re-imported whenever that file's stamp changes. A
 * modified implementation is a new URL (the stamp rides the query), so Node's
 * per-URL ES-module cache cannot serve a stale build, and **no restart and no
 * patch reload are involved**.
 *
 * Deployment still content-addresses this shell's filename. That is harmless and
 * still earns its keep if the shell itself changes.
 *
 * @module dsh-ask-panel
 */
import { appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes';
import z from '@deepseek-ai/schemastery';
import { patchLayout } from './patch-layout.js';

/** Plugin name, as addressed by the profile patch row. */
export const name = 'ask-panel';

/** Services required before this command can register. */
export const inject = ['commands', 'llm', 'systemPrompt', 'tools'];

/** Host event carrying live side-answer and task frames to the browser. */
const STREAM_EVENT = 'ask/stream';

/** The forwarding allowlist is read per client connection, so this stays in the shell. */
const ALLOWLIST_EVENT = { event: STREAM_EVENT, mode: 'emit' };

/** Where the shell reports activation, for the same reason the implementation reports emits. */
const LOAD_LOG = fileURLToPath(new URL('./ask-panel-load.log', import.meta.url));

/**
 * Loader-facing configuration.
 *
 * `layoutWidth` is OFF by default and deliberately so: it edits another
 * installed package's client bundle (see patch-layout.js for why a plugin has no
 * other way to persist the right column's width). A published plugin must not do
 * that unless the person installing it asks for it.
 */
export const Config = z.object({
    layoutWidth: z.boolean().default(false),
});

/** The implementation this shell forwards to. */
const IMPLEMENTATION = new URL('./implementation.js', import.meta.url);

/** Last loaded implementation, keyed by its stamp so an edit reloads it. */
let loaded = null;

/**
 * Append one diagnostic line. Best-effort: diagnostics must never break what
 * they describe.
 *
 * @param line - what happened.
 */
function trace(line) {
    try {
        appendFileSync(LOAD_LOG, `${new Date().toISOString()} pid=${process.pid} shell ${line}\n`);
    } catch {
        /* A diagnostic that cannot be written is not a reason to fail. */
    }
}

/**
 * Load the implementation, re-importing it when its file changed.
 *
 * The stamp is the file's mtime plus size, carried as a query parameter: content
 * that changed gets a fresh URL, content that did not keeps its cache hit.
 *
 * @returns the implementation module.
 */
async function loadImplementation() {
    const info = await stat(IMPLEMENTATION);
    const stamp = `${Math.round(info.mtimeMs)}-${info.size}`;
    if (loaded !== null && loaded.stamp === stamp) return loaded.module;
    const url = new URL(IMPLEMENTATION);
    url.searchParams.set('v', stamp);
    const module = await import(url.href);
    loaded = { stamp, module };
    trace(`implementation loaded v=${stamp}`);
    return module;
}

/**
 * Forward one invocation to the current implementation.
 *
 * @param ctx - plugin context.
 * @param invocation - the dispatching UI's invocation.
 * @returns the settled command result.
 */
async function dispatch(ctx, invocation) {
    const implementation = await loadImplementation();
    return implementation.execute(ctx, invocation);
}

/**
 * Register `/ask` for every composed human-command adapter.
 *
 * @param ctx - context carrying the command registry and its peer services.
 */
export function apply(ctx, config) {
    // Opt-in, and re-checked on every boot: a `dsh` upgrade replaces the
    // installation, so a patch applied once at install time is silently reverted.
    if (config !== null && typeof config === 'object' && config.layoutWidth === true) {
        try {
            trace(`layout patch: ${patchLayout().join(' | ')}`);
        } catch (error) {
            trace(`layout patch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
        trace('layout patch: off (set config.layoutWidth: true to opt in)');
    }

    // Live frames need the Remote assembly to forward this event. It forwards a
    // fixed allowlist which it reads when a client opens the event stream — long
    // after plugins apply — so appending our entry here is enough, and no core
    // file is touched. The guard keeps an HMR re-apply from double-registering.
    if (!API_REMOTE_FORWARDED_EVENTS.some((entry) => entry.event === STREAM_EVENT)) {
        API_REMOTE_FORWARDED_EVENTS.push(ALLOWLIST_EVENT);
        trace('allowlist-pushed');
    } else {
        trace('allowlist-already-present');
    }

    // The right column's task panel follows the main conversation by observing the
    // agent's own plan writes: nothing polls, and nothing has to reconstruct the
    // plan from the transcript. `tools/result` contains listener failures, so a
    // bad payload can never break the tool it observes.
    let observedOnce = false;
    ctx.effect(() => ctx.on('tools/result', (exec, result) => {
        try {
            if (exec === undefined || exec.name !== 'todo_write') return;
            if (result === undefined || result.isError === true) return;
            const todos = exec.arguments === undefined ? undefined : exec.arguments.todos;
            if (!Array.isArray(todos)) return;
            if (!observedOnce) {
                observedOnce = true;
                trace(`todo observed, ${todos.length} item(s)`);
            }
            const agent = exec.agent;
            (ctx.root ?? ctx).emit(STREAM_EVENT, {
                sessionId: agent === undefined ? '' : String(agent.session.id),
                kind: 'tasks',
                todos
            });
        } catch {
            // Observation must never break the tool it observes.
        }
    }), 'ask-panel: todo observer');

    const active = new Set();
    const handler = (invocation) => {
        const operation = dispatch(ctx, invocation);
        active.add(operation);
        const retire = () => {
            active.delete(operation);
        };
        operation.then(retire, retire);
        return operation;
    };

    ctx.effect(function* () {
        yield async () => {
            await Promise.allSettled(active);
        };
        yield ctx.commands.register({
            name: 'ask',
            description: '（内部通道）右栏「问一句」面板用它把问题送回宿主；正常使用无需手输',
            input: { hint: '想顺便问的问题' },
            handler,
        });
    }, 'ask-panel lifecycle');

    trace(`apply done, forwarded=${API_REMOTE_FORWARDED_EVENTS.length}`);
}
