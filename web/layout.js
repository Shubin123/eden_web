/**
 * Eden Web — Widget layout (layout.js)
 * Every settings card in the controls panel is a widget on a grid. The grid
 * fits as many columns of at least the chosen widget width as there is room
 * for, and each widget can be moved, resized, collapsed and hidden:
 *
 *  - drag a widget by its title to move it (or use ↑/↓ in the layout menu);
 *  - drag its bottom-right corner to change how many columns it spans and
 *    how tall it is (double-click the corner to reset its size);
 *  - the title buttons collapse it, cycle its width, or hide it;
 *  - the hamburger menu lists every widget, sets the widget width and
 *    spacing, and resets everything to the default layout.
 *
 * The layout is kept in localStorage; the page works without it.
 */

(function () {
    'use strict';

    const grid = document.getElementById('widget-grid');
    const mainLayout = document.querySelector('.main-layout');
    if (!grid || !mainLayout) return;

    const STORAGE_KEY = 'eden-layout';
    const MAX_SPAN = 4;
    const MIN_HEIGHT = 80;
    const ROW_UNIT = 4;   // matches grid-auto-rows in style.css
    const DEFAULT_WIDGET_WIDTH = 260;
    const DEFAULT_GAP = 12;
    const $ = id => document.getElementById(id);

    const cards = new Map();
    for (const card of grid.querySelectorAll(':scope > .card[data-widget]')) {
        cards.set(card.dataset.widget, card);
    }
    const titles = new Map();

    function defaults() {
        const widgets = {};
        for (const [id, card] of cards) {
            widgets[id] = {
                span: Number.parseInt(card.dataset.defaultSpan || '1', 10),
                height: null,
                hidden: false,
                collapsed: false,
            };
        }
        return {
            widgetWidth: DEFAULT_WIDGET_WIDTH,
            gap: DEFAULT_GAP,
            beside: true,
            order: [...cards.keys()],
            widgets,
        };
    }

    // Merge what was stored over the defaults, so widgets added in a later
    // version appear (at the end) and removed ones are dropped.
    function load() {
        const state = defaults();
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}
        if (!stored || typeof stored !== 'object') return state;
        const clampNum = (v, lo, hi, fallback) =>
            (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
        state.widgetWidth = clampNum(stored.widgetWidth, 200, 480, state.widgetWidth);
        state.gap = clampNum(stored.gap, 4, 28, state.gap);
        if (typeof stored.beside === 'boolean') state.beside = stored.beside;
        if (Array.isArray(stored.order)) {
            const known = stored.order.filter(id => cards.has(id));
            state.order = [...new Set([...known, ...state.order])];
        }
        for (const id of cards.keys()) {
            const w = stored.widgets?.[id];
            if (!w) continue;
            const target = state.widgets[id];
            target.span = clampNum(w.span, 1, MAX_SPAN, target.span);
            target.height = Number.isFinite(w.height) ? Math.max(MIN_HEIGHT, w.height) : null;
            target.hidden = w.hidden === true;
            target.collapsed = w.collapsed === true;
        }
        return state;
    }

    let state = load();

    function save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    }

    // Column count follows the same rule as the CSS auto-fill track list.
    function metrics() {
        const width = grid.clientWidth;
        const colMin = Math.min(width, state.widgetWidth);
        const cols = Math.max(1, Math.floor((width + state.gap) / (colMin + state.gap)));
        const colWidth = (width - state.gap * (cols - 1)) / cols;
        return { cols, colWidth };
    }

    function applySpans() {
        const { cols } = metrics();
        for (const [id, card] of cards) {
            const span = Math.min(state.widgets[id].span, cols);
            card.style.gridColumn = span > 1 ? `span ${span}` : '';
        }
        for (const card of cards.values()) applyRows(card);
    }

    // Each widget covers enough 4px row units for its height plus the gap.
    function applyRows(card) {
        if (card.hidden) return;
        const height = card.getBoundingClientRect().height;
        card.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + state.gap) / ROW_UNIT))}`;
    }

    function applyCard(id) {
        const card = cards.get(id);
        const w = state.widgets[id];
        card.hidden = w.hidden;
        card.classList.toggle('is-collapsed', w.collapsed);
        card.classList.toggle('has-fixed-height', w.height != null);
        card.style.height = w.height != null ? `${w.height}px` : '';
        const collapse = card.querySelector('.widget-tool-collapse');
        if (collapse) {
            collapse.textContent = w.collapsed ? '▸' : '▾';
            collapse.setAttribute('aria-expanded', String(!w.collapsed));
            collapse.title = w.collapsed ? 'Expand' : 'Collapse';
        }
    }

    function apply() {
        grid.style.setProperty('--widget-w', `${state.widgetWidth}px`);
        grid.style.setProperty('--widget-gap', `${state.gap}px`);
        mainLayout.classList.toggle('widgets-below', !state.beside);
        for (const id of state.order) grid.appendChild(cards.get(id));
        for (const id of cards.keys()) applyCard(id);
        applySpans();
        syncMenu();
    }

    function update(id, patch) {
        Object.assign(state.widgets[id], patch);
        save();
        applyCard(id);
        applySpans();
        syncMenu();
    }

    function move(id, toIndex) {
        const order = state.order.filter(x => x !== id);
        order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, id);
        state.order = order;
        save();
        apply();
    }

    // ── Widget chrome: title, tool buttons, resize corner ──────────────
    function toolButton(cls, label, text, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `widget-tool ${cls}`;
        b.setAttribute('aria-label', label);
        b.title = label;
        b.textContent = text;
        b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
        return b;
    }

    for (const [id, card] of cards) {
        const h2 = card.querySelector(':scope > h2');
        if (!h2) continue;
        const title = document.createElement('span');
        title.className = 'widget-title';
        title.append(...h2.childNodes);
        h2.append(title);
        titles.set(id, title.textContent.trim());

        const tools = document.createElement('span');
        tools.className = 'widget-tools';
        tools.append(
            toolButton('widget-tool-collapse', 'Collapse', '▾',
                () => update(id, { collapsed: !state.widgets[id].collapsed })),
            toolButton('widget-tool-span', 'Change width', '⇔', () => {
                const { cols } = metrics();
                const limit = Math.min(MAX_SPAN, cols);
                const current = Math.min(state.widgets[id].span, limit);
                update(id, { span: current >= limit ? 1 : current + 1 });
            }),
            toolButton('widget-tool-hide', 'Hide (restore from the ☰ menu)', '✕',
                () => update(id, { hidden: true })),
        );
        h2.append(tools);

        const handle = document.createElement('div');
        handle.className = 'widget-resize';
        handle.title = 'Drag to resize, double-click to reset';
        card.append(handle);
        attachResize(id, card, handle);
        attachDrag(id, card, h2);
    }

    function attachResize(id, card, handle) {
        let start = null;
        handle.addEventListener('pointerdown', e => {
            e.preventDefault();
            const rect = card.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height, ...metrics() };
            handle.setPointerCapture(e.pointerId);
            card.classList.add('is-resizing');
        });
        handle.addEventListener('pointermove', e => {
            if (!start) return;
            const width = start.w + e.clientX - start.x;
            const step = start.colWidth + state.gap;
            const span = Math.max(1, Math.min(start.cols, MAX_SPAN,
                Math.round((width + state.gap) / step)));
            const height = Math.max(MIN_HEIGHT, Math.round((start.h + e.clientY - start.y) / 10) * 10);
            Object.assign(state.widgets[id], { span, height });
            applyCard(id);
            applySpans();
        });
        const end = () => {
            if (!start) return;
            start = null;
            card.classList.remove('is-resizing');
            save();
            syncMenu();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        handle.addEventListener('dblclick', () => {
            update(id, { span: Number.parseInt(card.dataset.defaultSpan || '1', 10), height: null });
        });
    }

    // Reordering by dragging the title. The card only becomes draggable
    // while the title is held, so text and controls inside stay selectable.
    let dragging = null;
    function attachDrag(id, card, h2) {
        h2.addEventListener('mousedown', e => {
            if (!e.target.closest('.widget-tools')) card.draggable = true;
        });
        card.addEventListener('dragstart', e => {
            if (!card.draggable) return;
            dragging = id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', id);
            card.classList.add('is-dragging');
        });
        card.addEventListener('dragend', () => {
            dragging = null;
            card.draggable = false;
            card.classList.remove('is-dragging');
            for (const c of cards.values()) c.classList.remove('is-drop-target');
        });
        card.addEventListener('dragover', e => {
            if (!dragging || dragging === id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            card.classList.add('is-drop-target');
        });
        card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'));
        card.addEventListener('drop', e => {
            if (!dragging || dragging === id) return;
            e.preventDefault();
            card.classList.remove('is-drop-target');
            // Dropping on the right/lower half places it after the target.
            const rect = card.getBoundingClientRect();
            const after = e.clientX > rect.left + rect.width / 2;
            const order = state.order.filter(x => x !== dragging);
            const index = order.indexOf(id) + (after ? 1 : 0);
            move(dragging, index);
        });
    }
    document.addEventListener('mouseup', () => {
        if (!dragging) for (const c of cards.values()) c.draggable = false;
    });

    new ResizeObserver(applySpans).observe(grid);
    // Content changes (a log line, an opened <details>) change a widget's
    // height; its row span follows.
    const cardObserver = new ResizeObserver(entries => {
        for (const entry of entries) applyRows(entry.target);
    });
    for (const card of cards.values()) cardObserver.observe(card);

    // ── Hamburger menu ─────────────────────────────────────────────────
    const menu = $('layout-menu');
    const backdrop = $('layout-menu-backdrop');
    const toggle = $('btn-layout-menu');
    const list = $('layout-widget-list');
    const widthInput = $('layout-widget-width');
    const gapInput = $('layout-gap');
    const besideInput = $('layout-beside-screen');

    function setMenuOpen(open) {
        if (!menu) return;
        menu.hidden = !open;
        if (backdrop) backdrop.hidden = !open;
        toggle?.setAttribute('aria-expanded', String(open));
        if (open) menu.querySelector('input, button')?.focus();
        else toggle?.focus();
    }

    function syncMenu() {
        if (!menu) return;
        if (widthInput) {
            widthInput.value = state.widgetWidth;
            $('layout-widget-width-value').textContent = `${state.widgetWidth}px`;
        }
        if (gapInput) {
            gapInput.value = state.gap;
            $('layout-gap-value').textContent = `${state.gap}px`;
        }
        if (besideInput) besideInput.checked = state.beside;
        if (!list) return;
        list.replaceChildren(...state.order.map((id, index) => {
            const w = state.widgets[id];
            const li = document.createElement('li');
            li.dataset.widgetId = id;
            li.classList.toggle('is-hidden', w.hidden);

            const visible = document.createElement('input');
            visible.type = 'checkbox';
            visible.checked = !w.hidden;
            visible.setAttribute('aria-label', `Show ${titles.get(id)}`);
            visible.addEventListener('change', () => update(id, { hidden: !visible.checked }));

            const name = document.createElement('span');
            name.className = 'layout-widget-name';
            name.textContent = titles.get(id);

            const actions = document.createElement('span');
            actions.className = 'layout-widget-actions';
            const span = document.createElement('select');
            span.setAttribute('aria-label', `${titles.get(id)} width`);
            for (let n = 1; n <= MAX_SPAN; n++) span.add(new Option(`${n} col`, String(n)));
            span.value = String(w.span);
            span.addEventListener('change', () => update(id, { span: Number(span.value) }));
            const up = toolButton('', `Move ${titles.get(id)} up`, '↑', () => move(id, index - 1));
            const down = toolButton('', `Move ${titles.get(id)} down`, '↓', () => move(id, index + 1));
            up.disabled = index === 0;
            down.disabled = index === state.order.length - 1;
            actions.append(span, up, down);

            li.append(visible, name, actions);
            return li;
        }));
    }

    // ── Settings guide: which widget holds which setting ───────────────
    // Built from each card's data-settings text. "Open" shows the widget
    // (even if hidden or collapsed), scrolls to it and flashes it.
    function reveal(id) {
        const card = cards.get(id);
        if (state.widgets[id].hidden || state.widgets[id].collapsed) {
            update(id, { hidden: false, collapsed: false });
        }
        setMenuOpen(false);
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('is-flashing');
        void card.offsetWidth;
        card.classList.add('is-flashing');
    }

    const guide = $('layout-settings-guide');
    if (guide) {
        guide.replaceChildren(...[...cards].filter(([, card]) => card.dataset.settings).map(([id, card]) => {
            const li = document.createElement('li');
            const text = document.createElement('span');
            const name = document.createElement('strong');
            name.textContent = titles.get(id);
            text.append(name, ` — ${card.dataset.settings}`);
            li.append(text, toolButton('layout-guide-open', `Open ${titles.get(id)}`, '→', () => reveal(id)));
            return li;
        }));
    }

    function reset() {
        state = defaults();
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        apply();
    }

    toggle?.addEventListener('click', () => setMenuOpen(menu.hidden));
    $('btn-layout-menu-close')?.addEventListener('click', () => setMenuOpen(false));
    backdrop?.addEventListener('click', () => setMenuOpen(false));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && menu && !menu.hidden) setMenuOpen(false);
    });
    widthInput?.addEventListener('input', () => {
        state.widgetWidth = Number(widthInput.value);
        save();
        apply();
    });
    gapInput?.addEventListener('input', () => {
        state.gap = Number(gapInput.value);
        save();
        apply();
    });
    besideInput?.addEventListener('change', () => {
        state.beside = besideInput.checked;
        save();
        apply();
    });
    $('btn-layout-reset')?.addEventListener('click', reset);

    apply();

    window.EdenLayout = {
        reset,
        getState: () => JSON.parse(JSON.stringify(state)),
        columns: () => metrics().cols,
        setMenuOpen,
        reveal,
    };
})();
