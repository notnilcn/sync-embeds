const { Notice } = require('obsidian');

class ViewportController {
    constructor(plugin) {
        this.plugin = plugin;
    }

    async setupSectionViewport(embedData) {
        const { view, editor, file, section } = embedData;

        await new Promise(resolve => setTimeout(resolve, 100));

        const content = editor.getValue();
        const sectionInfo = this.findTargetBounds(content, section);

        if (!sectionInfo.found) {
            console.warn('Sync Embeds: Target not found for viewport embedding:', section);
            return;
        }

        embedData.sectionInfo = sectionInfo;
        embedData.viewportActive = true;

        this.applyViewportRestriction(embedData);
        this.setupBoundaryProtection(embedData);
        // Header hierarchy only means something inside a heading section.
        if (sectionInfo.type === 'heading') {
            this.setupHeaderInputInterception(embedData);
        }
        this.setupContentConstraints(embedData);
        this.scrollToSection(embedData);
    }

    applyViewportRestriction(embedData) {
        const { view } = embedData;

        const style = document.createElement('style');
        style.className = 'sync-viewport-style';

        const embedId = 'embed-' + Math.random().toString(36).substr(2, 9);
        view.containerEl.setAttribute('data-embed-id', embedId);
        embedData.embedId = embedId;

        // Tag this editor's own .cm-content so the line rules can use a child
        // combinator. Without it the descendant selector also matches the lines of
        // any embed nested inside this one, whose line numbering is unrelated.
        const tagContent = (attempts = 0) => {
            const cmContent = view.containerEl.querySelector('.cm-content');
            if (cmContent) {
                cmContent.setAttribute('data-embed-content-id', embedId);
                // Re-measure: the first pass may have run before the editor had a DOM.
                if (attempts > 0) this.updateViewportCSS(embedData, style);
            } else if (attempts < 20) {
                setTimeout(() => tagContent(attempts + 1), 50);
            }
        };
        tagContent();

        this.updateViewportCSS(embedData, style);
        view.containerEl.appendChild(style);
        embedData.viewportStyle = style;
    }

    updateViewportCSS(embedData, style) {
        const { sectionInfo, embedId } = embedData;
        const { domStartLine, domEndLine, exact } = this.toDomChildIndices(
            embedData,
            sectionInfo.startLine,
            sectionInfo.endLine
        );

        // These match every direct child, not just .cm-line, because Live Preview
        // renders code blocks and other block widgets as siblings of the lines —
        // matching only .cm-line would leave those widgets visible outside the region.
        //
        // The bottom rule is only emitted once the measurement is trustworthy (exact).
        // While CodeMirror is still laying the document out, a clamped domEndLine points
        // at the section itself, so hiding from there down would blank the whole embed —
        // AND collapse the content to zero height, which stops it ever scrolling far
        // enough to render the section. Skipping the bottom rule until exact keeps the
        // section visible and the editor scrollable so remeasureViewport can converge.
        const bottomRule = exact ? `
            /* Hide everything AFTER the section */
            [data-embed-content-id="${embedId}"] > :nth-child(n+${domEndLine + 1}) {
                display: none !important;
            }
        ` : '';

        const css = `
            /* Hide everything BEFORE and INCLUDING the section header */
            [data-embed-content-id="${embedId}"] > :nth-child(-n+${domStartLine + 1}) {
                display: none !important;
            }
${bottomRule}
            /* Catch-all to prevent overlapping text in collapsed line numbers */
            [data-embed-id="${embedId}"] .cm-gutterElement[style*="height: 0px"]:not([style*="visibility: hidden"]) {
                display: none !important;
            }
        `;

        style.textContent = css;
        return exact;
    }

    /**
     * Re-measure and rewrite the viewport CSS until it stops clamping.
     *
     * The initial pass in applyViewportRestriction runs while the embed's editor is
     * still detached from the page (loadEmbed only swaps the placeholder for the view
     * afterwards), so CodeMirror has only laid out the top of the document. Any section
     * below that window measures as "hide everything" and, left alone, stays blank once
     * CM finally renders the rest.
     *
     * CodeMirror only lays out (and lets posAtDOM place) the lines near its viewport, so
     * simply waiting isn't enough for a section far down the note — we have to scroll the
     * editor to the section to force those lines to render, then measure again. The CSS
     * from updateViewportCSS deliberately leaves the section visible while inexact, so the
     * content stays scrollable here instead of collapsing to zero height.
     *
     * There are two distinct problems and they need different tools:
     *
     * 1. Initial convergence. The editor may not be painted/sized for many frames (e.g. a
     *    leaf that isn't visible yet) and CodeMirror only lays out the lines near its
     *    viewport, so a section far down the note isn't measurable until we scroll CM to
     *    it. A short driver loop scrolls the section into view and measures until the
     *    bottom boundary is really rendered (exact).
     *
     * 2. Staying correct afterwards. The nth-child rule is relative to CodeMirror's FIRST
     *    RENDERED line, and CM's virtualized window does not always start at line 0 — so
     *    the child index of a given source line shifts every time CM re-renders its window
     *    (on scroll, on collapse when our own CSS hides lines, on resize). A rule frozen
     *    against one transient render state then points at the wrong lines and the embed
     *    goes blank. A MutationObserver on .cm-content's child list fires exactly when CM
     *    swaps its rendered lines, so we re-measure and keep the rule aligned for the whole
     *    life of the embed. (updateViewportCSS only rewrites a <style> outside .cm-content,
     *    so this doesn't feed back into the observer.)
     */
    remeasureViewport(embedData) {
        const style = embedData.viewportStyle;
        if (!embedData.viewportActive || !style || !style.isConnected) return;

        const cm = embedData.editor?.cm;
        const component = embedData.component;

        const sync = () => {
            if (!embedData.viewportActive || !style.isConnected) return true;
            return this.updateViewportCSS(embedData, style);
        };

        // (2) Keep the rule aligned to CM's current render window for the embed's lifetime.
        if (cm?.contentDOM && typeof MutationObserver !== 'undefined') {
            const mo = new MutationObserver(() => sync());
            mo.observe(cm.contentDOM, { childList: true });
            component?.register(() => mo.disconnect());
        }
        if (cm && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => sync());
            [cm.scrollDOM, cm.contentDOM].filter(Boolean).forEach((el) => ro.observe(el));
            component?.register(() => ro.disconnect());
        }

        // (1) Drive initial convergence. Stop the active nudging once exact — the observers
        // above take over — but cap it so a genuinely-missing section can't spin forever.
        if (sync()) return;
        let ticks = 0;
        const intervalId = window.setInterval(() => {
            try {
                const pos = { line: (embedData.sectionInfo?.startLine ?? 0) + 1, ch: 0 };
                embedData.editor?.scrollIntoView({ from: pos, to: pos }, true);
            } catch { /* editor not ready yet */ }
            if (sync() || ++ticks >= 60 || !embedData.viewportActive || !style.isConnected) {
                window.clearInterval(intervalId);
            }
        }, 100);
        component?.register(() => window.clearInterval(intervalId));
    }

    /**
     * Translate source line boundaries into child indices inside .cm-content.
     *
     * One source line is NOT one DOM child: CodeMirror folds frontmatter, and Live
     * Preview collapses tables, code blocks and other widgets into a single element.
     * Ask CodeMirror where each child actually starts rather than guessing.
     *
     * Returns the index of the last child to hide above the region, and the index of
     * the first child to hide below it.
     */
    toDomChildIndices(embedData, startLine, endLine) {
        const cm = embedData.editor?.cm;
        const children = cm?.contentDOM?.children;

        if (cm && children && children.length) {
            let domStartLine = -1;
            let domEndLine = children.length;
            let measured = false;
            let endFound = false;

            for (let i = 0; i < children.length; i++) {
                let line;
                try {
                    line = cm.state.doc.lineAt(cm.posAtDOM(children[i])).number - 1;
                } catch {
                    continue; // child CodeMirror cannot place; skip it
                }
                measured = true;
                if (line <= startLine) domStartLine = i;
                if (line >= endLine && domEndLine === children.length) {
                    domEndLine = i;
                    endFound = true;
                }
            }

            if (measured) {
                // The measurement is only trustworthy once the children CodeMirror has
                // rendered actually span the section. When the editor is still detached
                // (or the section sits below the initially-rendered window), CM has only
                // laid out the top of the document, so the bottom boundary isn't present
                // and domStartLine/domEndLine collapse to "hide everything". Report that
                // as inexact so the caller can re-measure once CM has rendered further.
                const lastDocLine = cm.state.doc.lines - 1;
                const exact = endFound || endLine > lastDocLine;
                return { domStartLine, domEndLine, exact };
            }
        }

        // Fallback: assume one line per child, correcting only for folded frontmatter.
        const domOffset = this.getFrontmatterDomOffset(embedData.file);
        return {
            // -1 is legal: the region starts at the very first child, nothing to hide above.
            domStartLine: Math.max(-1, startLine - domOffset),
            domEndLine: Math.max(0, endLine - domOffset),
            exact: true // nothing better to measure against; don't loop forever
        };
    }

    /**
     * CodeMirror folds frontmatter down to a single line, so DOM children below it
     * sit higher than their source line number suggests.
     */
    getFrontmatterDomOffset(file) {
        const fileCache = this.plugin.app.metadataCache.getFileCache(file);
        // No +1 needed because the first line is retained by CM6 for the fold widget.
        return fileCache?.frontmatterPosition?.end.line || 0;
    }

    setupBoundaryProtection(embedData) {
        const { view, editor, component } = embedData;

        const setupHandlers = () => {
            const cmEditor = view.containerEl.querySelector('.cm-content');
            if (!cmEditor) {
                setTimeout(setupHandlers, 50);
                return;
            }

            const keydownHandler = (event) => {
                if (!embedData.viewportActive || !embedData.sectionInfo) return;

                const { startLine, endLine } = embedData.sectionInfo;
                const cursor = editor.getCursor();
                const selection = editor.getSelection();

                // PROTECT TOP BOUNDARY (Block Backspace from deleting the invisible boundary newline)
                if (event.key === 'Backspace') {
                    if (selection) {
                        const from = editor.getCursor('from');
                        if (from.line <= startLine) {
                            event.preventDefault();
                            return;
                        }
                    } else {
                        if (cursor.line === startLine + 1 && cursor.ch === 0) {
                            event.preventDefault();
                            return;
                        }
                    }
                }

                // PROTECT BOTTOM BOUNDARY (Block Delete from deleting the invisible boundary newline)
                if (event.key === 'Delete') {
                    if (selection) {
                        const to = editor.getCursor('to');
                        if (to.line >= endLine) {
                            event.preventDefault();
                            return;
                        }
                    } else {
                        const lastEditableLine = endLine - 1;
                        const lastLineLength = editor.getLine(lastEditableLine)?.length || 0;
                        if (cursor.line === lastEditableLine && cursor.ch === lastLineLength) {
                            event.preventDefault();
                            return;
                        }
                    }
                }
            };

            cmEditor.addEventListener('keydown', keydownHandler, true);
            component.register(() => {
                cmEditor.removeEventListener('keydown', keydownHandler, true);
            });
        };

        setTimeout(setupHandlers, 100);
    }

    setupHeaderInputInterception(embedData) {
        const { view, editor, component } = embedData;
        const { headerLevel } = embedData.sectionInfo;

        let lastNoticeTime = 0;
        const noticeDebounce = 5000;

        const setupHandlers = () => {
            const cmEditor = view.containerEl.querySelector('.cm-content');
            if (!cmEditor) {
                setTimeout(setupHandlers, 50);
                return;
            }

            const inputHandler = (event) => {
                if (event.inputType !== 'insertText' && event.inputType !== 'insertFromPaste') return;
                if (event.data !== '#') return;

                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const beforeHash = line.substring(0, cursor.ch - 1);
                const isAtLineStart = /^\s*$/.test(beforeHash);

                if (isAtLineStart &&
                    cursor.line > embedData.sectionInfo.startLine &&
                    cursor.line < embedData.sectionInfo.endLine) {

                    const currentLine = editor.getLine(cursor.line);
                    const newLine = currentLine.substring(0, cursor.ch - 1) + currentLine.substring(cursor.ch);
                    editor.replaceRange(
                        newLine,
                        { line: cursor.line, ch: 0 },
                        { line: cursor.line, ch: currentLine.length }
                    );
                    editor.setCursor({ line: cursor.line, ch: cursor.ch - 1 });

                    const now = Date.now();
                    if (this.plugin.settings.showHeaderHints &&
                        now - lastNoticeTime > noticeDebounce) {
                        lastNoticeTime = now;
                        const availableLevels = [];
                        for (let i = headerLevel + 1; i <= 6; i++) {
                            availableLevels.push(`H${i} (Alt+${i})`);
                        }
                        new Notice(`⚠️ Cannot create H1-H${headerLevel} headers in this section.\nUse: ${availableLevels.join(', ')}`, 5000);
                    }
                }
            };

            const pasteHandler = (event) => {
                const clipboardData = event.clipboardData?.getData('text');
                if (!clipboardData) return;

                const cursor = editor.getCursor();
                if (cursor.line > embedData.sectionInfo.startLine &&
                    cursor.line < embedData.sectionInfo.endLine) {

                    const lines = clipboardData.split('\n');
                    let hasInvalidHeaders = false;

                    const adjustedLines = lines.map(line => {
                        const match = line.match(/^(#{1,6})\s+(.*)$/);
                        if (!match) return line;

                        const [, hashes, content] = match;
                        if (hashes.length <= headerLevel) {
                            hasInvalidHeaders = true;
                            return '#'.repeat(headerLevel + 1) + ' ' + content;
                        }
                        return line;
                    });

                    if (hasInvalidHeaders) {
                        event.preventDefault();
                        if (this.plugin.settings.showHeaderHints) {
                            new Notice('Pasted headers adjusted to maintain section hierarchy', 4000);
                        }
                        editor.replaceSelection(adjustedLines.join('\n'));
                    }
                }
            };

            cmEditor.addEventListener('input', inputHandler, true);
            cmEditor.addEventListener('paste', pasteHandler, true);

            component.register(() => {
                cmEditor.removeEventListener('input', inputHandler, true);
                cmEditor.removeEventListener('paste', pasteHandler, true);
            });
        };

        setTimeout(setupHandlers, 100);
    }

    setupContentConstraints(embedData) {
        const { view, editor, component } = embedData;
        let isProgrammaticUpdate = false;

        // Force cursor strictly inside bounds (preventing up/down arrow drifting)
        const enforceCursorBounds = () => {
            if (isProgrammaticUpdate || !embedData.viewportActive || !embedData.sectionInfo) return;

            const { startLine, endLine } = embedData.sectionInfo;
            const cursor = editor.getCursor();

            if (cursor.line <= startLine) {
                isProgrammaticUpdate = true;
                editor.setCursor({ line: startLine + 1, ch: 0 });
                isProgrammaticUpdate = false;
            } else if (cursor.line >= endLine) {
                isProgrammaticUpdate = true;
                const lastEditableLine = endLine - 1;
                const lastLineLength = editor.getLine(lastEditableLine)?.length || 0;
                editor.setCursor({ line: lastEditableLine, ch: lastLineLength });
                isProgrammaticUpdate = false;
            }
        };

        const setupDOMListeners = () => {
            const cmContent = view.containerEl.querySelector('.cm-content');
            if (!cmContent) {
                setTimeout(setupDOMListeners, 50);
                return;
            }

            cmContent.addEventListener('mouseup', enforceCursorBounds);
            cmContent.addEventListener('focusin', enforceCursorBounds);
            cmContent.addEventListener('keyup', (e) => {
                if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                    enforceCursorBounds();
                }
            });

            component.register(() => {
                cmContent.removeEventListener('mouseup', enforceCursorBounds);
                cmContent.removeEventListener('focusin', enforceCursorBounds);
                cmContent.removeEventListener('keyup', enforceCursorBounds);
            });
        };

        setTimeout(setupDOMListeners, 100);

        // Retain text-change bounds checking
        component.registerEvent(
            this.plugin.app.workspace.on('editor-change', (changedEditor) => {
                if (changedEditor === editor) {
                    this.updateViewportImmediately(embedData);
                    enforceCursorBounds();
                }
            })
        );

        const cmScroller = view.containerEl.querySelector('.cm-scroller');
        if (cmScroller) {
            const preventScroll = (e) => {
                if (!embedData.viewportActive) return;

                const scrollTop = cmScroller.scrollTop;
                const lineHeight = editor.defaultTextHeight || 20;
                const firstVisibleLine = Math.floor(scrollTop / lineHeight);
                
                const indices = this.toDomChildIndices(
                    embedData,
                    embedData.sectionInfo.startLine,
                    embedData.sectionInfo.endLine
                );
                const domStartLine = Math.max(0, indices.domStartLine);
                const domEndLine = Math.max(0, indices.domEndLine);

                if (firstVisibleLine < Math.max(0, domStartLine - 2)) {
                    cmScroller.scrollTop = Math.max(0, domStartLine - 2) * lineHeight;
                } else if (firstVisibleLine > domEndLine - 2) {
                    cmScroller.scrollTop = (domEndLine - 2) * lineHeight;
                }
            };

            cmScroller.addEventListener('scroll', preventScroll);
            component.register(() => {
                cmScroller.removeEventListener('scroll', preventScroll);
            });
        }
    }

    updateViewportImmediately(embedData) {
        if (!embedData.viewportActive) return;

        const currentContent = embedData.editor.getValue();
        const newSectionInfo = this.findTargetBounds(currentContent, embedData.section);

        if (newSectionInfo.found) {
            embedData.sectionInfo = newSectionInfo;

            if (embedData.viewportStyle) {
                this.updateViewportCSS(embedData, embedData.viewportStyle);
            }
        }
    }

    scrollToSection(embedData) {
        const { editor, sectionInfo } = embedData;
        const { startLine } = sectionInfo;

        setTimeout(() => {
            const pos = { line: startLine + 1, ch: 0 };
            // scrollIntoView takes an EditorRange, not a position.
            editor.scrollIntoView({ from: pos, to: pos }, true);
            editor.setCursor(pos);
        }, 150);
    }

    /**
     * Resolve the link target after the '#' to a line range.
     *
     * The returned startLine/endLine are EXCLUSIVE boundaries: the editable region
     * is startLine + 1 through endLine - 1. For a heading, startLine is the heading
     * line itself (which is why it is hidden). For a block, startLine may be -1 when
     * the block is the very first thing in the file.
     */
    findTargetBounds(content, target) {
        if (target && target.startsWith('^')) {
            return this.findBlockBounds(content, target.substring(1));
        }
        return this.findSectionBounds(content, target);
    }

    findSectionBounds(content, sectionName) {
        const lines = content.split('\n');
        const escapedName = this.escapeRegExp(sectionName);
        const headerRegex = new RegExp(`^#{1,6}\\s+${escapedName}\\s*$`);

        let startLine = -1;
        let headerLevel = 0;

        for (let i = 0; i < lines.length; i++) {
            if (headerRegex.test(lines[i])) {
                startLine = i;
                headerLevel = (lines[i].match(/^#+/)?.[0] || '').length;
                break;
            }
        }

        if (startLine === -1) {
            return { found: false, startLine: -1, endLine: -1, headerLevel: 0, type: 'heading' };
        }

        let endLine = lines.length;
        for (let i = startLine + 1; i < lines.length; i++) {
            const match = lines[i].match(/^#+/);
            if (match && match[0].length <= headerLevel) {
                endLine = i;
                break;
            }
        }

        return { found: true, startLine, endLine, headerLevel, type: 'heading' };
    }

    findBlockBounds(content, blockId) {
        const notFound = { found: false, startLine: -1, endLine: -1, headerLevel: 0, type: 'block' };

        // Obsidian block ids are alphanumerics and dashes only.
        if (!/^[A-Za-z0-9-]+$/.test(blockId)) return notFound;

        const lines = content.split('\n');
        const fences = this.findFenceRanges(lines);
        const markerRegex = new RegExp(`(^|\\s)\\^${this.escapeRegExp(blockId)}\\s*$`);

        let markerLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (this.fenceAt(fences, i)) continue; // a '^id' inside a code block is not a block ref
            if (markerRegex.test(lines[i])) {
                markerLine = i;
                break;
            }
        }

        if (markerLine === -1) return notFound;

        let firstLine = markerLine;
        let lastLine = markerLine;

        if (/^\s*\^/.test(lines[markerLine])) {
            // The marker sits on its own line, so it labels the block just above it
            // (how Obsidian tags tables, code blocks and callouts).
            let i = markerLine - 1;
            while (i >= 0 && lines[i].trim() === '') i--;
            if (i < 0) return notFound;
            firstLine = i;
            lastLine = i;
        }

        const listMatch = lines[firstLine].match(/^(\s*)(?:[-*+]|\d+[.)])\s/);
        const fence = this.fenceAt(fences, lastLine);

        if (fence) {
            // The block is a fenced code block — take the whole fence.
            firstLine = fence.start;
            lastLine = fence.end;
        } else if (listMatch) {
            // A list item owns its nested children.
            const indent = listMatch[1].length;
            for (let i = lastLine + 1; i < lines.length; i++) {
                if (lines[i].trim() === '') break;
                if (lines[i].match(/^\s*/)[0].length <= indent) break;
                lastLine = i;
            }
        } else {
            // Paragraph, table or callout — walk up to the start of the chunk.
            while (firstLine > 0) {
                const prev = lines[firstLine - 1];
                if (prev.trim() === '') break;
                if (/^#{1,6}\s/.test(prev)) break;
                if (this.fenceAt(fences, firstLine - 1)) break;
                firstLine--;
            }
        }

        return {
            found: true,
            startLine: firstLine - 1,
            endLine: lastLine + 1,
            headerLevel: 0,
            type: 'block'
        };
    }

    findFenceRanges(lines) {
        const ranges = [];
        let open = null;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^\s*(```+|~~~+)/);
            if (!match) continue;

            const marker = match[1];
            if (!open) {
                open = { start: i, char: marker[0], length: marker.length };
            } else if (marker[0] === open.char && marker.length >= open.length) {
                ranges.push({ start: open.start, end: i });
                open = null;
            }
        }

        if (open) ranges.push({ start: open.start, end: lines.length - 1 });
        return ranges;
    }

    fenceAt(ranges, line) {
        return ranges.find(r => line >= r.start && line <= r.end) || null;
    }

    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    cleanupViewport(embedData) {
        if (embedData.viewportStyle) {
            embedData.viewportStyle.remove();
        }
        embedData.viewportActive = false;
    }
}

module.exports = ViewportController;