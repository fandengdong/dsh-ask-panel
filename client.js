/**
 * Browser half of dsh-ask-panel: the `/ask` panel as a right-Sidebar tab.
 *
 * A side answer is a multi-turn, markdown document, which is what the right
 * column is for — a persistent, scrollable surface beside files, jobs, and
 * document previews. It replaces the earlier floating overlay, which had to be
 * measured against the composer and still scrolled out of the way.
 *
 * Mechanics, all client-side:
 *
 * - A **page type** is registered with `ctx.sidebarRightTabs`: opened by kind,
 *   it recognizes no address, and pages deduplicate within their pane, so
 *   `/ask` re-opens the one tab instead of stacking new ones.
 * - The body registers under that definition's `id` into the keyed
 *   `sidebar.right.pane.tab` seat, and the chip title falls back to the
 *   registry's own `title()` text.
 * - The column is revealed with `ctx.sidebarRight.openTab(kind)` as soon as an
 *   answer arrives, because content the user cannot see is not opened.
 *
 * Two host signals feed it, deliberately redundantly: live frames over
 * `ask/stream` (which carry the question and type the answer out), and the
 * durable `command/executed` result (which stays authoritative and covers a
 * client that missed the stream).
 *
 * Hand-written bundle: the host serves a client face verbatim (`dsh.client`
 * declares the package, `exports["./client"]` locates the file) and does not
 * bundle it, so this file is the lazy-CJS registration the vendored client
 * loader consumes.
 */
window.__ModuleLoader__.load({
	id: "dsh-ask-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** Locale namespace carrying this panel's copy. */
		const NS = "ask";

		/** Tab identity: the definition id, and the key its body registers under. */
		const TAB_ID = "dsh-ask-panel";

		/** Page kind `ctx.sidebarRight.openTab` names for the side chat. */
		const TAB_KIND = "ask";

		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			title: "问一句",
			working: "正在查证…",
			thinking: "思考中…",
			followUp: "接着问…（Enter 发送）",
			send: "发送",
			busy: "等这次回答结束…",
			empty: "还没有问题 —— 在下面的输入框里直接问就行，不会打断主任务。",
			guide: "对着当前工作侧向提问，不打断主任务，可以追问",
			you: "你",
			resetTitle: "重置上下文：下一个问题按当前上下文重新开始（记录保留）",
			resetNote: "上下文已重置",
		};

		/** English dictionary, checked complete against the Chinese key set. */
		const en = {
			title: "Ask",
			working: "Looking it up…",
			thinking: "Thinking…",
			followUp: "Ask a follow-up… (Enter to send)",
			send: "Send",
			busy: "Wait for this answer…",
			empty: "No question yet — just ask below. It never interrupts the main task.",
			guide: "Ask about the work in progress without interrupting it, with follow-ups",
			you: "You",
			resetTitle: "Reset the context: the next question re-anchors (the log stays)",
			resetNote: "Context reset",
		};

		/**
		 * Services this client face needs before it registers.
		 *
		 * `remote.commands` is listed separately from `remote` on purpose: cordis
		 * gates service property access on injection, and reaching the sub-namespace
		 * without declaring it throws `cannot get property "remote.commands" without
		 * inject` at call time — which is exactly how the first follow-up failed.
		 */
		const inject = ["slots", "locale", "remote", "remote.commands", "sessions", "sidebarRightTabs", "sidebarRight"];

		/** How much of the live thinking trace stays on screen. */
		const REASONING_TAIL = 700;

		/** Host event carrying live side-answer frames; mirrors the host half's name. */
		const STREAM_EVENT = "ask/stream";

		/** One live thread, or null while nothing has been asked in this browser. */
		let current = null;

		const listeners = new Set();

		/** Client context captured at apply time, so the panel can submit follow-ups. */
		let clientCtx = null;

		/**
		 * Publish the next panel state.
		 * @param next - panel state, or null when nothing has been asked.
		 */
		function publish(next) {
			current = next;
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					/* A view failure must never break the publish path. */
				}
			}
		}

		/**
		 * Subscribe to panel-state changes.
		 * @param listener - change callback.
		 * @returns the unsubscribe disposer.
		 */
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}

		/** Read the live panel state. */
		function snapshot() {
			return current;
		}

		/** Where one session's visible log is kept across a page reload. */
		const PANEL_STORAGE_PREFIX = "dsh:ask-panel:panel:";

		/** How many turns survive a reload; the log is a convenience, not an archive. */
		const PANEL_KEEP_TURNS = 12;

		/**
		 * Persist the visible log for one session.
		 *
		 * The turns live in this module's memory, so without this a refresh emptied
		 * the panel even though the host still holds the thread.
		 *
		 * @param sessionId - owning session.
		 * @param panel - the state to store.
		 */
		function savePanel(sessionId, panel) {
			try {
				window.localStorage.setItem(PANEL_STORAGE_PREFIX + sessionId, JSON.stringify({
					v: 1,
					note: typeof panel.note === "string" ? panel.note : "",
					turns: panel.turns.slice(-PANEL_KEEP_TURNS)
				}));
			} catch {
				/* A browser that refuses storage simply keeps today's behaviour. */
			}
		}

		/**
		 * Restore one session's visible log after a reload.
		 *
		 * @param sessionId - owning session.
		 */
		function restorePanel(sessionId) {
			if (current !== null && current.sessionId === sessionId) return;
			let stored = null;
			try {
				const raw = window.localStorage.getItem(PANEL_STORAGE_PREFIX + sessionId);
				stored = raw === null ? null : JSON.parse(raw);
			} catch {
				stored = null;
			}
			if (stored === null || !Array.isArray(stored.turns) || stored.turns.length === 0) return;
			publish({
				sessionId,
				turns: stored.turns,
				sending: false,
				error: "",
				note: typeof stored.note === "string" ? stored.note : ""
			});
		}

		/**
		 * The session the right column is showing.
		 *
		 * The panel is a session-scoped seat whose input must address whichever
		 * session is current now, not one remembered from an earlier question —
		 * otherwise a standing panel would ask into the wrong conversation.
		 *
		 * @returns the current session id, or null when none is selected.
		 */
		function currentSessionId() {
			if (clientCtx === null) return null;
			try {
				const id = clientCtx.sessions.list.getSnapshot()?.current;
				return typeof id === "string" ? id : null;
			} catch {
				return null;
			}
		}

		/**
		 * Reveal the right column on this tab.
		 *
		 * Called with no seat mounted it throws, so the outcome is reported rather
		 * than logged: the standing-panel retry is the only caller that cares.
		 *
		 * @returns whether the column accepted the tab.
		 */
		function reveal() {
			if (clientCtx === null) return false;
			try {
				clientCtx.sidebarRight.openTab(TAB_KIND);
				return true;
			} catch {
				// No seat mounted yet, or the type is not registered: the durable
				// command card still carries the answer, so this stays contained.
				return false;
			}
		}

		/** Whether the column is currently showing its panel, when the kit can say. */
		function columnExpanded() {
			if (clientCtx === null) return null;
			try {
				return clientCtx.sidebarRight.isExpanded();
			} catch {
				return null;
			}
		}

		/** Turn keys for React; a monotonic counter suits an append-only list. */
		let turnSeq = 0;

		/** A fresh turn for one question. */
		function newTurn(question) {
			turnSeq += 1;
			return {
				key: turnSeq,
				question,
				text: "",
				reasoning: "",
				activity: "",
				kind: "success",
				done: false,
				time: Date.now()
			};
		}

		/**
		 * A context boundary in the log.
		 *
		 * A row of its own rather than a note pinned to the panel: a boundary belongs
		 * between the turns it separates, and it carries the time it happened so the
		 * thread reads as a dated record.
		 *
		 * @param label - the boundary's text.
		 * @returns a divider entry shaped like a settled turn.
		 */
		function newDivider(label) {
			turnSeq += 1;
			return {
				key: turnSeq,
				divider: true,
				question: "",
				text: label,
				reasoning: "",
				activity: "",
				kind: "success",
				done: true,
				time: Date.now()
			};
		}

		/**
		 * Wall-clock `HH:MM` for one entry.
		 * @param ms - epoch milliseconds.
		 * @returns the local time, or an empty string when it cannot be formatted.
		 */
		function hhmm(ms) {
			try {
				return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch {
				return "";
			}
		}

		/** Whether one turn is still being written, or a follow-up is on its way. */
		function isBusy(panel) {
			return panel.sending === true || panel.turns.some((turn) => !turn.done);
		}

		/**
		 * Publish a settled panel and record it, so a reload can restore the log.
		 *
		 * @param sessionId - owning session.
		 * @param panel - the settled state.
		 */
		function publishAndSave(sessionId, panel) {
			publish(panel);
			if (panel !== null) savePanel(sessionId, panel);
		}

		/** Replace the newest turn, leaving the rest of the panel state alone. */
		function withLastTurn(panel, update) {
			if (panel === null || panel.turns.length === 0) return panel;
			const turns = panel.turns.slice();
			turns[turns.length - 1] = update(turns[turns.length - 1]);
			return { ...panel, turns };
		}

		/**
		 * Settle the newest turn from an authoritative command result.
		 *
		 * @param result - the settled command result for this side answer.
		 */
		function settleLastTurn(result) {
			const settled = withLastTurn(current, (turn) => ({
				...turn,
				kind: result.kind,
				reasoning: "",
				text: typeof result.text === "string" && result.text.length > 0 ? result.text : turn.text,
				activity: "",
				done: true
			}));
			if (settled !== null) {
				publish(settled);
				savePanel(settled.sessionId, settled);
			}
		}

		/**
		 * Ask one question in the standing panel.
		 *
		 * The thread lives in the host command handler, so a question is simply a
		 * `/ask` invocation through the same remote seam the composer uses — and its
		 * answer arrives over the same live stream. Working from an empty panel is
		 * the normal case now: the panel is standing furniture, not a command echo.
		 *
		 * @param text - the question.
		 */
		async function ask(text) {
			if (clientCtx === null) return;
			const question = text.trim();
			if (question.length === 0) return;
			const sessionId = currentSessionId();
			if (sessionId === null) return;
			const panel = current !== null && current.sessionId === sessionId ? current : null;
			if (panel !== null && isBusy(panel)) return;
			// Show the question at once, whether the panel is empty or holds a restored
			// log: the host's `start` frame then reconciles this very turn instead of
			// appending a duplicate.
			publish({
				sessionId,
				turns: panel === null ? [newTurn(question)] : [...panel.turns, newTurn(question)],
				sending: true,
				error: ""
			});
			try {
				const outcome = await clientCtx.remote.commands.execute(sessionId, `/ask ${question}`, []);
				if (outcome.ok !== true) throw new Error(outcome.error?.message ?? "命令调用失败");
				const result = outcome.value?.result;
				if (result !== undefined) settleLastTurn(result);
				const settled = current;
				if (settled !== null) publish({ ...settled, sending: false });
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const base = current ?? panel ?? { sessionId, turns: [], sending: true, error: "" };
				const settled = withLastTurn(base, (turn) => (turn.done ? turn : { ...turn, done: true, kind: "error" }));
				publish({ ...(settled ?? base), sending: false, error: reason });
			}
		}

		/**
		 * Drop the side thread, so the next question is answered against a context
		 * with no side history attached.
		 *
		 * The host owns the thread, so the reset is a command; the panel clears
		 * immediately and reports the host's refusal if it could not be dropped.
		 */
		async function reset() {
			if (clientCtx === null) return;
			const panel = current;
			const sessionId = panel === null ? currentSessionId() : panel.sessionId;
			if (sessionId === null) return;
			// The panel is the user's record of the side chat, so a reset drops the
			// host's thread without clearing the screen; it marks the boundary instead.
			if (panel !== null) {
				const t = clientCtx.locale.bind(NS);
				publishAndSave(sessionId, {
					...panel,
					error: "",
					note: "",
					turns: [...panel.turns, newDivider(t("resetNote"))]
				});
			}
			try {
				const outcome = await clientCtx.remote.commands.execute(sessionId, "/ask --reset", []);
				if (outcome.ok !== true) throw new Error(outcome.error?.message ?? "重置失败");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				publish({ sessionId, turns: [], sending: false, error: reason });
			}
		}

		/**
		 * Fold one live frame into the panel.
		 *
		 * A `start` frame opens a turn: it replaces the whole panel when the host
		 * reports a fresh thread, and appends otherwise — which is what makes a
		 * follow-up read as a continuation instead of a brand-new answer.
		 *
		 * @param frame - one `ask/stream` payload from the host half.
		 */
		function applyStreamFrame(frame) {
			if (frame === null || typeof frame !== "object") return;
			const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
			if (frame.kind === "start") {
				const question = typeof frame.question === "string" ? frame.question : "";
				const panel = current !== null && current.sessionId === sessionId ? current : null;
				const last = panel !== null && panel.turns.length > 0 ? panel.turns[panel.turns.length - 1] : null;
				if (panel !== null && panel.sending === true && last !== null
					&& last.text.length === 0 && last.question === question) {
					// This frame is the host picking up the turn the panel already shows.
					publish({ ...panel, sending: false, error: "" });
					reveal();
					return;
				}
				// Append-only: the host reports `fresh` whenever its side thread was
				// dropped (a failed answer is never stored), and replacing the panel on
				// that signal wiped the user's record. A retry must sit below the
				// failure it follows.
				publish({
					sessionId,
					turns: panel === null ? [newTurn(question)] : [...panel.turns, newTurn(question)],
					sending: false,
					error: ""
				});
				reveal();
				return;
			}
			const panel = current;
			if (panel === null || panel.sessionId !== sessionId) return;
			if (frame.kind === "delta") {
				if (typeof frame.text !== "string") return;
				publish(withLastTurn(panel, (turn) => (turn.done ? turn : { ...turn, text: turn.text + frame.text })));
				return;
			}
			if (frame.kind === "reasoning") {
				if (typeof frame.text !== "string") return;
				publish(withLastTurn(panel, (turn) => (turn.done ? turn : { ...turn, reasoning: turn.reasoning + frame.text })));
				return;
			}
			if (frame.kind === "tool") {
				const names = Array.isArray(frame.names) ? frame.names.filter((name) => typeof name === "string") : [];
				publish(withLastTurn(panel, (turn) => (turn.done ? turn : {
					...turn,
					activity: names.length === 0 ? "" : `正在调用 ${names.join("、")}`
				})));
				return;
			}
			if (frame.kind === "end") {
				publishAndSave(sessionId, withLastTurn(panel, (turn) => ({
					...turn,
					reasoning: "",
					activity: "",
					text: typeof frame.text === "string" && frame.text.length > 0 ? frame.text : turn.text,
					done: true
				})));
			}
		}

		/**
		 * Split one markdown table row into its cells.
		 * @param line - the raw `| a | b |` line.
		 * @returns trimmed cell texts.
		 */
		function splitRow(line) {
			return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
		}

		/**
		 * Render inline markdown: code spans, bold, italics, and links.
		 *
		 * The core markdown renderer is not a public client export (the bundles are
		 * lazy-CJS, so only their `exports` are reachable), hence this small one.
		 *
		 * @param text - one block's inline text.
		 * @param prefix - key prefix for the produced nodes.
		 * @returns the rendered inline nodes.
		 */
		function renderInline(text, prefix) {
			const nodes = [];
			const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
			let last = 0;
			let index = 0;
			let match = pattern.exec(text);
			while (match !== null) {
				if (match.index > last) nodes.push(text.slice(last, match.index));
				const token = match[0];
				const key = `${prefix}-i${index}`;
				index += 1;
				if (token.startsWith("`")) {
					nodes.push(React.createElement("code", { key, style: styles.inlineCode }, token.slice(1, -1)));
				} else if (token.startsWith("**")) {
					nodes.push(React.createElement("strong", { key }, token.slice(2, -2)));
				} else if (token.startsWith("*")) {
					nodes.push(React.createElement("em", { key }, token.slice(1, -1)));
				} else {
					const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
					nodes.push(React.createElement("a", {
						key,
						href: link === null ? "#" : link[2],
						target: "_blank",
						rel: "noreferrer",
						style: styles.link
					}, link === null ? token : link[1]));
				}
				last = match.index + token.length;
				match = pattern.exec(text);
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		/** Whether a line opens some block other than a paragraph. */
		function startsBlock(line) {
			return /^\s*$/.test(line)
				|| /^```/.test(line)
				|| /^#{1,6}\s/.test(line)
				|| /^>\s?/.test(line)
				|| /^\s*([-*+]|\d+\.)\s/.test(line)
				|| /^\s*\|.*\|\s*$/.test(line);
		}

		/**
		 * Render one markdown answer into block elements.
		 *
		 * Deliberately small: fenced code, headings, lists, blockquotes, rules,
		 * pipe tables, paragraphs, and the inline forms above. It is enough for the
		 * shapes a model actually writes in a status answer — tables in particular,
		 * which is why pre-wrapped text was not good enough.
		 *
		 * @param text - the answer text.
		 * @returns an array of keyed block elements.
		 */
		function renderMarkdown(text) {
			const lines = String(text).split("\n");
			const blocks = [];
			let index = 0;
			let key = 0;
			while (index < lines.length) {
				const line = lines[index];
				if (/^```/.test(line)) {
					const lang = line.slice(3).trim();
					const body = [];
					index += 1;
					while (index < lines.length && !/^```/.test(lines[index])) {
						body.push(lines[index]);
						index += 1;
					}
					index += 1;
					blocks.push(React.createElement("pre", { key: `b${key}`, style: styles.code },
						React.createElement("code", { "data-lang": lang.length === 0 ? undefined : lang }, body.join("\n"))));
					key += 1;
					continue;
				}
				if (/^\s*$/.test(line)) {
					index += 1;
					continue;
				}
				if (/^#{1,6}\s/.test(line)) {
					const depth = /^(#+)/.exec(line)[1].length;
					blocks.push(React.createElement(`h${Math.min(depth + 3, 6)}`, {
						key: `b${key}`,
						style: styles.heading
					}, renderInline(line.replace(/^#+\s*/, ""), `h${key}`)));
					key += 1;
					index += 1;
					continue;
				}
				if (/^>\s?/.test(line)) {
					const body = [];
					while (index < lines.length && /^>\s?/.test(lines[index])) {
						body.push(lines[index].replace(/^>\s?/, ""));
						index += 1;
					}
					blocks.push(React.createElement("blockquote", { key: `b${key}`, style: styles.quote },
						renderInline(body.join(" "), `q${key}`)));
					key += 1;
					continue;
				}
				if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
					const ordered = /^\s*\d+\./.test(line);
					const items = [];
					while (index < lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[index])) {
						const itemKey = `li${index}`;
						items.push(React.createElement("li", { key: itemKey },
							renderInline(lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, ""), itemKey)));
						index += 1;
					}
					blocks.push(React.createElement(ordered ? "ol" : "ul", { key: `b${key}`, style: styles.list }, items));
					key += 1;
					continue;
				}
				if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
					blocks.push(React.createElement("hr", { key: `b${key}` }));
					key += 1;
					index += 1;
					continue;
				}
				if (/^\s*\|.*\|\s*$/.test(line)
					&& index + 1 < lines.length
					&& /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
					const header = splitRow(line);
					index += 2;
					const rows = [];
					while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
						rows.push(splitRow(lines[index]));
						index += 1;
					}
					blocks.push(React.createElement("table", { key: `b${key}`, style: styles.table }, [
						React.createElement("thead", { key: "head" }, React.createElement("tr", { key: "row" },
							header.map((cell, column) => React.createElement("th", {
								key: `h${column}`,
								style: styles.th
							}, renderInline(cell, `th${column}`))))),
						React.createElement("tbody", { key: "body" }, rows.map((row, rowIndex) => React.createElement("tr", {
							key: `r${rowIndex}`
						}, row.map((cell, column) => React.createElement("td", {
							key: `c${column}`,
							style: styles.td
						}, renderInline(cell, `td${rowIndex}-${column}`))))))
					]));
					key += 1;
					continue;
				}
				const paragraph = [];
				while (index < lines.length && !startsBlock(lines[index])) {
					paragraph.push(lines[index]);
					index += 1;
				}
				if (paragraph.length === 0) {
					// A block opener we did not claim: keep it as prose, but always advance.
					paragraph.push(lines[index]);
					index += 1;
				}
				blocks.push(React.createElement("p", { key: `b${key}`, style: styles.paragraph },
					renderInline(paragraph.join(" "), `p${key}`)));
				key += 1;
			}
			return blocks;
		}

		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				color: "var(--dsw-alias-label-primary)",
				fontSize: "var(--dsh-content-font-size, 13px)",
				lineHeight: 1.6
			},
			body: {
				flex: "1 1 auto",
				minHeight: 0,
				overflowY: "auto",
				padding: "14px 16px 6px"
			},
			turn: {
				display: "flex",
				flexDirection: "column",
				marginBottom: "16px"
			},
			/** Rules mean "the context changed here", so nothing else uses a line. */
			boundary: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				margin: "16px 0"
			},
			boundaryLine: {
				flex: "1 1 auto",
				height: "1px",
				background: "var(--dsw-alias-border-l2)"
			},
			boundaryLabel: {
				flex: "none",
				color: "var(--dsw-alias-label-caption)",
				fontSize: "11px",
				whiteSpace: "nowrap"
			},
			divider: {
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				margin: "12px 0 10px"
			},
			/** The human's question, as a right-aligned bubble — the clearest signal of who spoke. */
			question: {
				alignSelf: "flex-end",
				maxWidth: "88%",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.07))",
				borderRadius: "10px",
				padding: "6px 10px",
				marginBottom: "8px",
				fontSize: "12.5px",
				lineHeight: 1.55,
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere"
			},
			questionLabel: {
				display: "block",
				color: "var(--dsw-alias-label-caption)",
				fontSize: "10px",
				letterSpacing: "0.06em",
				textTransform: "uppercase",
				marginBottom: "2px"
			},
			answer: {
				overflowWrap: "anywhere"
			},
			paragraph: {
				margin: "0 0 8px"
			},
			heading: {
				margin: "12px 0 6px",
				fontSize: "14px",
				fontWeight: 600
			},
			list: {
				margin: "0 0 8px",
				paddingLeft: "22px"
			},
			quote: {
				margin: "0 0 8px",
				paddingLeft: "10px",
				borderLeft: "3px solid var(--dsw-alias-border-l2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			code: {
				margin: "0 0 8px",
				padding: "8px 10px",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06))",
				borderRadius: "8px",
				overflowX: "auto",
				fontSize: "12px",
				lineHeight: 1.5,
				whiteSpace: "pre"
			},
			inlineCode: {
				padding: "0 4px",
				borderRadius: "4px",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))",
				fontFamily: "var(--dsw-font-family-mono, monospace)",
				fontSize: "0.92em"
			},
			table: {
				margin: "0 0 8px",
				borderCollapse: "collapse",
				width: "100%",
				fontSize: "12.5px"
			},
			th: {
				border: "1px solid var(--dsw-alias-border-l2)",
				padding: "4px 8px",
				textAlign: "left",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.04))"
			},
			td: {
				border: "1px solid var(--dsw-alias-border-l2)",
				padding: "4px 8px"
			},
			link: {
				color: "var(--dsw-alias-state-business-primary, #4c8dff)"
			},
			caret: {
				opacity: 0.7
			},
			activity: {
				color: "var(--dsw-alias-label-caption)",
				fontSize: "12px",
				marginTop: "4px"
			},
			/** Thinking sits in a fixed slot so nothing below it ever moves. */
			thinkingBox: {
				marginBottom: "8px"
			},
			thinkingLabel: {
				color: "var(--dsw-alias-label-caption)",
				fontSize: "11px",
				lineHeight: 1.4,
				marginBottom: "2px"
			},
			/**
			 * Exactly three lines, newest at the bottom and older lines clipped off the
			 * top: a live trace that never changes the layout around it.
			 */
			thinkingText: {
				display: "flex",
				flexDirection: "column",
				justifyContent: "flex-end",
				height: "4.65em",
				overflow: "hidden",
				color: "var(--dsw-alias-label-caption)",
				fontStyle: "italic",
				fontSize: "12px",
				lineHeight: 1.55,
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere",
				opacity: 0.85
			},
			empty: {
				color: "var(--dsw-alias-label-caption)",
				fontSize: "12px",
				lineHeight: 1.7,
				padding: "20px 6px",
				textAlign: "center"
			},
			composer: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "10px 14px 12px",
				borderTop: "1px solid var(--dsw-alias-border-l2)"
			},
			input: {
				flex: "1 1 auto",
				minWidth: 0,
				background: "var(--dsw-specific-selector, rgba(255, 255, 255, 0.05))",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "10px",
				outline: "none",
				padding: "7px 12px",
				fontSize: "13px",
				lineHeight: "20px"
			},
			send: {
				flex: "none",
				cursor: "pointer",
				border: "none",
				borderRadius: "999px",
				padding: "6px 14px",
				fontSize: "12px",
				background: "var(--dsw-alias-button-info-fill)",
				color: "#fff"
			},
			sendDisabled: {
				opacity: 0.4,
				cursor: "default"
			},
			reset: {
				flex: "none",
				cursor: "pointer",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				border: "none",
				borderRadius: "999px",
				width: "24px",
				height: "24px",
				lineHeight: "1",
				fontSize: "14px"
			},
			/** A boundary marker: the host's context was reset, the log was not. */
			note: {
				padding: "0 16px 10px",
				color: "var(--dsw-alias-label-caption)",
				fontSize: "11px",
				lineHeight: 1.5
			},
			/** An alert, not a line of prose: a rule and a tinted plate read faster. */
			error: {
				margin: "0 16px 12px",
				padding: "8px 10px",
				borderLeft: "3px solid var(--dsw-alias-state-error-primary, #e5484d)",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.05))",
				borderRadius: "6px",
				color: "var(--dsw-alias-state-error-primary, #e5484d)",
				fontSize: "12px",
				lineHeight: 1.55,
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere"
			}
		};

		/** Subscribe to the current session, so the panel follows a session switch. */
		function useActiveSession() {
			return React.useSyncExternalStore(
				(listener) => (clientCtx === null ? () => {} : clientCtx.sessions.list.subscribe(listener)),
				currentSessionId,
				currentSessionId
			);
		}

		/**
		 * The `/ask` panel, rendered as the right-Sidebar tab body.
		 *
		 * @param props - injected locale seat (`t`) from the declared namespace.
		 * @returns the thread so far plus the input that keeps it going.
		 */
		function BtwPanel(props) {
			const t = props.t;
			const stored = React.useSyncExternalStore(subscribe, snapshot, snapshot);
			const activeSession = useActiveSession();
			const [draft, setDraft] = React.useState("");
			const bodyRef = React.useRef(null);
			// The seat is session-scoped: never show another session's thread.
			const panel = stored !== null && activeSession !== null && stored.sessionId === activeSession ? stored : null;
			const turnCount = panel === null ? 0 : panel.turns.length;
			const lastLength = panel === null || turnCount === 0 ? 0 : panel.turns[turnCount - 1].text.length;
			const busy = panel !== null && isBusy(panel);

			// Keep the newest text in view while it streams in.
			React.useEffect(() => {
				const body = bodyRef.current;
				if (body !== null) body.scrollTop = body.scrollHeight;
			}, [turnCount, lastLength]);

			const submit = () => {
				const text = draft;
				setDraft("");
				ask(text);
			};
			const canSend = !busy && draft.length > 0;

			const body = panel === null || panel.turns.length === 0
				? React.createElement("div", { style: styles.empty }, t("empty"))
				: panel.turns.map((turn, index) => {
					const last = index === panel.turns.length - 1;
					const thinking = last && !turn.done ? turn.reasoning : "";
					const answer = turn.text.length > 0
						? turn.text
						: (last && thinking.length === 0 ? t("working") : "");
					if (turn.divider === true) {
						return React.createElement("div", { key: turn.key, style: styles.boundary }, [
							React.createElement("span", { key: "l", style: styles.boundaryLine }),
							React.createElement("span", { key: "t", style: styles.boundaryLabel },
								`\u27f2 ${turn.text}${turn.time === undefined ? "" : ` \u00b7 ${hhmm(turn.time)}`}`),
							React.createElement("span", { key: "r", style: styles.boundaryLine })
						]);
					}
					return React.createElement("div", {
						key: turn.key
					}, [
						turn.question.length === 0 ? null : React.createElement("div", {
							key: "q",
							style: styles.question
						}, [
							React.createElement("span", { key: "label", style: styles.questionLabel }, t("you")),
							React.createElement("span", { key: "text" }, turn.question)
						]),
						thinking.length === 0 ? null : React.createElement("div", {
							key: "r",
							style: styles.thinkingBox
						}, [
							React.createElement("div", { key: "label", style: styles.thinkingLabel }, t("thinking")),
							React.createElement("div", {
								key: "text",
								style: styles.thinkingText
							}, thinking.slice(-REASONING_TAIL))
						]),
						React.createElement("div", { key: "a", style: styles.answer }, [
							...renderMarkdown(answer),
							last && !turn.done
								? React.createElement("span", { key: "caret", style: styles.caret }, "\u258d")
								: null
						]),
						turn.activity.length > 0 && !turn.done
							? React.createElement("div", { key: "t", style: styles.activity }, turn.activity)
							: null
					]);
				});

			return React.createElement("div", { style: styles.root }, [
				React.createElement("div", { key: "body", ref: bodyRef, style: styles.body }, body),
				panel !== null && typeof panel.note === "string" && panel.note.length > 0
					? React.createElement("div", { key: "note", style: styles.note }, panel.note)
					: null,
				panel !== null && panel.error.length > 0
					? React.createElement("div", { key: "error", style: styles.error }, panel.error)
					: null,
				React.createElement("div", { key: "composer", style: styles.composer }, [
					React.createElement("button", {
						key: "reset",
						type: "button",
						style: busy ? { ...styles.reset, ...styles.sendDisabled } : styles.reset,
						title: t("resetTitle"),
						"aria-label": t("resetTitle"),
						disabled: busy,
						onClick: reset
					}, "\u21ba"),
					React.createElement("input", {
						key: "input",
						type: "text",
						style: styles.input,
						value: draft,
						placeholder: busy ? t("busy") : t("followUp"),
						disabled: busy,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key !== "Enter" || event.nativeEvent?.isComposing === true) return;
							event.preventDefault();
							event.stopPropagation();
							submit();
						}
					}),
					React.createElement("button", {
						key: "send",
						type: "button",
						style: canSend ? styles.send : { ...styles.send, ...styles.sendDisabled },
						disabled: !canSend,
						onClick: submit
					}, t("send"))
				])
			]);
		}

		/**
		 * Install the tab type, its body, the dictionaries, and the two result
		 * signals that feed the panel.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			clientCtx = ctx;
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ask-panel: dictionaries");
			ctx.effect(() => ctx.remote.$on(STREAM_EVENT, applyStreamFrame), "ask-panel: live stream");
			// The durable command result stays authoritative: it also covers a client
			// that missed the stream entirely (an older page, a dropped frame, or a
			// host that predates the stream).
			ctx.effect(() => ctx.on("command/executed", (sessionId, name, result) => {
				if (name !== "ask") return;
				if (current === null) {
					publish({ sessionId: String(sessionId), turns: [newTurn("")], sending: false, error: "" });
				}
				settleLastTurn(result);
				reveal();
			}), "ask-panel: result capture");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => t("title"),
				guide: [{ order: 40, title: () => t("title"), description: () => t("guide") }]
			}), "ask-panel: tab type");
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				locale: NS
			}, BtwPanel));
			// The panel is standing furniture on the right, so it opens itself as soon
			// as the column can accept it. Requiring the user to find it in the
			// add-guide every session would defeat the point.
			ctx.effect(() => {
				// Per SESSION, not per page load: the column's tabs belong to a session's
				// surface, so a panel stood up in one session is simply absent in the
				// next project's — which is why it used to appear only after a refresh.
				const standing = new Set();
				let attempts = 0;
				const stand = () => {
					const sessionId = currentSessionId();
					if (sessionId === null || standing.has(sessionId)) return;
					restorePanel(sessionId);
					if (reveal()) {
						standing.add(sessionId);
						attempts = 0;
						console.info(`[ask-panel] side chat standing in ${sessionId}; column expanded=${String(columnExpanded())}`);
						return;
					}
					attempts += 1;
					if (attempts === 8) console.info("[ask-panel] could not reveal the side chat; add it from the sidebar's add control");
				};
				// A steady beat, because nothing here can know when the moment is right:
				// the seat mounts asynchronously, a new session swaps the whole surface,
				// and the session feed makes no promise about arrangement changes.
				// `standing` keeps a repeat down to one string comparison.
				const timer = setInterval(stand, 2000);
				const unsubscribe = ctx.sessions.list.subscribe(() => {
					attempts = 0;
					stand();
				});
				stand();
				return () => {
					clearInterval(timer);
					unsubscribe();
				};
			}, "ask-panel: stand the panel");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
