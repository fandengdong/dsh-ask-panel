/**
 * Self-healing right-column width support for `dsh-client-ui-layout`.
 *
 * Why a plugin touches a core package at all: the column's width lives in the
 * layout store as `layoutInfo.rightbar`, which is per-page-load memory, and a
 * plugin cannot reach it — `ILayout`, the only cross-plugin layout face, exposes
 * `selectPanel`, `beginNavigation`, `toggleSidebar`, `openRightbar(track,
 * fullscreen)`, and `closeRightbar()`, with no width accessor.
 *
 * Why it heals itself: a `dsh` upgrade replaces the installation, so a patch
 * applied once at install time is silently reverted and the user is expected to
 * remember. Running the same idempotent check on every boot removes that
 * expectation: the common path is one file read and a marker test.
 *
 * The two edits, both on the minified client bundle the browser loads:
 *
 * 1. Seed `layoutInfo.rightbar` from `localStorage` at store creation, so the
 *    render uses the saved width instead of `viewport * 0.45`.
 * 2. Save it in `setRightbar`, which is where a drag writes.
 *
 * A third edit narrows the contract default from 45% of the frame to a third.
 * Anchors are exact and every edit is all-or-nothing per file: a future layout
 * bundle whose text shifted is reported as skipped rather than patched wrongly.
 *
 * @module dsh-ask-panel/patch-layout
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Marker proving the persistence edits are present. */
const MARKER = 'dsh-ask-panel:rightbar-persist';

/** Marker proving the default-ratio edit is present. */
const RATIO_MARKER = 'dsh-ask-panel:rightbar-default-ratio';

/** The helper pair injected next to the layout constants. */
const HELPER = `		/** ${MARKER} — the right column's width survives a reload. */
		const RIGHTBAR_STORAGE_KEY = "dsh:layout:rightbar";
		/** Read the saved right column width, or null when there is none to trust. */
		function restoreRightbar() {
			try {
				const raw = window.localStorage.getItem(RIGHTBAR_STORAGE_KEY);
				const px = raw === null ? Number.NaN : Number(raw);
				return Number.isFinite(px) && px > 0 ? px : null;
			} catch {
				return null;
			}
		}
		/** Save the right column width; a browser that refuses storage keeps today's behaviour. */
		function persistRightbar(px) {
			try {
				window.localStorage.setItem(RIGHTBAR_STORAGE_KEY, String(Math.round(px)));
			} catch {
				/* Storage unavailable: nothing to do, and nothing to break. */
			}
		}
`;

/** The persistence edits, each anchored on text that must match exactly once. */
const PERSISTENCE_EDITS = [
    {
        label: 'helper',
        anchor: '\t\tconst RIGHTBAR_DEFAULT_RATIO = .45;',
        replacement: `\t\tconst RIGHTBAR_DEFAULT_RATIO = .45;\n${HELPER}`,
    },
    {
        label: 'restore',
        anchor: '\t\t\t\t\t\trightbar: null,',
        replacement: '\t\t\t\t\t\trightbar: restoreRightbar(),',
    },
    {
        label: 'save',
        anchor: 'd.layoutInfo.rightbar = clampWidth(px, 300, Math.max(300, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO));',
        replacement: 'd.layoutInfo.rightbar = clampWidth(px, 300, Math.max(300, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO));\n\t\t\t\t\t\tpersistRightbar(d.layoutInfo.rightbar);',
    },
];

/**
 * Every layout client bundle reachable from this plugin.
 *
 * Resolution goes through the same module graph the host uses, so the file found
 * here is the file the browser is served — not a second copy somewhere else.
 *
 * @returns absolute paths, possibly empty.
 */
function layoutBundles() {
    const found = new Set();
    try {
        const resolve = createRequire(import.meta.url);
        const main = resolve.resolve('@deepseek-ai/dsh-client-ui-layout');
        found.add(join(dirname(main), 'client.js'));
    } catch {
        /* Not resolvable from this install: nothing to do. */
    }
    return [...found].filter((file) => existsSync(file));
}

/** Apply one edit list, all-or-nothing. */
function applyEdits(text, edits, marker, label, counter) {
    if (text.includes(marker)) return { text, status: `${label}:already` };
    for (const edit of edits) {
        const count = text.split(edit.anchor).length - 1;
        if (count !== 1) return { text, status: `${label}:skipped(anchor x${count})` };
    }
    let next = text;
    for (const edit of edits) next = next.replace(edit.anchor, edit.replacement);
    counter.changed = true;
    return { text: next, status: `${label}:applied` };
}

/**
 * Patch one bundle.
 *
 * @param file - absolute path of the layout client bundle.
 * @returns a one-line report.
 */
function patchOne(file) {
    try {
        const original = readFileSync(file, 'utf8');
        const counter = { changed: false };
        let text = original;
        const reports = [];
        for (const [edits, marker, label] of [
            [PERSISTENCE_EDITS, MARKER, 'persist'],
            [[{
                label: 'ratio',
                anchor: 'const RIGHTBAR_DEFAULT_RATIO = .45;',
                replacement: `const RIGHTBAR_DEFAULT_RATIO = 1 / 3; /* ${RATIO_MARKER} */`,
            }], RATIO_MARKER, 'ratio'],
        ]) {
            const result = applyEdits(text, edits, marker, label, counter);
            text = result.text;
            reports.push(result.status);
        }
        if (!counter.changed) return reports.join(',');
        // Keep exactly one backup per file, from before any of our edits.
        const backup = `${file}.bak-btw`;
        if (!existsSync(backup)) writeFileSync(backup, original);
        writeFileSync(file, text);
        return `${reports.join(',')},written`;
    } catch (error) {
        return `failed:${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Ensure every reachable layout bundle carries the width edits.
 *
 * Idempotent and cheap when already patched: one read and one marker test.
 * Never throws — a failed patch is a diagnosis, not a reason to stop booting.
 *
 * @returns one report line per candidate bundle.
 */
export function patchLayout() {
    try {
        const bundles = layoutBundles();
        if (bundles.length === 0) return ['no layout bundle reachable'];
        return bundles.map(patchOne);
    } catch (error) {
        return [`failed:${error instanceof Error ? error.message : String(error)}`];
    }
}
