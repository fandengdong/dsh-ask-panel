/**
 * Stub harness for the *installed* browser half of `/ask`.
 *
 * The client bundle is a plain classic script that registers a lazy-CJS factory,
 * so it can be materialized in Node against a fake `window`, `document`, and
 * React. That covers everything except actual painting: the tab-type and body
 * registrations, which commands are captured, what the panel renders, follow-up
 * submission, and the markdown renderer.
 *
 * Run: node my_workspace/dsh-ask-panel/test-client.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_DIR = process.env.DSH_ASK_PANEL_DIR ?? join(
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'profiles',
    process.env.DSH_PROFILE ?? 'web',
    'plugins',
    'ask-panel',
);

if (!existsSync(PLUGIN_DIR)) {
    console.error(`no installed plugin at ${PLUGIN_DIR}`);
    console.error('install it first (bash install.sh, or dsh plugin add), or set DSH_ASK_PANEL_DIR.');
    process.exit(1);
}

const INSTALLED = join(PLUGIN_DIR, 'client.js');

/**
 * Fake React good enough for this component: hooks are answered synchronously,
 * state cells survive renders, and an effect write marks the render dirty so
 * the harness runs the second pass React would.
 */
function fakeReact() {
    const state = [];
    const api = {
        effects: [],
        dirty: false,
        createElement(type, props, children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) {
            const index = api.cursor++;
            if (!(index in state)) state[index] = initial;
            return [state[index], (next) => {
                state[index] = typeof next === 'function' ? next(state[index]) : next;
                api.dirty = true;
            }];
        },
        useSyncExternalStore(_subscribe, getSnapshot) {
            api.cursor += 1;
            return getSnapshot();
        },
        useEffect(fn) {
            api.cursor += 1;
            api.effects.push(fn());
        },
        useRef(value) {
            api.cursor += 1;
            return { current: value };
        },
        cursor: 0,
    };
    return api;
}

/** Fake document: nothing here needs layout any more, but the bundle may touch it. */
function fakeDocument() {
    return {
        handlers: [],
        body: {},
        querySelector: () => null,
        addEventListener(type, fn) {
            this.handlers.push([type, fn]);
        },
        removeEventListener() {},
    };
}

/** Shared across installs, so a "page reload" sees exactly what the last page stored. */
const fakeStorage = (() => {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
        clear: () => map.clear(),
    };
})();

/** Load one bundle registration out of a classic script. */
function loadBundle(source, doc) {
    let entry;
    const window = {
        __ModuleLoader__: { load: (value) => { entry = value; } },
        localStorage: fakeStorage,
        addEventListener() {},
        removeEventListener() {},
    };
    new Function('window', 'document', source)(window, doc);
    assert.ok(entry, 'bundle registered no module');
    return entry;
}

/** Every string reachable from a rendered element tree. */
function textOf(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    return textOf(node.children) || textOf(node.props?.children);
}

/** First element of a rendered tree with the given type. */
function findByType(node, type) {
    if (node === null || node === undefined || typeof node === 'string') return null;
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findByType(child, type);
            if (found !== null) return found;
        }
        return null;
    }
    if (node.type === type) return node;
    return findByType(node.children, type);
}

/** Text of every element of the given type in a rendered tree. */
function allOfType(node, type, found = []) {
    if (node === null || node === undefined || typeof node === 'string') return found;
    if (Array.isArray(node)) {
        for (const child of node) allOfType(child, type, found);
        return found;
    }
    if (node.type === type) found.push(node);
    allOfType(node.children, type, found);
    return found;
}

/** Install the plugin onto a fake client context, returning the captured registrations. */
function install(source, options = {}) {
    // Each install models one page load; storage is browser-wide, so it is cleared
    // unless a test is deliberately reloading the same browser.
    if (options.keepStorage !== true) fakeStorage.clear();
    const react = fakeReact();
    const entry = loadBundle(source, fakeDocument());
    const face = entry.factory((id) => {
        if (id === 'react') return react;
        throw new Error(`unexpected require("${id}")`);
    });

    const captured = {
        locales: [],
        events: [],
        slots: [],
        effects: [],
        slotNames: [],
        streams: [],
        submitted: [],
        tabTypes: [],
        opened: [],
    };
    const listeners = new Map();
    const commandResult = { kind: 'success', text: '续答' };
    const sessionState = { current: 's1' };
    const sessionListeners = [];

    face.apply({
        effect(fn, label) {
            captured.effects.push(label);
            // Both cordis forms appear here: a generator yielding disposers, and a
            // plain function whose return value is the disposer.
            const outcome = fn();
            if (typeof outcome === 'function') {
                cleanups.push(outcome);
                return;
            }
            if (outcome === null || typeof outcome !== 'object' || typeof outcome.next !== 'function') return;
            for (let step = outcome.next(); !step.done; step = outcome.next()) {
                if (typeof step.value === 'function') cleanups.push(step.value);
            }
        },
        logger: { warn() {} },
        locale: {
            register: (ns, dictionaries) => captured.locales.push({ ns, dictionaries }),
            bind: () => (key) => captured.locales[0]?.dictionaries.zh[key] ?? key,
        },
        on(name, listener) {
            listeners.set(name, listener);
            captured.events.push(name);
            return () => listeners.delete(name);
        },
        remote: {
            $on(name, listener) {
                captured.streams.push(name);
                listeners.set(name, listener);
                return () => listeners.delete(name);
            },
            commands: {
                async execute(sessionId, line, attachments) {
                    captured.submitted.push({ sessionId, line, attachments });
                    return { ok: true, value: { commandId: 'cmd-x', result: commandResult } };
                },
            },
        },
        sessions: {
            list: {
                getSnapshot: () => ({ current: sessionState.current }),
                subscribe: (listener) => {
                    sessionListeners.push(listener);
                    return () => {};
                },
            },
        },
        sidebarRightTabs: {
            register(definition) {
                captured.tabTypes.push(definition);
                return () => {};
            },
        },
        sidebarRight: {
            openTab(kind) {
                captured.opened.push(kind);
            },
        },
        slots: {
            inject(name, fn) {
                captured.slotNames.push(name);
                fn();
            },
            register(spec, component) {
                captured.slots.push({ spec, component });
                return () => {};
            },
        },
    });

    const registered = captured.slots[0];
    const t = (key) => captured.locales[0].dictionaries.zh[key];
    return {
        entry,
        face,
        react,
        captured,
        listeners,
        registered,
        tabType: captured.tabTypes[0],
        t,
        setSession(id) {
            sessionState.current = id;
        },
        fireSessionChange() {
            for (const listener of [...sessionListeners]) listener();
        },
    };
}

/** Render once, retiring the previous pass's effects and re-passing after a state write. */
function render(component, react, t) {
    const pass = () => {
        for (const cleanup of react.effects) if (typeof cleanup === 'function') cleanup();
        react.effects = [];
        react.cursor = 0;
        return component({ t });
    };
    const tree = pass();
    if (!react.dirty) return tree;
    react.dirty = false;
    return pass();
}

/** Effect cleanups every install yielded, run once at the end. */
const cleanups = [];

const source = readFileSync(INSTALLED, 'utf8');
const probe = install(source);

/* 1. the bundle registers under the package id */
assert.equal(probe.entry.id, 'dsh-ask-panel');

/* 2. the exported client face. `remote.commands` is its own inject entry: cordis
      gates service property access, so omitting it throws at follow-up time. */
assert.equal(typeof probe.face.apply, 'function');
assert.deepEqual(
    probe.face.inject,
    ['slots', 'locale', 'remote', 'remote.commands', 'uiSession', 'sessions', 'sidebarRightTabs', 'sidebarRight'],
);

/* 3. apply() registers copy, the live stream, the result capture, the tab type, and the body */
assert.equal(probe.captured.locales[0].ns, 'ask');
assert.deepEqual(
    Object.keys(probe.captured.locales[0].dictionaries.zh).sort(),
    Object.keys(probe.captured.locales[0].dictionaries.en).sort(),
);
assert.equal(probe.captured.events[0], 'command/executed');
assert.deepEqual(probe.captured.streams, ['ask/stream']);
// two bodies: the side chat and the task panel
assert.deepEqual(probe.captured.slotNames, ['sidebar.right.pane.tab']);
assert.equal(probe.captured.slots.length, 1);
assert.equal(probe.captured.slots[0].spec.name, 'sidebar.right.pane.tab');
assert.equal(probe.captured.slots[0].spec.key, 'dsh-ask-panel');
assert.equal(probe.captured.slots[0].spec.locale, 'ask');

/* 4. the tab type is a page type with a title and a guide entry */
assert.equal(probe.tabType.id, 'dsh-ask-panel');
assert.equal(probe.tabType.kind, 'ask');
assert.equal(probe.tabType.patterns, undefined, 'a page type must not claim addresses');
assert.equal(probe.tabType.title(), '问一句');
assert.equal(probe.tabType.guide[0].title(), '问一句');
assert.equal(typeof probe.tabType.guide[0].order, 'number');
console.log('ok 1-4 tab type and body registration');

/* 5. the empty panel says so instead of rendering nothing */
{
    const tree = render(probe.registered.component, probe.react, probe.t);
    assert.equal(textOf(tree).includes('还没有问题'), true);
}
console.log('ok 5 empty state');

/* 6. other commands are ignored, and nothing opens the column */
{
    const it = install(source);
    it.listeners.get('command/executed')('s1', 'compact', { kind: 'success', text: 'compacted' });
    const tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('compacted'), false);
}
console.log('ok 6 other commands ignored');

/* 7. a settled btw result renders AND reveals the column */
{
    const it = install(source);
    it.listeners.get('command/executed')('s1', 'ask', { kind: 'success', text: '正在跑 UT。' });
    const tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('正在跑 UT。'), true);
    assert.ok(it.captured.opened.includes('ask'), 'the column was never revealed');
}
console.log('ok 7 settled result renders and reveals the column');

/* 8. a failure is labelled */
{
    const it = install(source);
    it.listeners.get('command/executed')('s1', 'ask', { kind: 'error', text: '模型调用失败：boom' });
    const tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('boom'), true);
}
console.log('ok 8 failure rendered');

/* 9. live frames type the answer out and reveal the column too */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: '在干什么？', fresh: true });
    let tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('正在查证'), true);
    assert.equal(textOf(tree).includes('\u258d'), true, 'no streaming caret');
    assert.equal(textOf(tree).includes('在干什么？'), true, 'question not shown');
    // the question renders as a labelled bubble rather than a bare `>` line
    assert.equal(textOf(tree).includes('你'), true, 'question bubble label missing');

    stream({ kind: 'delta', sessionId: 's1', text: '正在' });
    stream({ kind: 'delta', sessionId: 's1', text: '跑 UT。' });
    tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('正在跑 UT。'), true);

    stream({ kind: 'tool', sessionId: 's1', names: ['read', 'grep'] });
    tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('正在调用 read、grep'), true);

    stream({ kind: 'end', sessionId: 's1', ok: true, text: '正在跑 UT。' });
    tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('\u258d'), false, 'caret outlived the answer');
    assert.ok(it.captured.opened.includes('ask'), 'the column was never revealed');
}
console.log('ok 9 live frames drive the panel');

/* 10. frames for another session are ignored */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: 'q', fresh: true });
    stream({ kind: 'delta', sessionId: 'other', text: 'foreign' });
    const tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('foreign'), false);
}
console.log('ok 10 foreign session frames ignored');

/* 11. a follow-up frame appends a turn; a fresh frame replaces the thread */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: '第一个问题', fresh: true });
    stream({ kind: 'end', sessionId: 's1', ok: true, text: '答复一' });
    stream({ kind: 'start', sessionId: 's1', question: '第二个问题', fresh: false });
    stream({ kind: 'end', sessionId: 's1', ok: true, text: '答复二' });
    let tree = render(it.registered.component, it.react, it.t);
    let text = textOf(tree);
    assert.equal(text.includes('第一个问题'), true, 'earlier turn was dropped');
    assert.equal(text.includes('答复一'), true);
    assert.equal(text.includes('第二个问题'), true);

    stream({ kind: 'start', sessionId: 's1', question: '全新问题', fresh: true });
    tree = render(it.registered.component, it.react, it.t);
    // `fresh` marks a dropped HOST thread; the panel is a log and keeps its turns
    assert.equal(textOf(tree).includes('第一个问题'), true, 'a fresh thread wiped the log');
    assert.equal(textOf(tree).includes('全新问题'), true);
}
console.log('ok 11 the log appends across follow-ups and fresh threads');

/* 12. the panel input submits a follow-up through the command seam */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: '第一个问题', fresh: true });
    stream({ kind: 'end', sessionId: 's1', ok: true, text: '答复一' });
    let tree = render(it.registered.component, it.react, it.t);

    const input = findByType(tree, 'input');
    assert.ok(input, 'no follow-up input rendered');
    assert.equal(input.props.disabled, false);
    input.props.onChange({ target: { value: '再详细点' } });
    tree = render(it.registered.component, it.react, it.t);
    findByType(tree, 'input').props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    tree = render(it.registered.component, it.react, it.t);

    assert.equal(it.captured.submitted.length, 1);
    assert.equal(it.captured.submitted[0].sessionId, 's1');
    assert.equal(it.captured.submitted[0].line, '/ask 再详细点');
    assert.equal(textOf(tree).includes('续答'), true, 'settled follow-up result not shown');
}
console.log('ok 12 follow-up submitted through the command seam');

/* 13. the input is disabled while an answer is still being written */
{
    const it = install(source);
    it.listeners.get('ask/stream')({ kind: 'start', sessionId: 's1', question: 'q', fresh: true });
    const tree = render(it.registered.component, it.react, it.t);
    const input = findByType(tree, 'input');
    assert.equal(input.props.disabled, true);
    assert.equal(String(input.props.placeholder).includes('等这次回答结束'), true);
}
console.log('ok 13 input disabled while busy');

/* 14. answers render as markdown, not pre-wrapped text */
{
    const it = install(source);
    const md = [
        '# 结论',
        '',
        '这是 **重点** 和 `代码`。',
        '',
        '| 口径 | A 臂 | 基线 |',
        '|---|---|---|',
        '| 最小步时 | 38.7 s | 20.6 s |',
        '',
        '- 第一项',
        '- 第二项',
        '',
        '```bash',
        'pytest -vs tests/ut',
        '```',
    ].join('\n');
    it.listeners.get('ask/stream')({ kind: 'start', sessionId: 's1', question: 'q', fresh: true });
    it.listeners.get('ask/stream')({ kind: 'end', sessionId: 's1', ok: true, text: md });
    const tree = render(it.registered.component, it.react, it.t);

    const table = findByType(tree, 'table');
    assert.ok(table, 'no table element rendered');
    assert.equal(allOfType(table, 'th').length, 3);
    assert.equal(allOfType(table, 'td').length, 3);
    assert.equal(textOf(table).includes('38.7 s'), true);
    assert.equal(allOfType(tree, 'h4').length >= 1, true, 'heading not rendered');
    assert.equal(allOfType(tree, 'strong').length, 1);
    assert.equal(allOfType(tree, 'pre').length, 1, 'code fence not rendered');
    assert.equal(allOfType(tree, 'code').length >= 2, true, 'inline code not rendered');
    assert.equal(allOfType(tree, 'ul').length, 1);
    assert.equal(allOfType(tree, 'li').length, 2);
}
console.log('ok 14 markdown rendering');

/* 15. opening the column is contained when no seat is mounted */
{
    const react = fakeReact();
    const entry = loadBundle(source, fakeDocument());
    const face = entry.factory((id) => {
        if (id === 'react') return react;
        throw new Error(`unexpected require("${id}")`);
    });
    const captured = { opened: 0, locales: [], tabTypes: [] };
    face.apply({
        effect(fn) {
            // Retain the cleanup: this plugin's long-lived effects own timers.
            const outcome = fn();
            if (typeof outcome === 'function') cleanups.push(outcome);
        },
        logger: { warn() {} },
        locale: {
            register: (ns, dictionaries) => captured.locales.push({ ns, dictionaries }),
            bind: () => (key) => key,
        },
        on: () => () => {},
        remote: { $on: () => () => {} },
        sessions: { list: { getSnapshot: () => ({ current: 's1' }), subscribe: () => () => {} } },
        sidebarRightTabs: { register: (definition) => { captured.tabTypes.push(definition); return () => {}; } },
        sidebarRight: {
            openTab() {
                captured.opened += 1;
                throw new Error('no seat mounted');
            },
        },
        slots: { inject: (name, fn) => fn(), register: () => () => {} },
    });
    // The throwing openTab must not escape the result path.
    assert.doesNotThrow(() => captured.tabTypes[0].title());
}
console.log('ok 15 open failures are contained');

/* 16. the standing panel answers without any prior /ask */
{
    const it = install(source);
    let tree = render(it.registered.component, it.react, it.t);
    // the empty panel still offers a working input
    const input = findByType(tree, 'input');
    assert.ok(input, 'empty panel has no input');
    assert.equal(input.props.disabled, false);

    input.props.onChange({ target: { value: '现在在干什么？' } });
    tree = render(it.registered.component, it.react, it.t);
    findByType(tree, 'input').props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    tree = render(it.registered.component, it.react, it.t);
    // the question shows immediately, before any frame arrives
    assert.equal(textOf(tree).includes('现在在干什么？'), true, 'question not shown optimistically');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(it.captured.submitted.length, 1);
    assert.equal(it.captured.submitted[0].line, '/ask 现在在干什么？');
    assert.equal(it.captured.submitted[0].sessionId, 's1');
}
console.log('ok 16 standing panel asks with no prior /ask');

/* 17. the host's start frame reconciles the optimistic turn instead of duplicating it */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    let tree = render(it.registered.component, it.react, it.t);
    findByType(tree, 'input').props.onChange({ target: { value: '你好' } });
    tree = render(it.registered.component, it.react, it.t);
    findByType(tree, 'input').props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    tree = render(it.registered.component, it.react, it.t);
    stream({ kind: 'start', sessionId: 's1', question: '你好', fresh: true });
    tree = render(it.registered.component, it.react, it.t);
    const occurrences = textOf(tree).split('你好').length - 1;
    assert.equal(occurrences, 1, `question rendered ${occurrences} times`);
    stream({ kind: 'delta', sessionId: 's1', text: '在。' });
    tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('在。'), true);
}
console.log('ok 17 start reconciles the optimistic turn');

/* 18. reset drops the thread through the command seam and clears the panel */
{
    const it = install(source);
    it.listeners.get('ask/stream')({ kind: 'start', sessionId: 's1', question: 'q', fresh: true });
    it.listeners.get('ask/stream')({ kind: 'end', sessionId: 's1', ok: true, text: '答复' });
    let tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('答复'), true);

    const resetButton = allOfType(tree, 'button').find((node) => String(node.props.title).includes('重置上下文'));
    assert.ok(resetButton, 'no reset control rendered');
    resetButton.props.onClick();
    tree = render(it.registered.component, it.react, it.t);
    // a reset drops the host's context, never the user's record
    assert.equal(textOf(tree).includes('答复'), true, 'reset wiped the log');
    const afterReset = textOf(tree);
    assert.equal(afterReset.includes('上下文已重置'), true, 'reset left no boundary marker');
    // the boundary is a dated row of its own, not a note pinned to the panel
    assert.equal(afterReset.includes('\u27f2'), true, 'the boundary has no marker glyph');
    assert.equal(/\d{1,2}:\d{2}/.test(afterReset), true, 'the boundary carries no time');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(it.captured.submitted.at(-1).line, '/ask --reset');
}
console.log('ok 18 reset drops the thread');

/* 19. another session's thread is never shown in this session's seat */
{
    const it = install(source);
    it.listeners.get('ask/stream')({ kind: 'start', sessionId: 'other', question: '别处的谈话', fresh: true });
    it.listeners.get('ask/stream')({ kind: 'end', sessionId: 'other', ok: true, text: '别的答复' });
    const tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('别的答复'), false);
    assert.equal(textOf(tree).includes('还没有问题'), true);
}
console.log('ok 19 session isolation');

/* 20. thinking streams in while the answer is still being reasoned about */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: 'q', fresh: true });
    stream({ kind: 'reasoning', sessionId: 's1', text: '先看看 ' });
    stream({ kind: 'reasoning', sessionId: 's1', text: 'host.js。' });
    let tree = render(it.registered.component, it.react, it.t);
    let text = textOf(tree);
    assert.equal(text.includes('先看看 host.js。'), true, 'thinking is hidden during the wait');
    assert.equal(text.includes('思考中'), true, 'no thinking label');
    stream({ kind: 'delta', sessionId: 's1', text: '答案是 42。' });
    tree = render(it.registered.component, it.react, it.t);
    assert.equal(textOf(tree).includes('答案是 42。'), true);
    stream({ kind: 'end', sessionId: 's1', ok: true, text: '答案是 42。' });
    tree = render(it.registered.component, it.react, it.t);
    text = textOf(tree);
    assert.equal(text.includes('先看看 host.js。'), false, 'thinking outlived the answer');
    assert.equal(text.includes('答案是 42。'), true);
}
console.log('ok 20 thinking streams while the answer is pending');

/* 21. exactly one panel type is contributed: the side chat */
{
    const it = install(source);
    assert.deepEqual(it.captured.tabTypes.map((definition) => definition.kind), ['ask']);
    assert.deepEqual(it.captured.opened, ['ask']);
}
console.log('ok 21 only the side-chat panel is contributed');

/* 23. the panel stands up again in every session, not once per page load */
{
    const it = install(source);
    assert.deepEqual(it.captured.opened, ['ask']);
    it.setSession('s2');
    it.fireSessionChange();
    assert.deepEqual(it.captured.opened, ['ask', 'ask'], 'a session switch did not re-open the panel');
    // already-standing sessions are left alone
    it.setSession('s1');
    it.fireSessionChange();
    assert.deepEqual(it.captured.opened, ['ask', 'ask']);
}
console.log('ok 23 the panel stands up in every session');

/* 24. a page reload restores the visible log instead of emptying the panel */
{
    fakeStorage.clear();
    const first = install(source);
    const stream = first.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: '刷新前的问题', fresh: true });
    stream({ kind: 'end', sessionId: 's1', ok: true, text: '刷新前的答案' });
    render(first.registered.component, first.react, first.t);

    // a new page: fresh module memory, the same browser storage
    const second = install(source, { keepStorage: true });
    const text = textOf(render(second.registered.component, second.react, second.t));
    assert.equal(text.includes('刷新前的问题'), true, 'the question was lost on reload');
    assert.equal(text.includes('刷新前的答案'), true, 'the answer was lost on reload');
}
console.log('ok 24 a reload restores the log');

/* 22. a retry after a failed answer sits below it instead of replacing it */
{
    const it = install(source);
    const stream = it.listeners.get('ask/stream');
    stream({ kind: 'start', sessionId: 's1', question: '第一次', fresh: true });
    stream({ kind: 'end', sessionId: 's1', ok: false, text: '' });
    it.listeners.get('command/executed')('s1', 'ask', { kind: 'error', text: '模型调用失败：boom' });
    // the host stored nothing, so the retry arrives marked fresh — it must still append
    stream({ kind: 'start', sessionId: 's1', question: '第二次', fresh: true });
    stream({ kind: 'end', sessionId: 's1', ok: true, text: '答好了' });
    const text = textOf(render(it.registered.component, it.react, it.t));
    assert.equal(text.includes('第一次'), true, 'the failed turn was wiped by the retry');
    assert.equal(text.includes('模型调用失败：boom'), true);
    assert.equal(text.includes('第二次'), true);
    assert.equal(text.includes('答好了'), true);
}
console.log('ok 22 retry appends below the failure');

for (const cleanup of cleanups.splice(0)) cleanup();

console.log('\nall /ask client stub checks passed');
