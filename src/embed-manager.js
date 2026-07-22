const { Component, WorkspaceLeaf, MarkdownView, setIcon } = require('obsidian');
const ViewportController = require('./viewport-controller');
const DynamicPaths = require('./dynamic-paths');

// How deep sync embeds may nest inside one another before we stop.
const MAX_EMBED_DEPTH = 4;

class EmbedManager {
    constructor(plugin) {
        this.plugin = plugin;
        this.embedRegistry = new WeakMap();
        this.activeEmbeds = new Set();
        this.viewportController = new ViewportController(plugin);
        this.dynamicPaths = new DynamicPaths(plugin);
    }

    cleanup() {
        this.activeEmbeds.forEach(embedData => {
            if (embedData.component) embedData.component.unload();
            if (embedData.leaf) embedData.leaf.detach();
        });
        this.activeEmbeds.clear();
        if (this.dynamicPaths) this.dynamicPaths.cleanup();
    }

    getEmbedFromElement(element) {
        if (!element) return null;
        let current = element;
        while (current && current !== document.body) {
            if (current.classList && current.classList.contains('sync-embed')) {
                const embedData = this.embedRegistry.get(current);
                if (embedData) return embedData;
            }
            current = current.parentElement;
        }
        return null;
    }

    async processSyncBlock(source, el, ctx) {
        el.empty();
        const syncContainer = el.createDiv('sync-container');

        syncContainer.style.setProperty('--sync-embed-height', this.plugin.settings.embedHeight);
        syncContainer.style.setProperty('--sync-max-height', this.plugin.settings.maxEmbedHeight);
        syncContainer.style.setProperty('--sync-gap', this.plugin.settings.gapBetweenEmbeds);

        const embedLines = source.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('![[') && line.endsWith(']]'));

        if (embedLines.length === 0) {
            syncContainer.createDiv('sync-empty').setText('No embeds found in sync block');
            return;
        }

        const parsedEmbeds = embedLines.map(line => this.parseEmbedOptions(line));

        // {seamless:true} and {box:false} strip chrome from the block as a whole, so
        // they only take effect when every embed in the block asks for it — one embed
        // cannot remove a border it shares with its siblings.
        if (parsedEmbeds.every(({ options }) => options.seamless === true)) {
            syncContainer.addClass('sync-seamless');
        } else if (parsedEmbeds.every(({ options }) => options.box === false)) {
            syncContainer.addClass('sync-no-box');
        }

        const estimatedHeight = embedLines.length * 200;
        syncContainer.style.minHeight = `${estimatedHeight}px`;

        // Where this sync block itself sits in its own note, so a same-note embed can
        // tell whether it would be transcluding the block that renders it.
        const selfInfo = ctx.getSectionInfo ? ctx.getSectionInfo(el) : null;
        // Which embeds we are already nested inside, to stop cycles across notes.
        const chain = this.readEmbedChain(el);

        for (let i = 0; i < parsedEmbeds.length; i++) {
            await this.processEmbed(parsedEmbeds[i], syncContainer, ctx, i > 0, selfInfo, chain);
        }

        setTimeout(() => { syncContainer.style.minHeight = ''; }, 100);
    }

    parseEmbedOptions(line) {
        const optionsMatch = line.match(/\{([^}]+)\}\]\]$/);
        const options = {};
        if (optionsMatch) {
            const pairs = optionsMatch[1].split(',');
            pairs.forEach(pair => {
                // Split on the FIRST colon only: values are free text and may contain
                // their own, e.g. {marker:1.} or a time format.
                const separator = pair.indexOf(':');
                if (separator === -1) return;

                const key = pair.slice(0, separator).trim();
                const value = pair.slice(separator + 1).trim();
                if (!key) return;

                if (value === 'true') options[key] = true;
                else if (value === 'false') options[key] = false;
                else options[key] = value;
            });
            line = line.replace(/\{[^}]+\}\]\]$/, ']]');
        }
        return { line, options };
    }

    /**
     * Turn an option value into a CSS string literal for a `content:` property.
     */
    cssStringLiteral(value) {
        return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    /**
     * {marker:...} restyles the list bullet/number of an embedded list item — useful
     * when a block embed of one item should read as part of a list in the host note.
     *
     *   {marker:false} / {marker:none}  strip the marker, put nothing back
     *   {marker:-} / {marker:bullet}    replace it with a native-looking dot
     *   {marker:1.} (any other text)    replace it with that literal text
     *
     * Every replacement also hides the source marker, otherwise the original and the
     * replacement both render.
     */
    applyMarkerOptions(embedContainer, options) {
        const marker = options.marker;

        if (marker !== undefined && marker !== true) {
            if (marker === false || marker === 'none') {
                embedContainer.addClass('sync-hide-marker');
            } else if (marker === 'bullet' || ['-', '*', '+'].includes(marker)) {
                embedContainer.addClass('sync-hide-marker', 'sync-marker-bullet');
            } else {
                embedContainer.addClass('sync-hide-marker', 'sync-marker-text');
                // The trailing space reproduces the gap baked into a literal "1. ".
                embedContainer.style.setProperty(
                    '--sync-marker-text',
                    this.cssStringLiteral(`${marker} `)
                );
            }
        }

        // {indent:2em} pushes the marker (and the text hanging off it) further in.
        if (options.indent) {
            embedContainer.style.setProperty('--sync-marker-indent', options.indent);
        }
    }

    /**
     * The list of `path#target` keys of the embeds this element is rendered inside.
     * The chain is stamped onto each embedded view's container, which is an ancestor
     * of anything that view renders — including a nested sync block.
     */
    readEmbedChain(el) {
        const host = el.closest?.('[data-sync-embed-chain]');
        if (!host) return [];
        try {
            return JSON.parse(host.dataset.syncEmbedChain) || [];
        } catch {
            return [];
        }
    }

    /**
     * Embedding a note into itself is only safe when the embed targets a section or
     * block that does not contain the sync block doing the embedding. Returns an
     * error message when the embed must be refused, or null when it is allowed.
     */
    checkSameNoteEmbed(section, selfInfo) {
        if (!section) {
            return 'Cannot embed a note inside itself. Link to a section or block instead.';
        }

        if (!selfInfo) {
            // Without knowing where this sync block sits we cannot rule out a cycle.
            return 'Cannot create a recursive embed of the same note.';
        }

        const bounds = this.viewportController.findTargetBounds(selfInfo.text, section);
        if (!bounds.found) {
            return `${section.startsWith('^') ? 'Block' : 'Section'} not found: ${section}`;
        }

        // The editable region is startLine + 1 .. endLine - 1.
        const overlaps = selfInfo.lineEnd >= bounds.startLine + 1 && selfInfo.lineStart <= bounds.endLine - 1;
        if (overlaps) {
            return 'Cannot create a recursive embed: this sync block is inside the target section.';
        }

        return null;
    }

    async processEmbed(parsedEmbed, container, ctx, addGap, selfInfo = null, chain = []) {
        try {
            const { line: cleanedLine, options } = parsedEmbed;
            const match = cleanedLine.match(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
            if (!match) return;

            let linkText = match[1];
            let displayAlias = match[2]?.trim();
            const hasDynamicPattern = /\{\{(date|time|title)/.test(linkText);

            if (hasDynamicPattern) {
                const cacheKey = `${linkText}-${ctx.sourcePath}`;
                const cached = this.dynamicPaths.pathCache.get(cacheKey);
                const now = Date.now();
                let resolvedText;
                
                if (cached && (now - cached.timestamp < 1000)) {
                    resolvedText = cached.value;
                } else {
                    resolvedText = this.dynamicPaths.resolve(linkText, ctx);
                    this.dynamicPaths.pathCache.set(cacheKey, { value: resolvedText, timestamp: now });
                }

                if (!displayAlias) displayAlias = linkText;
                linkText = resolvedText;
            }

            const linkPath = linkText.split('|')[0].trim();
            let notePath = linkPath.split('#')[0];
            const section = linkPath.includes('#') ? linkPath.substring(linkPath.indexOf('#') + 1) : null;

            if (!notePath) notePath = ctx.sourcePath;

            const file = this.plugin.app.metadataCache.getFirstLinkpathDest(notePath, ctx.sourcePath);
            if (!file) {
                this.renderError(container, `Note not found: ${notePath}`, addGap);
                return;
            }

            const embedKey = `${file.path}#${section || ''}`;

            if (chain.includes(embedKey)) {
                this.renderError(container, 'Cannot create a recursive embed: this embed is already open further up.', addGap);
                return;
            }

            if (chain.length >= MAX_EMBED_DEPTH) {
                this.renderError(container, `Embed nesting limit reached (${MAX_EMBED_DEPTH}).`, addGap);
                return;
            }

            if (file.path === ctx.sourcePath) {
                const reason = this.checkSameNoteEmbed(section, selfInfo);
                if (reason) {
                    this.renderError(container, reason, addGap);
                    return;
                }
            }

            const embedContainer = container.createDiv('sync-embed');
            if (addGap) embedContainer.addClass('sync-embed-gap');
            embedContainer.addClass('sync-embed-loading');
            if (options.seamless === true) embedContainer.addClass('sync-seamless');
            this.applyMarkerOptions(embedContainer, options);

            if (Object.keys(options).length > 0) {
                embedContainer.dataset.customOptions = JSON.stringify(options);
            }

            const placeholderText = displayAlias || `${file.basename}${section ? '#' + section : ''}`;
            const placeholder = embedContainer.createDiv('sync-embed-placeholder');
            placeholder.setText(`Loading ${placeholderText}...`);

            const renderAsCallout = options.callout !== undefined ? options.callout : this.plugin.settings.renderAsCallout;
            if (renderAsCallout) embedContainer.addClass('is-callout-style');

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        observer.disconnect();
                        requestAnimationFrame(() => {
                            this.loadEmbed(embedContainer, file, section, displayAlias, ctx, placeholder, options, [...chain, embedKey]);
                        });
                    }
                });
            }, {
                rootMargin: this.plugin.settings.lazyLoadThreshold,
                threshold: 0.01 
            });

            observer.observe(embedContainer);

        } catch (error) {
            console.error('Sync Embeds: Error processing embed:', error);
            this.renderError(container, `Error loading: ${error.message}`, addGap);
        }
    }

    async loadEmbed(embedContainer, file, section, alias, ctx, placeholder, customOptions = {}, chain = []) {
        try {
            const component = new Component();
            const leaf = new WorkspaceLeaf(this.plugin.app);
            component.load();

            const embedData = {
                containerEl: embedContainer,
                file,
                section,
                alias,
                component,
                leaf,
                customOptions,
                sourcePath: ctx.sourcePath
            };

            component.addChild(new (class extends Component {
                constructor(manager, data) {
                    super();
                    this.manager = manager;
                    this.embedData = data;
                }
                async onunload() {
                    this.manager.activeEmbeds.delete(this.embedData);
                    if (this.manager.plugin.currentFocusedEmbed?.containerEl === this.embedData.containerEl) {
                        this.manager.plugin.currentFocusedEmbed = null;
                    }
                    if (this.embedData.leaf) this.embedData.leaf.detach();
                }
            })(this, embedData));

            // Stamp the chain on the leaf BEFORE opening the file: the view renders its
            // content — including any nested sync blocks — during openFile, and those
            // need to be able to see which embeds they are already inside.
            const chainJSON = JSON.stringify(chain);
            if (leaf.containerEl) leaf.containerEl.dataset.syncEmbedChain = chainJSON;

            await leaf.openFile(file, { state: { mode: 'source' } });
            const view = leaf.view;

            if (!(view instanceof MarkdownView)) {
                this.renderError(embedContainer.parentElement, 'Failed to load a markdown view.', false);
                leaf.detach();
                return;
            }

            embedData.view = view;
            embedData.editor = view.editor;

            // Re-stamp on the view itself, since it gets re-parented out of the leaf
            // and into the page below.
            view.containerEl.dataset.syncEmbedChain = chainJSON;

            this.embedRegistry.set(embedContainer, embedData);
            this.activeEmbeds.add(embedData);

            if (customOptions.height) embedContainer.style.setProperty('--sync-embed-height', customOptions.height);
            if (customOptions.maxHeight) embedContainer.style.setProperty('--sync-max-height', customOptions.maxHeight);
            if (customOptions.collapse === true) embedContainer.addClass('is-collapsed');

            const renderAsCallout = customOptions.callout !== undefined ? customOptions.callout : this.plugin.settings.renderAsCallout;
            const headerTitle = alias || (section ? `${file.basename} > ${section}` : file.basename);

            if (section) {
                const content = view.editor.getValue();
                const sectionInfo = this.viewportController.findTargetBounds(content, section);

                if (!sectionInfo.found) {
                    embedContainer.empty();
                    embedContainer.removeClass('sync-embed-loading');
                    embedContainer.style.height = 'auto';
                    embedContainer.style.minHeight = '0';
                    const label = section.startsWith('^') ? 'Block' : 'Section';
                    this.renderError(embedContainer, `${label} not found: ${section}`, false);
                    leaf.detach();
                    return;
                }

                await this.viewportController.setupSectionViewport(embedData);
            }

            // UNIFIED HEADER/TITLE LOGIC
            // A seamless embed is meant to read as if the text were typed into the host
            // note, so it defaults to no title — {title:true} still forces one back on.
            const defaultTitle = customOptions.seamless === true ? false : this.plugin.settings.showInlineTitle;
            const userWantsTitle = customOptions.title !== undefined ? customOptions.title : defaultTitle;
            
            // Callouts ALWAYS generate a header (for folding). Normal embeds respect settings.
            if (renderAsCallout || userWantsTitle) {
                this.setupHeaderUI(embedData, headerTitle, renderAsCallout, !!section);
            }

            // PROPERTIES LOGIC
            if (section) {
                this.hideProperties(embedData); // Sections shouldn't have properties
            } else if (this.plugin.settings.collapsePropertiesByDefault) {
                this.setupPropertiesCollapse(embedData); // Whole notes conditionally collapse natively
            }

            placeholder.replaceWith(view.containerEl);
            embedContainer.removeClass('sync-embed-loading');
            ctx.addChild(component);

            // The section viewport CSS was measured while this editor was still detached,
            // so CodeMirror had only rendered the top of the document. Now that the view
            // is on the page and CM can lay out every line, re-measure — otherwise any
            // section below the initial render window stays hidden (renders blank).
            if (section && embedData.viewportActive) {
                this.viewportController.remeasureViewport(embedData);
            }

        } catch (error) {
            console.error('Sync Embeds: Error loading embed:', error);
            placeholder.setText(`Error: ${error.message}`);
            placeholder.addClass('sync-embed-error');
        }
    }

    setupHeaderUI(embedData, displayTitle, renderAsCallout, isSection) {
        const { view, file, section, containerEl } = embedData;

        requestAnimationFrame(() => {
            setTimeout(() => {
                // Completely kill the native title to prevent duplication
                const titleEl = view.containerEl.querySelector('.inline-title');
                if (titleEl) titleEl.style.display = 'none';

                const viewContent = view.containerEl.querySelector('.view-content');
                if (!viewContent) return;
                if (view.containerEl.querySelector('.sync-embed-header')) return; // Prevent dupes

                const headerUI = document.createElement('div');
                headerUI.className = 'sync-embed-header';

                if (renderAsCallout) {
                    headerUI.classList.add('is-sticky');
                    
                    const foldBtn = headerUI.createDiv('sync-embed-fold');
                    setIcon(foldBtn, 'chevron-down');
                    
                    const linkPath = section ? `${file.path}#${section}` : file.path;
                    headerUI.createEl('a', {
                        cls: 'internal-link',
                        text: displayTitle,
                        attr: { 'href': linkPath, 'data-href': linkPath }
                    });

                    headerUI.addEventListener('click', (e) => {
                        if (e.target.closest('a')) return;
                        e.stopPropagation();
                        e.preventDefault();
                        containerEl.classList.toggle('is-collapsed');
                    });
                    
                    // Callout headers sit ABOVE the content to stick perfectly
                    view.containerEl.insertBefore(headerUI, viewContent);
                } else {
                    // Standard inline alias header sits inside the content
                    headerUI.textContent = displayTitle;
                    viewContent.insertBefore(headerUI, viewContent.firstChild);
                }
            }, 100);
        });
    }

    hideProperties(embedData) {
        const { view } = embedData;
        requestAnimationFrame(() => {
            setTimeout(() => {
                const propertiesEl = view.containerEl.querySelector('.metadata-container');
                if (propertiesEl) {
                    propertiesEl.style.display = 'none';
                }
            }, 50);
        });
    }

    setupPropertiesCollapse(embedData) {
        const { view } = embedData;
        requestAnimationFrame(() => {
            setTimeout(() => {
                const propertiesEl = view.containerEl.querySelector('.metadata-container');
                if (!propertiesEl) return;

                // Fire a real click event on the heading so Obsidian natively updates its internal state
                const heading = propertiesEl.querySelector('.metadata-properties-heading');
                if (heading && !propertiesEl.classList.contains('is-collapsed')) {
                    heading.click(); 
                }
            }, 100);
        });
    }

    renderError(container, message, addGap) {
        const errorDiv = container.createDiv('sync-embed-error');
        if (addGap) errorDiv.addClass('sync-embed-gap');
        errorDiv.setText(message);
    }
}

module.exports = EmbedManager;