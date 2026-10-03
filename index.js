/**
 * World Modulator —— SillyTavern 扩展入口
 *
 * 功能：
 *   1. 读写「世界状态 / 世界规则 / 角色档案 / 衣柜」，全局与当前卡双作用域
 *   2. 调用分析模型，每轮自动解析正文中的状态变化
 *   3. 把上述内容按开关逐项注入主模型提示词
 *   4. 悬浮球 + 主面板界面
 *
 * 模块划分：
 *   scripts/prompts.js  内置提示词与档案模板
 *   scripts/state.js    状态与存储
 *   scripts/api.js      API 调用
 *   scripts/tools.js    结果应用
 *   scripts/inject.js   提示词注入
 *   scripts/tracker.js  追踪管道
 */

import {
    MODULE_NAME,
    PROFILE_MODES,
    SCOPES,
    PROFILE_GROUPS,
    WORLD_STATE_FIELDS,
    DEFAULT_MODULATOR_INJECTION,
    getProfileFields,
} from './scripts/prompts.js';
import {
    DEFAULT_SETTINGS,
    createEmptyCharacter,
    addRuleDraft,
    addWardrobeEntry,
    clearRetiredRules,
    clearRuleDrafts,
    copyCharacterToCurrentChat,
    copyRuleToCurrentChat,
    copyWardrobeToCurrentChat,
    dropChatData,
    formatRuleDrafts,
    getChatData,
    getChatKey,
    getContextSafe,
    getMergedCharacters,
    getMergedRules,
    getPresetPromptOverrides,
    getRetiredRuleNames,
    getRuleDrafts,
    getSettings,
    getWardrobeEntries,
    listSiblingChatData,
    normalizeApiProfiles,
    removeCharacter,
    removeRule,
    removeRuleDraft,
    removeWardrobeEntry,
    reviveRule,
    applyApiProfile,
    clearPresetPromptOverrides,
    deleteApiProfile,
    saveApiProfile,
    saveSettings,
    saveSettingsNow,
    setPresetPromptOverride,
    setRule,
    updateRuleDraft,
    updateWardrobeEntry,
    upsertCharacter,
} from './scripts/state.js';
import {
    callAnalyzer,
    fetchModelList,
    getDebugInfo,
    getPresetPrompts,
    isMainConnectionAvailable,
    listPresets,
    resolveConnection,
} from './scripts/api.js';
import { applyInjection, clearInjection, getInjectedKeys } from './scripts/inject.js';
import { getRunState, isPolling, poll, resetSettle, runTracker, startPolling, stopPolling } from './scripts/tracker.js';

const ORB_ID = 'wm-floating-orb';
const PANEL_ID = 'wm-panel';
/**
 * 模板路径必须由当前模块 URL 推导，不能硬编码目录名——
 * 扩展目录可能被改名（含中文名），硬编码会 404。
 */
const TEMPLATE_URL = new URL('./template.html', import.meta.url).href;
const POSITION_KEY = `${MODULE_NAME}_orb_position`;

// ─────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────

function $(selector, root = document) {
    return root.querySelector(selector);
}

function $$(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(message, type = 'info') {
    try {
        const fn = globalThis.toastr?.[type] || globalThis.toastr?.info;
        fn?.(String(message), 'World Modulator');
    } catch { /* ignore */ }
}

function confirmDialog(message) {
    try {
        return globalThis.confirm?.(message) ?? true;
    } catch {
        return true;
    }
}

function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

/** 取用户名（注入 {{user}} 替换） */
function getUserName(ctx) {
    try {
        return String(ctx?.name1 || '').trim() || 'user';
    } catch {
        return 'user';
    }
}

/** 把提示词里的 {{user}} 替换为实际用户名 */
function substituteUser(text, ctx) {
    return String(text || '').replace(/\{\{user\}\}/gi, getUserName(ctx));
}

// ─────────────────────────────────────────────
// 视图状态
// ─────────────────────────────────────────────

const uiState = {
    activeTab: 'world',
    ruleSearch: '',
    charSearch: '',
    ready: false,
    domBound: false,
};

/** 魔杖菜单项 id */
const MENU_ITEM_ID = 'wm-menu-item';
/** 启动重试计数（宿主 context 与 #extensionsMenu 都可能晚于脚本来） */
const BOOT_RETRY_MAX = 60;
const BOOT_RETRY_DELAY_MS = 500;

let modalOverlay = null;

// ─────────────────────────────────────────────
// 弹窗
// ─────────────────────────────────────────────

/**
 * 打开一个通用输入弹窗。
 * @param {{title:string, fields:Array<{key:string,label:string,type:'text'|'textarea'|'scope',value?:string,placeholder?:string}>}} config
 * @returns {Promise<Record<string,string>|null>}
 */
function openModal(config) {
    return new Promise((resolve) => {
        closeModal();
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return resolve(null);

        modalOverlay = el('div', 'wm-modal-overlay');
        const box = el('div', 'wm-modal-box');
        box.appendChild(el('h3', 'wm-modal-title', config.title || ''));

        const body = el('div', 'wm-modal-body');
        const inputs = {};

        for (const field of config.fields || []) {
            body.appendChild(el('div', 'wm-modal-label', field.label || ''));

            if (field.type === 'scope') {
                const group = el('div', 'wm-scope-group');
                let current = field.value || SCOPES.LOCAL;
                for (const [value, label] of [[SCOPES.LOCAL, '仅当前卡'], [SCOPES.GLOBAL, '全局通用']]) {
                    const btn = el('button', 'wm-scope-btn', label);
                    btn.type = 'button';
                    if (value === current) btn.classList.add('wm-active');
                    btn.addEventListener('click', () => {
                        current = value;
                        $$('.wm-scope-btn', group).forEach((b) => b.classList.remove('wm-active'));
                        btn.classList.add('wm-active');
                    });
                    group.appendChild(btn);
                }
                inputs[field.key] = { get value() { return current; } };
                body.appendChild(group);
                continue;
            }

            const input = field.type === 'textarea'
                ? el('textarea', 'wm-modal-textarea')
                : el('input', 'wm-modal-input');
            if (field.type !== 'textarea') input.type = 'text';
            input.value = field.value || '';
            if (field.placeholder) input.placeholder = field.placeholder;
            inputs[field.key] = input;
            body.appendChild(input);
        }

        box.appendChild(body);

        const footer = el('div', 'wm-modal-footer');
        const cancel = el('button', 'wm-btn', '取消');
        cancel.type = 'button';
        const ok = el('button', 'wm-btn wm-btn-green', '确定');
        ok.type = 'button';

        cancel.addEventListener('click', () => {
            closeModal();
            resolve(null);
        });
        ok.addEventListener('click', () => {
            const result = {};
            for (const [key, input] of Object.entries(inputs)) {
                result[key] = input.value;
            }
            closeModal();
            resolve(result);
        });

        footer.append(cancel, ok);
        box.appendChild(footer);
        modalOverlay.appendChild(box);
        modalOverlay.addEventListener('click', (event) => {
            if (event.target === modalOverlay) {
                closeModal();
                resolve(null);
            }
        });
        panel.appendChild(modalOverlay);

        const firstInput = box.querySelector('input, textarea');
        firstInput?.focus?.();
    });
}

function closeModal() {
    modalOverlay?.remove();
    modalOverlay = null;
}

// ─────────────────────────────────────────────
// 渲染：顶部状态
// ─────────────────────────────────────────────

function renderHeader(ctx) {
    const settings = getSettings(ctx);
    if (!settings) return;
    const chatData = getChatData(ctx, settings);

    const time = $('#wm-status-time');
    const place = $('#wm-status-place');
    const weather = $('#wm-status-weather');
    if (time) time.textContent = chatData.worldState.当前时间 || '时间未设定';
    if (place) place.textContent = chatData.worldState.当前位置 || '位置未设定';
    if (weather) weather.textContent = chatData.worldState.当前天气 || '天气未设定';

    const toggle = $('#wm-toggle-enabled');
    if (toggle) toggle.checked = settings.enabled === true;

    const label = $('#wm-status-analyze');
    if (label) {
        const running = getRunState().running;
        label.textContent = running ? '分析中' : (settings.enabled ? '自动' : '手动');
        label.classList.toggle('wm-active', settings.enabled === true || running);
    }

    const orb = document.getElementById(ORB_ID);
    orb?.classList.toggle('wm-busy', getRunState().running);
}

// ─────────────────────────────────────────────
// 渲染：世界状态
// ─────────────────────────────────────────────

const WORLD_ICONS = {
    当前时间: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    当前位置: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    当前天气: '<path d="M6 14a4 4 0 0 1 1-7.9 5 5 0 0 1 9.6 1.2A3.5 3.5 0 0 1 17 14z"/>',
};

function renderWorld(ctx) {
    const settings = getSettings(ctx);
    const chatData = getChatData(ctx, settings);
    const grid = $('#wm-world-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (const field of WORLD_STATE_FIELDS) {
        const row = el('div', 'wm-world-row');
        const iconWrap = el('div', 'wm-world-icon');
        iconWrap.innerHTML = `<svg class="wm-svg-icon" viewBox="0 0 24 24">${WORLD_ICONS[field.key] || ''}</svg>`;
        const body = el('div', 'wm-world-body');
        const input = el('input', 'wm-input');
        input.dataset.worldField = field.key;
        input.placeholder = field.hint ? `${field.label}（${field.hint}）` : field.label;
        input.value = chatData.worldState[field.key] || '';
        input.style.width = '100%';
        body.appendChild(input);
        row.append(iconWrap, body);
        grid.appendChild(row);
    }

    const summary = $('#wm-world-summary');
    if (summary) {
        const meta = chatData.meta || {};
        const parts = [];
        if (meta.lastSummary) parts.push(meta.lastSummary);
        if (meta.lastRunAt) parts.push(`上次分析：${new Date(meta.lastRunAt).toLocaleString('zh-CN')}`);
        summary.textContent = parts.length ? parts.join('\n') : '尚无分析记录。';
    }
}

// ─────────────────────────────────────────────
// 渲染：规则
// ─────────────────────────────────────────────

function renderRules(ctx) {
    const settings = getSettings(ctx);
    const list = $('#wm-rule-list');
    if (!list) return;
    const rules = getMergedRules(ctx, settings);
    const keyword = uiState.ruleSearch.trim().toLowerCase();
    list.innerHTML = '';

    const entries = Object.entries(rules)
        .filter(([name, rule]) => {
            if (!keyword) return true;
            return name.toLowerCase().includes(keyword)
                || String(rule.description || '').toLowerCase().includes(keyword);
        })
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'));

    if (entries.length === 0) {
        list.appendChild(buildEmptyState(keyword ? '没有匹配的规则' : '还没有规则。点击「新增规则」或从推荐规则采纳。'));
        return;
    }

    for (const [name, rule] of entries) {
        const item = el('div', 'wm-list-item');
        const content = el('div', 'wm-item-content');

        const title = el('div', 'wm-item-title', name);
        const scopeTag = el('span', 'wm-tag-scope', rule.scope === SCOPES.GLOBAL ? '全局' : '当前卡');
        scopeTag.style.marginLeft = '8px';
        scopeTag.style.fontWeight = 'normal';
        title.appendChild(scopeTag);

        content.appendChild(title);
        content.appendChild(el('div', 'wm-item-desc', rule.description || '（无描述）'));

        const actions = el('div', 'wm-item-actions');
        const editBtn = el('button', 'wm-btn-icon wm-no-spin', '✎');
        editBtn.title = '编辑';
        editBtn.addEventListener('click', () => onEditRule(ctx, name, rule));

        const toggleBtn = el('button', 'wm-btn-icon wm-no-spin', rule.enabled === false ? '○' : '●');
        toggleBtn.title = rule.enabled === false ? '已停用（点击启用）' : '已启用（点击停用）';
        toggleBtn.style.color = rule.enabled === false ? '#64748b' : '#00ff9d';
        toggleBtn.addEventListener('click', () => onToggleRule(ctx, name, rule));

        const delBtn = el('button', 'wm-item-delete', '✕');
        delBtn.title = '删除';
        delBtn.addEventListener('click', () => onDeleteRule(ctx, name));

        actions.append(editBtn, toggleBtn, delBtn);
        item.append(content, actions);
        list.appendChild(item);
    }

    renderRuleDrafts(ctx);
    renderRetiredRules(ctx);
}

/** 渲染规则待办草稿 */
function renderRuleDrafts(ctx) {
    const container = $('#wm-draft-list');
    if (!container) return;
    const drafts = getRuleDrafts(ctx);
    container.innerHTML = '';

    if (drafts.length === 0) {
        container.appendChild(el('div', 'wm-item-desc', '待办为空。在上方输入框写下想要的大致规则，点「加入待办」。'));
        return;
    }

    for (const draft of drafts) {
        const item = el('div', 'wm-draft-item');
        const text = el('div', 'wm-draft-text', draft.text);
        text.title = draft.text;
        text.addEventListener('click', () => onEditRuleDraft(ctx, draft));

        const del = el('button', 'wm-item-delete', '✕');
        del.title = '删除这条待办';
        del.addEventListener('click', () => {
            removeRuleDraft(ctx, draft.id);
            renderRuleDrafts(ctx);
        });

        item.append(text, del);
        container.appendChild(item);
    }
}

/** 渲染已失效规则 */
function renderRetiredRules(ctx) {
    const group = $('#wm-retired-group');
    const list = $('#wm-retired-list');
    if (!group || !list) return;
    const names = getRetiredRuleNames(ctx);
    if (names.length === 0) {
        group.style.display = 'none';
        list.innerHTML = '';
        return;
    }
    group.style.display = '';
    list.innerHTML = '';
    for (const name of names) {
        const item = el('div', 'wm-list-item');
        const content = el('div', 'wm-item-content');
        content.appendChild(el('div', 'wm-item-title', name));
        content.appendChild(el('div', 'wm-item-desc', '该规则已被删除或停用，注入时会告知主模型它不再生效。'));

        const actions = el('div', 'wm-item-actions');
        const revive = el('button', 'wm-btn-icon wm-no-spin', '↺');
        revive.title = '从失效名单移除';
        revive.addEventListener('click', () => {
            reviveRule(ctx, name);
            renderRules(ctx);
            applyInjection(ctx);
        });
        actions.appendChild(revive);
        item.append(content, actions);
        list.appendChild(item);
    }
}

function buildEmptyState(text) {
    const wrap = el('div', 'wm-empty');
    wrap.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>`;
    wrap.appendChild(el('div', null, text));
    return wrap;
}

// ─────────────────────────────────────────────
// 渲染：推荐规则
// ─────────────────────────────────────────────

function renderRecommend(ctx) {
    const settings = getSettings(ctx);
    const chatData = getChatData(ctx, settings);
    const list = $('#wm-recommend-list');
    const badge = $('#wm-badge-recommend');
    if (!list) return;

    const entries = Object.entries(chatData.recommendedRules || {});
    if (badge) {
        badge.textContent = String(entries.length);
        badge.style.display = entries.length > 0 ? 'inline-block' : 'none';
    }

    list.innerHTML = '';
    if (entries.length === 0) {
        list.appendChild(buildEmptyState('暂无推荐规则。开启「推荐规则」追踪后，每轮分析会生成 6 条。'));
        return;
    }

    for (const [name, rule] of entries) {
        const item = el('div', 'wm-list-item wm-recommend-item');
        const content = el('div', 'wm-item-content');
        content.appendChild(el('div', 'wm-item-title', name));
        content.appendChild(el('div', 'wm-item-desc', rule.description || ''));

        const actions = el('div', 'wm-item-actions');
        const adoptLocal = el('button', 'wm-btn wm-btn-green', '采纳');
        adoptLocal.style.fontSize = '11px';
        adoptLocal.style.padding = '5px 12px';
        adoptLocal.title = '加入当前卡规则';
        adoptLocal.addEventListener('click', () => onAdoptRule(ctx, name, rule, SCOPES.LOCAL));

        const adoptGlobal = el('button', 'wm-btn', '全局');
        adoptGlobal.style.fontSize = '11px';
        adoptGlobal.style.padding = '5px 12px';
        adoptGlobal.title = '加入全局规则库';
        adoptGlobal.addEventListener('click', () => onAdoptRule(ctx, name, rule, SCOPES.GLOBAL));

        actions.append(adoptLocal, adoptGlobal);
        item.append(content, actions);
        list.appendChild(item);
    }
}

// ─────────────────────────────────────────────
// 渲染：角色
// ─────────────────────────────────────────────

function renderCharacters(ctx) {
    const settings = getSettings(ctx);
    const list = $('#wm-char-list');
    if (!list) return;
    const characters = getMergedCharacters(ctx, settings);
    const fields = getProfileFields(settings?.profileMode || PROFILE_MODES.SIMPLE);
    const keyword = uiState.charSearch.trim().toLowerCase();

    // 档案版本切换器在角色页，高亮跟着当前设置走
    const modeGroup = $('#wm-profile-mode');
    if (modeGroup) {
        $$('.wm-scope-btn', modeGroup).forEach((btn) => {
            btn.classList.toggle('wm-active', btn.dataset.mode === (settings?.profileMode || PROFILE_MODES.SIMPLE));
        });
    }

    list.innerHTML = '';
    const entries = Object.entries(characters)
        .filter(([name]) => !keyword || name.toLowerCase().includes(keyword))
        .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'));

    if (entries.length === 0) {
        list.appendChild(buildEmptyState(keyword ? '没有匹配的角色' : '还没有角色档案。分析正文后会自动建档。'));
        return;
    }

    for (const [name, entry] of entries) {
        list.appendChild(buildCharacterCard(ctx, name, entry, fields));
    }
}

function buildCharacterCard(ctx, name, entry, fields) {
    const profile = entry?.profile || {};
    const card = el('div', 'wm-char-item');

    const header = el('div', 'wm-char-header');
    const titleRow = el('div', 'wm-char-title-row');

    const nameGroup = el('div', 'wm-char-name-group');
    nameGroup.appendChild(el('div', 'wm-char-name', name));

    const tags = el('div', 'wm-status-tags');
    tags.appendChild(el('span', 'wm-tag-scope', entry.scope === SCOPES.GLOBAL ? '全局' : '当前卡'));
    if (profile['好感度'] !== undefined && profile['好感度'] !== '') {
        tags.appendChild(el('span', 'wm-tag-favor', `好感 ${profile['好感度']}`));
    }
    if (profile['母猪评级']) {
        tags.appendChild(el('span', 'wm-tag-rating', profile['母猪评级']));
    }
    nameGroup.appendChild(tags);
    titleRow.appendChild(nameGroup);

    const actions = el('div', 'wm-item-actions');
    const delBtn = el('button', 'wm-item-delete', '✕');
    delBtn.title = '删除档案';
    delBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        onDeleteCharacter(ctx, name);
    });
    actions.appendChild(delBtn);
    titleRow.appendChild(actions);
    header.appendChild(titleRow);

    const subRow = el('div', 'wm-char-sub-row');
    const subLeft = el('span', null, [profile['身份'], profile['年龄']].filter(Boolean).join(' · ') || '—');
    subRow.appendChild(subLeft);
    if (profile['淫乱化程度']) {
        subRow.appendChild(el('span', 'wm-degree', profile['淫乱化程度']));
    }
    header.appendChild(subRow);

    const details = el('div', 'wm-char-details');
    const groups = {};
    for (const field of fields) {
        if (!groups[field.group]) groups[field.group] = [];
        groups[field.group].push(field);
    }
    for (const [groupKey, groupFields] of Object.entries(groups)) {
        const group = el('div', 'wm-file-group');
        group.appendChild(el('div', 'wm-file-group-title', PROFILE_GROUPS[groupKey] || groupKey));
        for (const field of groupFields) {
            const value = profile[field.key];
            const hasValue = value !== undefined && value !== null && value !== '';
            const row = el('div', 'wm-attr-row');
            const content = el('div', 'wm-attr-content');
            content.appendChild(el('span', 'wm-attr-label', `${field.label}：`));
            const text = el('span', `wm-attr-text${hasValue ? '' : ' wm-empty-value'}`, hasValue ? value : '未记录');
            content.appendChild(text);
            content.style.cursor = 'pointer';
            content.title = '点击编辑此字段';
            content.addEventListener('click', () => onEditCharacterField(ctx, name, field, value));
            row.appendChild(content);
            group.appendChild(row);
        }
        details.appendChild(group);
    }

    header.addEventListener('click', () => {
        details.classList.toggle('wm-open');
    });

    card.append(header, details);
    return card;
}

// ─────────────────────────────────────────────
// 渲染：衣柜
// ─────────────────────────────────────────────

function renderWardrobe(ctx) {
    const settings = getSettings(ctx);
    const chatData = getChatData(ctx, settings);
    const list = $('#wm-wardrobe-list');
    if (!list) return;
    list.innerHTML = '';

    const entries = Object.entries(chatData.wardrobe || {})
        .filter(([, items]) => Array.isArray(items) && items.length > 0);

    if (entries.length === 0) {
        list.appendChild(buildEmptyState('衣柜为空。需在设置中开启「衣柜追踪」，或点上方按钮手动添加。'));
        return;
    }

    for (const [name, items] of entries) {
        list.appendChild(buildWardrobeCard(ctx, name, items));
    }
}

/** 一个角色的衣柜卡片：外层折叠，内层逐条记录再折叠 */
function buildWardrobeCard(ctx, name, items) {
    const card = el('div', 'wm-wardrobe-card');

    const header = el('div', 'wm-wardrobe-char-header');
    const arrow = el('span', 'wm-wardrobe-arrow', '▸');
    const title = el('div', 'wm-wardrobe-char-name', name);
    const count = el('div', 'wm-wardrobe-char-count', `${items.length} 条`);

    // 新增一条记录
    const addBtn = el('button', 'wm-btn', '＋');
    addBtn.title = '手动新增一条穿着记录';
    addBtn.style.cssText = 'font-size:11px;padding:3px 9px';
    addBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void onEditWardrobeEntry(ctx, name, -1, null);
    });

    header.append(arrow, title, count, addBtn);

    const body = el('div', 'wm-wardrobe-char-body');
    body.style.display = 'none';

    header.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        arrow.textContent = open ? '▸' : '▾';
    });

    // 倒序显示，最近的在最上面
    items.map((entry, index) => ({ entry, index })).reverse().forEach(({ entry, index }) => {
        body.appendChild(buildWardrobeEntryRow(ctx, name, index, entry));
    });

    card.append(header, body);
    return card;
}

/** 单条穿着记录：标题是日期 + 简要描述，展开看详细 */
function buildWardrobeEntryRow(ctx, name, index, entry) {
    const row = el('div', 'wm-wardrobe-entry');

    const head = el('div', 'wm-wardrobe-entry-head');
    const arrow = el('span', 'wm-wardrobe-arrow', '▸');
    const date = el('span', 'wm-wardrobe-date', String(entry.time || '未记时间'));
    const brief = el('span', 'wm-wardrobe-brief', summarizeOutfit(entry.outfit));

    const actions = el('div', 'wm-wardrobe-entry-actions');
    const editBtn = el('button', 'wm-btn-icon wm-no-spin', '✎');
    editBtn.title = '编辑';
    editBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void onEditWardrobeEntry(ctx, name, index, entry);
    });
    const delBtn = el('button', 'wm-item-delete', '✕');
    delBtn.title = '删除';
    delBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!confirmDialog(`确定删除 ${name} 在「${entry.time || '未记时间'}」的这条穿着记录？`)) return;
        removeWardrobeEntry(ctx, name, index);
        renderWardrobe(ctx);
        applyInjection(ctx);
        toast('已删除', 'success');
    });
    actions.append(editBtn, delBtn);

    head.append(arrow, date, brief, actions);

    const detail = el('div', 'wm-wardrobe-detail');
    detail.style.display = 'none';
    if (entry.scene) detail.appendChild(el('div', 'wm-wardrobe-detail-line', `场合：${entry.scene}`));
    detail.appendChild(el('div', 'wm-wardrobe-detail-text', String(entry.outfit || '（无描述）')));

    head.addEventListener('click', () => {
        const open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : '';
        arrow.textContent = open ? '▸' : '▾';
    });

    row.append(head, detail);
    return row;
}

/** 取穿着描述的首句或前若干字，做折叠时的简要标题 */
function summarizeOutfit(outfit) {
    const text = String(outfit || '').trim();
    if (!text) return '（无描述）';
    const first = text.split(/[。；\n]/).find((s) => s.trim());
    const brief = (first || text).trim();
    return brief.length > 30 ? `${brief.slice(0, 30)}…` : brief;
}

/** 编辑（index < 0 表示新增）一条衣柜记录 */
async function onEditWardrobeEntry(ctx, name, index, entry) {
    const isNew = index < 0;
    const settings = getSettings(ctx);
    const chatData = getChatData(ctx, settings);
    const result = await openModal({
        title: isNew ? `为 ${name} 新增穿着` : `编辑 ${name} 的穿着`,
        fields: [
            { key: 'time', label: '时间', type: 'text', value: entry?.time || chatData.worldState.当前时间 || '' },
            { key: 'scene', label: '场合', type: 'text', value: entry?.scene || '', placeholder: '如：卧室、教室、宴会' },
            { key: 'outfit', label: '穿着描述', type: 'textarea', value: entry?.outfit || '', placeholder: '按部位写清：头饰/上衣/下衣/内衣/腿部/足部/配饰…' },
        ],
    });
    if (!result) return;
    const outfit = String(result.outfit || '').trim();
    if (!outfit) return toast('穿着描述不能为空', 'warning');
    const patch = { time: result.time, scene: result.scene, outfit };
    if (isNew) {
        addWardrobeEntry(ctx, name, patch, settings);
        toast('已新增', 'success');
    } else {
        updateWardrobeEntry(ctx, name, index, patch, settings);
        toast('已保存', 'success');
    }
    renderWardrobe(ctx);
    applyInjection(ctx);
}

// ─────────────────────────────────────────────
// 渲染：注入
// ─────────────────────────────────────────────

const INJECT_TOGGLE_DEFS = [
    { key: 'modulator', title: '调制器说明', hint: 'World Modulator 的能力设定与写作要求' },
    { key: 'worldState', title: '世界状态', hint: '当前时间 / 位置 / 天气' },
    { key: 'worldRules', title: '世界规则', hint: '当前生效的全部规则' },
    { key: 'characters', title: '角色档案', hint: '全部角色的档案字段' },
    { key: 'wardrobe', title: '角色衣柜', hint: '每人最近 5 条历史穿着' },
];

function renderInject(ctx) {
    const settings = getSettings(ctx);
    if (!settings) return;

    const container = $('#wm-inject-toggles');
    if (container) {
        container.innerHTML = '';
        for (const def of INJECT_TOGGLE_DEFS) {
            container.appendChild(buildToggleRow(
                def.title,
                def.hint,
                settings.injectToggles?.[def.key] !== false,
                (checked) => {
                    settings.injectToggles[def.key] = checked;
                    saveSettings(ctx);
                    applyInjection(ctx);
                    renderInjectStatus(ctx);
                },
            ));
        }
    }

    const textarea = $('#wm-modulator-text');
    if (textarea && document.activeElement !== textarea) {
        textarea.value = settings.modulatorInjection || DEFAULT_MODULATOR_INJECTION;
    }

    renderInjectStatus(ctx);
}

function buildToggleRow(title, hint, checked, onChange) {
    const row = el('div', 'wm-toggle-row');
    const text = el('div', 'wm-toggle-text');
    text.appendChild(el('div', 'wm-toggle-title', title));
    if (hint) text.appendChild(el('div', 'wm-toggle-hint', hint));

    const label = el('label', 'wm-toggle-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, el('span', 'wm-slider'));

    row.append(text, label);
    return row;
}

function renderInjectStatus(ctx) {
    const container = $('#wm-inject-status');
    if (!container) return;
    const keys = getInjectedKeys();
    const labels = {
        modulator: '调制器说明',
        worldState: '世界状态',
        worldRules: '世界规则',
        characters: '角色档案',
        wardrobe: '衣柜',
    };
    if (keys.length === 0) {
        container.textContent = '当前没有被注入的内容。';
        return;
    }
    const names = keys.map((key) => labels[key.replace(/^.*_inject_/, '')] || key).join('、');
    container.textContent = `已注入：${names}。将在下次生成时生效。`;
}

// ─────────────────────────────────────────────
// 渲染：设置
// ─────────────────────────────────────────────

const TRACK_TOGGLE_DEFS = [
    { key: 'trackWorldState', title: '世界状态', hint: '时间 / 位置 / 天气' },
    { key: 'trackWorldRules', title: '世界规则', hint: '从正文提取规则的新增与修改' },
    { key: 'trackRecommendRules', title: '推荐规则', hint: '每轮生成 6 条情色向规则建议' },
    { key: 'trackWardrobe', title: '角色衣柜', hint: '记录角色历史穿着' },
];

function renderSettings(ctx) {
    const settings = getSettings(ctx);
    if (!settings) return;

    const apiMode = $('#wm-api-mode');
    if (apiMode) apiMode.value = settings.apiMode || 'main';

    const isCustom = (settings.apiMode || 'main') === 'custom';
    const customFields = $('#wm-api-custom-fields');
    if (customFields) customFields.style.display = isCustom ? 'block' : 'none';
    const mainHint = $('#wm-main-hint-row');
    if (mainHint) mainHint.style.display = isCustom ? 'none' : 'block';
    const mainHintText = $('#wm-main-connection-hint');
    if (mainHintText) {
        const connection = resolveConnection({ ...settings, apiMode: 'main' }, ctx);
        if (connection.apiUrl) {
            mainHintText.className = 'wm-notice wm-ok';
            mainHintText.textContent = `将复用主模型连接：${connection.apiUrl}（模型 ${connection.model || '未设置'}）`;
        } else {
            mainHintText.className = 'wm-notice wm-warn';
            mainHintText.textContent = '未能从主模型读到自定义连接配置。若主模型不是「自定义(兼容)」通道，请改用独立配置。';
        }
    }

    setValue('#wm-api-url', settings.apiUrl);
    setValue('#wm-api-key', settings.apiKey);
    setValue('#wm-api-model', settings.model);
    setValue('#wm-temperature', settings.temperature);
    setValue('#wm-timeout', Math.round((Number(settings.apiTimeoutMs) || 120000) / 1000));
    setValue('#wm-poll-ms', settings.pollMs);
    setValue('#wm-context-size', settings.contextSize);
    setValue('#wm-settle-ms', settings.settleMs);

    renderProfileSelect(ctx);
    renderModelOptions(ctx);
    renderPresetOptions(ctx);
    renderSiblingList(ctx);
    renderThemePicker(ctx);

    const usePreset = $('#wm-use-preset');
    if (usePreset) usePreset.checked = settings.usePreset === true;

    // 追踪开关
    const trackContainer = $('#wm-track-toggles');
    if (trackContainer) {
        trackContainer.innerHTML = '';
        for (const def of TRACK_TOGGLE_DEFS) {
            const key = def.key;
            trackContainer.appendChild(buildToggleRow(
                def.title,
                def.hint,
                settings[key] !== false && settings[key] !== undefined
                    ? settings[key] === true
                    : key === 'trackWorldState' || key === 'trackWorldRules',
                (checked) => {
                    // 重新取一次，别依赖闭包捕获的引用
                    const latest = getSettings(ctx);
                    latest[key] = checked;
                    saveSettings(ctx);
                    // 追踪项影响注入内容，立即重算
                    if (key === 'trackWorldRules' || key === 'trackWorldState' || key === 'trackWardrobe') {
                        applyInjection(ctx);
                    }
                },
            ));
        }
    }
}

/** 回填单个输入框；正在编辑该框时不覆盖用户输入 */
function setValue(selector, value) {
    const input = $(selector);
    if (input && document.activeElement !== input) {
        input.value = value ?? '';
    }
}

/** 渲染连接配置组下拉 */
function renderProfileSelect(ctx, selectedName = '') {
    const select = $('#wm-profile-select');
    if (!select) return;
    const settings = getSettings(ctx);
    const profiles = normalizeApiProfiles(settings?.apiProfiles);
    const keep = String(selectedName || select.value || '');
    select.innerHTML = profiles.length > 0
        ? `<option value="">选择配置组以套用</option>${profiles.map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}`
        : '<option value="">尚未保存配置组</option>';
    select.value = profiles.some((p) => p.name === keep) ? keep : '';
}

/** 渲染已拉取的模型列表 */
function renderModelOptions(ctx) {
    const select = $('#wm-model-list');
    if (!select) return;
    const settings = getSettings(ctx);
    const models = Array.isArray(settings?.modelOptions) ? settings.modelOptions : [];
    if (models.length === 0) {
        select.innerHTML = '<option value="">请先拉取模型</option>';
        return;
    }
    select.innerHTML = '<option value="">选择一个模型</option>';
    for (const id of models) {
        const option = el('option', null, id);
        option.value = id;
        if (id === settings.model) option.selected = true;
        select.appendChild(option);
    }
}

/** 连接并拉取模型 */
async function connectAndLoadModels(ctx) {
    const settings = getSettings(ctx);
    const button = $('#wm-api-fetch-models');
    const status = $('#wm-connect-status');
    if (button) button.disabled = true;
    if (status) status.textContent = '连接中，正在拉取模型…';
    try {
        const models = await fetchModelList(settings, ctx);
        settings.modelOptions = models;
        if (!settings.model || !models.includes(settings.model)) {
            settings.model = models[0];
        }
        saveSettings(ctx);
        renderModelOptions(ctx);
        const modelInput = $('#wm-api-model');
        if (modelInput) modelInput.value = settings.model;
        if (status) status.textContent = `已连接，拉取到 ${models.length} 个模型`;
        toast(`已拉取 ${models.length} 个模型`, 'success');
    } catch (error) {
        const message = String(error?.message || error);
        if (status) status.textContent = message;
        toast(message, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

function renderPresetOptions(ctx) {
    const select = $('#wm-preset-name');
    if (!select) return;
    const settings = getSettings(ctx);
    const current = String(settings?.presetName || '');
    const { names } = listPresets(ctx, settings?.presetApiId || 'openai');

    select.innerHTML = '<option value="">（不指定）</option>';
    for (const name of names) {
        const option = el('option', null, name);
        option.value = name;
        select.appendChild(option);
    }
    select.value = names.includes(current) ? current : '';
    renderPresetPrompts(ctx);
}

/**
 * 渲染所选预设的条目开关。
 * 只有启用了「使用预设」并选中预设时才显示。
 */
function renderPresetPrompts(ctx) {
    const container = $('#wm-preset-prompts');
    const row = $('#wm-preset-prompts-row');
    if (!container || !row) return;

    const settings = getSettings(ctx);
    const presetName = settings?.usePreset === true ? String(settings.presetName || '').trim() : '';
    if (!presetName) {
        row.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    const prompts = getPresetPrompts(ctx, presetName, settings.presetApiId || 'openai');
    if (prompts.length === 0) {
        row.style.display = '';
        container.innerHTML = '<div class="wm-item-desc">这个预设没有可单独开关的条目。</div>';
        return;
    }

    const overrides = getPresetPromptOverrides(settings, presetName);
    row.style.display = '';
    container.innerHTML = '';

    for (const prompt of prompts) {
        const enabled = Object.hasOwn(overrides, prompt.identifier)
            ? Boolean(overrides[prompt.identifier])
            : prompt.enabled;
        const item = el('div', 'wm-preset-prompt-item');
        if (!enabled) item.classList.add('wm-disabled');

        const label = el('span', 'wm-preset-prompt-name', prompt.name);
        label.title = `${prompt.name}（${prompt.role}${prompt.marker ? ' · marker' : ''}）`;

        const toggle = el('button', 'wm-preset-prompt-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        toggle.classList.toggle('wm-on', enabled);
        toggle.innerHTML = '<span class="wm-preset-prompt-thumb"></span>';
        toggle.addEventListener('click', () => {
            const latest = getSettings(ctx);
            const current = getPresetPromptOverrides(latest, presetName);
            const nowEnabled = Object.hasOwn(current, prompt.identifier)
                ? Boolean(current[prompt.identifier])
                : prompt.enabled;
            setPresetPromptOverride(latest, presetName, prompt.identifier, !nowEnabled);
            saveSettings(ctx);
            renderPresetPrompts(ctx);
        });

        item.appendChild(label);
        item.appendChild(toggle);
        container.appendChild(item);
    }
}

/** 批量设置所选预设的条目开关 */
function setAllPresetPrompts(ctx, enabled) {
    const settings = getSettings(ctx);
    const presetName = String(settings?.presetName || '').trim();
    if (settings?.usePreset !== true || !presetName) return;
    for (const prompt of getPresetPrompts(ctx, presetName, settings.presetApiId || 'openai')) {
        setPresetPromptOverride(settings, presetName, prompt.identifier, enabled);
    }
    saveSettings(ctx);
    renderPresetPrompts(ctx);
}

// ─────────────────────────────────────────────
// 主题
// ─────────────────────────────────────────────

/** 可选主题，与 style.css 里的 :root[data-wm-theme] 对应 */
export const THEMES = Object.freeze([
    { key: 'deep-space', name: '深空蓝', desc: '霓虹青 · 深色玻璃' },
    { key: 'liquid-glass', name: '液态磨砂玻璃', desc: '靛蓝 · 浅色磨砂' },
]);

const THEME_ATTR = 'data-wm-theme';

/**
 * 把主题写到 <html> 上。
 *
 * 选择器挂在 ':root' 而不是插件面板上，是为了让悬浮球也能跟着换肤——
 * 悬浮球在面板之外，挂在面板上它取不到变量。
 */
export function applyTheme(ctx = null) {
    const settings = getSettings(ctx);
    const theme = THEMES.some((t) => t.key === settings?.theme) ? settings.theme : 'deep-space';
    try {
        document.documentElement.setAttribute(THEME_ATTR, theme);
    } catch { /* ignore */ }
    return theme;
}

/** 渲染主题选择卡片的高亮状态 */
function renderThemePicker(ctx) {
    const grid = $('#wm-theme-grid');
    if (!grid) return;
    const settings = getSettings(ctx);
    const current = settings?.theme || 'deep-space';
    $$('.wm-theme-card', grid).forEach((card) => {
        card.classList.toggle('wm-active', card.dataset.theme === current);
    });
}

// ─────────────────────────────────────────────
// 渲染总入口
// ─────────────────────────────────────────────

function renderAll(ctx = null) {
    const context = ctx || getContextSafe();
    if (!context || !uiState.ready) return;
    renderHeader(context);
    renderWorld(context);
    renderRules(context);
    renderRecommend(context);
    renderCharacters(context);
    renderWardrobe(context);
    renderInject(context);
    renderSettings(context);
}

const renderAllDebounced = debounce(() => renderAll(), 80);

/** 切换到指定标签页 */
function switchTab(tab) {
    uiState.activeTab = tab;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    $$('.wm-tab-btn', panel).forEach((btn) => {
        btn.classList.toggle('wm-active', btn.dataset.tab === tab);
    });
    $$('.wm-tab-panel', panel).forEach((p) => {
        p.classList.toggle('wm-active', p.dataset.panel === tab);
    });
    const settings = getSettings();
    if (settings) {
        settings.lastTab = tab;
        saveSettings();
    }
}

// ─────────────────────────────────────────────
// 事件处理：规则
// ─────────────────────────────────────────────

/** 渲染跨卡搬运栏 */
function renderSiblingList(ctx) {
    const container = $('#wm-sibling-list');
    if (!container) return;
    const settings = getSettings(ctx);
    const siblings = listSiblingChatData(ctx, settings);
    container.innerHTML = '';

    if (siblings.length === 0) {
        container.appendChild(el('div', 'wm-item-desc', '没有找到其他角色卡的数据。在其他卡里创建规则或角色后，这里会列出来。'));
        return;
    }

    for (const sibling of siblings) {
        const block = el('div', 'wm-sibling-block');

        const header = el('div', 'wm-sibling-header');
        const title = el('div', 'wm-sibling-title', sibling.chatKey);
        title.title = sibling.chatKey;
        const meta = el('div', 'wm-sibling-meta',
            `规则 ${sibling.ruleCount} · 角色 ${sibling.charCount} · 衣柜 ${sibling.wardrobeCount}`);
        const arrow = el('span', 'wm-sibling-arrow', '▸');
        header.append(arrow, title, meta);

        const body = el('div', 'wm-sibling-body');
        body.style.display = 'none';
        header.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : '';
            arrow.textContent = open ? '▸' : '▾';
        });

        // 规则
        const ruleNames = Object.keys(sibling.rules);
        if (ruleNames.length > 0) {
            body.appendChild(el('div', 'wm-sibling-section', '规则'));
            for (const name of ruleNames) {
                body.appendChild(buildSiblingItem(
                    name,
                    String(sibling.rules[name]?.description || ''),
                    () => {
                        copyRuleToCurrentChat(ctx, sibling.chatKey, name, settings);
                        renderRules(ctx);
                        applyInjection(ctx);
                        toast(`已复制规则「${name}」到当前卡`, 'success');
                    },
                ));
            }
        }

        // 角色
        const charNames = Object.keys(sibling.characters);
        if (charNames.length > 0) {
            body.appendChild(el('div', 'wm-sibling-section', '角色'));
            for (const name of charNames) {
                const profile = sibling.characters[name]?.profile || {};
                const desc = Object.entries(profile).slice(0, 3)
                    .map(([k, v]) => `${k}：${v}`).join(' · ');
                body.appendChild(buildSiblingItem(name, desc, () => {
                    copyCharacterToCurrentChat(ctx, sibling.chatKey, name, settings);
                    renderCharacters(ctx);
                    applyInjection(ctx);
                    toast(`已复制角色「${name}」到当前卡`, 'success');
                }));
            }
        }

        // 衣柜
        const wardrobeNames = Object.keys(sibling.wardrobe);
        if (wardrobeNames.length > 0) {
            body.appendChild(el('div', 'wm-sibling-section', '衣柜'));
            for (const name of wardrobeNames) {
                const entries = Array.isArray(sibling.wardrobe[name]) ? sibling.wardrobe[name] : [];
                body.appendChild(buildSiblingItem(name, `${entries.length} 条穿着记录`, () => {
                    copyWardrobeToCurrentChat(ctx, sibling.chatKey, name, settings);
                    renderWardrobe(ctx);
                    applyInjection(ctx);
                    toast(`已复制「${name}」的衣柜到当前卡`, 'success');
                }));
            }
        }

        block.append(header, body);
        container.appendChild(block);
    }
}

function buildSiblingItem(name, desc, onCopy) {
    const item = el('div', 'wm-sibling-item');
    const content = el('div', 'wm-item-content');
    content.appendChild(el('div', 'wm-item-title', name));
    if (desc) content.appendChild(el('div', 'wm-item-desc', desc));
    const actions = el('div', 'wm-item-actions');
    const btn = el('button', 'wm-btn', '复制');
    btn.style.fontSize = '11px';
    btn.style.padding = '4px 10px';
    btn.addEventListener('click', (event) => {
        event.stopPropagation();
        onCopy();
    });
    actions.appendChild(btn);
    item.append(content, actions);
    return item;
}

// ─────────────────────────────────────────────
// 事件处理：规则待办
// ─────────────────────────────────────────────

/** 把输入框内容加进待办 */
function onAddRuleDraft(ctx) {
    const input = $('#wm-draft-input');
    const text = String(input?.value || '').trim();
    if (!text) return toast('请先写下想要的大致规则', 'warning');
    addRuleDraft(ctx, text);
    if (input) input.value = '';
    renderRuleDrafts(ctx);
    setDraftStatus(ctx, '已加入待办');
}

function setDraftStatus(ctx, message) {
    const el2 = $('#wm-draft-status');
    if (!el2) return;
    const count = getRuleDrafts(ctx).length;
    el2.textContent = count > 0 ? `${message}（当前待办 ${count} 条）` : message;
}

async function onEditRuleDraft(ctx, draft) {
    const result = await openModal({
        title: '编辑待办',
        fields: [{ key: 'text', label: '规则要求', type: 'textarea', value: draft.text }],
    });
    if (!result) return;
    const text = String(result.text || '').trim();
    if (!text) return toast('内容不能为空', 'warning');
    updateRuleDraft(ctx, draft.id, text);
    renderRuleDrafts(ctx);
}

/** 方式一：拼成文本送进酒馆输入框（用户可继续编辑再发送） */
function onDraftsToInput(ctx) {
    const drafts = getRuleDrafts(ctx);
    if (drafts.length === 0) return toast('待办为空', 'warning');
    const text = formatRuleDrafts(ctx);
    try {
        const textarea = document.querySelector('#send_textarea');
        if (!textarea) throw new Error('找不到酒馆输入框 #send_textarea');
        const existing = String(textarea.value || '');
        textarea.value = existing ? `${existing}\n${text}` : text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        toast('已插入输入框，可继续编辑后发送', 'success');
    } catch (error) {
        // 退而求其次：写进剪贴板，用户自行粘贴
        try {
            void navigator.clipboard?.writeText?.(text);
            toast('未能写入输入框，已复制到剪贴板', 'warning');
        } catch {
            toast(`插入失败：${error?.message || error}`, 'error');
        }
    }
}

/** 方式二：不进输入框，直接交给分析模型整理成正式规则并写回规则表 */
async function onDraftsToAnalyzer(ctx) {
    const drafts = getRuleDrafts(ctx);
    if (drafts.length === 0) return toast('待办为空', 'warning');

    const button = $('#wm-draft-to-ai');
    const status = $('#wm-draft-status');
    if (button) button.disabled = true;
    if (status) status.textContent = '正在让分析模型整理规则…';

    try {
        const settings = getSettings(ctx);
        const requirement = drafts.map((d) => `- ${d.text}`).join('\n');
        const systemPrompt = [
            '你是一个规则整理助手。用户会给出若干条「大致想法」，请把它们整理成规范的世界规则条目。',
            '',
            '【输出要求】',
            '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释文字。',
            '2. 结构：{"world_rules": {"规则名": {"规则描述": "..."}}}',
            '3. 规则名要具体、可辨识，禁止用数字或代号。',
            '4. 规则描述要说清这条规则如何改变世界，控制在 80 字以内。',
            '5. 保留用户原意，可补充使其自洽的细节，但不得改变方向或添加用户没提到的内容。',
            '6. 使用简体中文。',
        ].join('\n');
        const payload = {
            user_requirements: requirement,
            existing_rules: Object.keys(getMergedRules(ctx, settings)),
        };

        const result = await callAnalyzer(settings, ctx, { systemPrompt, payload });
        const rules = result?.world_rules && typeof result.world_rules === 'object' ? result.world_rules : {};
        const names = Object.keys(rules);
        if (names.length === 0) {
            if (status) status.textContent = '模型没有返回可用规则';
            return toast('模型没有返回可用规则', 'warning');
        }

        for (const [name, value] of Object.entries(rules)) {
            const description = String(value?.规则描述 || value?.description || value || '').trim();
            if (!name || !description) continue;
            setRule(ctx, name, description, SCOPES.LOCAL, settings);
        }
        saveSettings(ctx);
        clearRuleDrafts(ctx);
        renderRules(ctx);
        applyInjection(ctx);
        if (status) status.textContent = `已生成并写入 ${names.length} 条规则`;
        toast(`已生成 ${names.length} 条规则`, 'success');
    } catch (error) {
        const message = String(error?.message || error);
        if (status) status.textContent = `失败：${message}`;
        toast(`生成失败：${message}`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function onAddRule(ctx) {
    const result = await openModal({
        title: '新增规则',
        fields: [
            { key: 'name', label: '规则名称', type: 'text', placeholder: '例如：重力减半' },
            { key: 'description', label: '规则描述', type: 'textarea', placeholder: '描述这条规则如何改变世界…' },
            { key: 'scope', label: '作用域', type: 'scope', value: SCOPES.LOCAL },
        ],
    });
    if (!result) return;
    const name = String(result.name || '').trim();
    const description = String(result.description || '').trim();
    if (!name) return toast('规则名称不能为空', 'warning');
    if (!description) return toast('规则描述不能为空', 'warning');
    setRule(ctx, name, description, result.scope || SCOPES.LOCAL);
    applyInjection(ctx);
    renderRules(ctx);
    toast(`已新增规则「${name}」`, 'success');
}

async function onEditRule(ctx, name, rule) {
    const result = await openModal({
        title: `编辑规则：${name}`,
        fields: [
            { key: 'description', label: '规则描述', type: 'textarea', value: rule.description || '' },
        ],
    });
    if (!result) return;
    const description = String(result.description || '').trim();
    if (!description) return toast('规则描述不能为空', 'warning');
    setRule(ctx, name, description, rule.scope || SCOPES.LOCAL);
    applyInjection(ctx);
    renderRules(ctx);
    toast('已保存', 'success');
}

function onToggleRule(ctx, name, rule) {
    const settings = getSettings(ctx);
    const scope = rule.scope || SCOPES.LOCAL;
    const target = scope === SCOPES.GLOBAL ? settings.globalRules : getChatData(ctx, settings).rules;
    if (!target[name]) return;
    const nowEnabled = target[name].enabled === false;
    target[name].enabled = nowEnabled;
    // 重新启用时把它从失效名单里摘掉，避免注入时自相矛盾
    if (nowEnabled) reviveRule(ctx, name, settings);
    saveSettings(ctx);
    applyInjection(ctx);
    renderRules(ctx);
}

function onDeleteRule(ctx, name) {
    if (!confirmDialog(`确定删除规则「${name}」？`)) return;
    removeRule(ctx, name);
    applyInjection(ctx);
    renderRules(ctx);
    toast('已删除', 'success');
}

function onAdoptRule(ctx, name, rule, scope) {
    const settings = getSettings(ctx);
    const target = scope === SCOPES.GLOBAL ? settings.globalRules : getChatData(ctx, settings).rules;
    if (target[name]) {
        toast('同名规则已存在', 'warning');
        return;
    }
    setRule(ctx, name, rule.description || '', scope);
    applyInjection(ctx);
    renderRules(ctx);
    toast(`已采纳到${scope === SCOPES.GLOBAL ? '全局' : '当前卡'}`, 'success');
}

// ─────────────────────────────────────────────
// 事件处理：角色
// ─────────────────────────────────────────────

async function onAddCharacter(ctx) {
    const result = await openModal({
        title: '新增角色档案',
        fields: [
            { key: 'name', label: '角色名字', type: 'text', placeholder: '角色名' },
            { key: 'scope', label: '作用域', type: 'scope', value: SCOPES.LOCAL },
        ],
    });
    if (!result) return;
    const name = String(result.name || '').trim();
    if (!name) return toast('角色名不能为空', 'warning');
    const settings = getSettings(ctx);
    upsertCharacter(ctx, name, {}, result.scope || SCOPES.LOCAL, settings);
    applyInjection(ctx);
    renderCharacters(ctx);
    toast(`已创建角色「${name}」`, 'success');
}

async function onEditCharacterField(ctx, name, field, currentValue) {
    const result = await openModal({
        title: `编辑「${name}」的${field.label}`,
        fields: [
            {
                key: 'value',
                label: field.label,
                type: field.type === 'number' ? 'text' : 'textarea',
                value: currentValue ?? '',
            },
        ],
    });
    if (!result) return;
    const raw = String(result.value ?? '').trim();
    const value = field.type === 'number' ? (Number(raw) || 0) : raw;
    const settings = getSettings(ctx);
    upsertCharacter(ctx, name, { [field.key]: value }, SCOPES.LOCAL, settings);
    applyInjection(ctx);
    renderCharacters(ctx);
    toast('已保存', 'success');
}

function onDeleteCharacter(ctx, name) {
    if (!confirmDialog(`确定删除角色「${name}」的档案？`)) return;
    removeCharacter(ctx, name);
    applyInjection(ctx);
    renderCharacters(ctx);
    toast('已删除', 'success');
}

// ─────────────────────────────────────────────
// 事件处理：操作
// ─────────────────────────────────────────────

async function onAnalyze(ctx) {
    const button = $('#wm-btn-analyze');
    if (button) button.disabled = true;
    resetSettle();
    try {
        await runTracker(ctx, 'manual', {
            renderPanel: renderAllDebounced,
            notify: (message, type) => toast(message, type === 'error' ? 'error' : type),
        });
    } catch (error) {
        console.error(`[${MODULE_NAME}] 手动分析失败`, error);
    } finally {
        if (button) button.disabled = false;
        renderAll(ctx);
    }
}

function onInjectNow(ctx) {
    const result = applyInjection(ctx);
    renderInjectStatus(ctx);
    if (result.injected.length === 0) {
        toast('没有可注入的内容（检查开关与数据）', 'warning');
    } else {
        toast(`已注入：${result.injected.join('、')}`, 'success');
    }
}

/** 世界状态保存 */
function onSaveWorld(ctx) {
    const settings = getSettings(ctx);
    const chatData = getChatData(ctx, settings);
    let changed = 0;
    for (const input of $$('[data-world-field]')) {
        const field = input.dataset.worldField;
        const value = String(input.value || '').trim();
        if (chatData.worldState[field] !== value) {
            chatData.worldState[field] = value;
            changed += 1;
        }
    }
    if (changed > 0) {
        saveSettings(ctx);
        applyInjection(ctx);
        renderHeader(ctx);
        toast(`已保存 ${changed} 项`, 'success');
    } else {
        toast('没有变化', 'info');
    }
}

// ─────────────────────────────────────────────
// 悬浮球拖拽
// ─────────────────────────────────────────────

function setupOrbDrag(orb) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onDown = (event) => {
        const point = event.touches?.[0] || event;
        dragging = true;
        moved = false;
        startX = point.clientX;
        startY = point.clientY;
        const rect = orb.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        orb.classList.add('wm-dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    };

    const onMove = (event) => {
        if (!dragging) return;
        const point = event.touches?.[0] || event;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        if (event.cancelable) event.preventDefault();
        const maxLeft = window.innerWidth - orb.offsetWidth;
        const maxTop = window.innerHeight - orb.offsetHeight;
        const left = Math.min(Math.max(0, originLeft + dx), maxLeft);
        const top = Math.min(Math.max(0, originTop + dy), maxTop);
        orb.style.left = `${left}px`;
        orb.style.top = `${top}px`;
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        orb.classList.remove('wm-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        if (moved) {
            const rect = orb.getBoundingClientRect();
            try {
                localStorage.setItem(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
            } catch { /* ignore */ }
            const settings = getSettings();
            if (settings) {
                settings.floatingPosition = { left: rect.left, top: rect.top };
                saveSettings();
            }
        }
        // 点击开关交给 click 事件处理，这里只负责拖拽收尾
    };

    // 用独立 click 判定开关：不依赖 mouseup，也避开 ST 的全局拖拽处理
    orb.addEventListener('click', (event) => {
        if (moved) { moved = false; return; }
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
    });

    orb.addEventListener('mousedown', onDown);
    orb.addEventListener('touchstart', onDown, { passive: true });
    // 触屏的 click 在拖动后仍会触发，用它兜底覆盖
    orb.addEventListener('touchend', (event) => {
        if (moved) { moved = false; return; }
        event.preventDefault();
        togglePanel();
    });
}

function restoreOrbPosition(orb) {
    let position = null;
    try {
        const raw = localStorage.getItem(POSITION_KEY);
        if (raw) position = JSON.parse(raw);
    } catch { /* ignore */ }
    if (!position) {
        const settings = getSettings();
        position = settings?.floatingPosition || null;
    }
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        const maxLeft = Math.max(0, window.innerWidth - 52);
        const maxTop = Math.max(0, window.innerHeight - 52);
        orb.style.left = `${Math.min(Math.max(0, position.left), maxLeft)}px`;
        orb.style.top = `${Math.min(Math.max(0, position.top), maxTop)}px`;
    } else {
        orb.style.right = '18px';
        orb.style.bottom = '120px';
    }
}

// ─────────────────────────────────────────────
// 面板显示控制
// ─────────────────────────────────────────────

function openPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.add('wm-open');
    panel.style.display = 'flex';
    renderAll();
    const settings = getSettings();
    switchTab(settings?.lastTab || 'world');
}

function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    closeModal();
    panel.classList.remove('wm-open');
    panel.style.display = 'none';
}

function togglePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (panel.classList.contains('wm-open')) closePanel();
    else openPanel();
}

function setupPanelDrag(panel) {
    const handle = $('.wm-status-header', panel);
    if (!handle) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onDown = (event) => {
        if (event.target.closest('button, input, select, textarea, .wm-toggle-switch')) return;
        const point = event.touches?.[0] || event;
        dragging = true;
        startX = point.clientX;
        startY = point.clientY;
        const rect = panel.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.margin = '0';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    };

    const onMove = (event) => {
        if (!dragging) return;
        const point = event.touches?.[0] || event;
        if (event.cancelable) event.preventDefault();
        const maxLeft = window.innerWidth - panel.offsetWidth;
        const maxTop = window.innerHeight - panel.offsetHeight;
        const left = Math.min(Math.max(0, originLeft + point.clientX - startX), Math.max(0, maxLeft));
        const top = Math.min(Math.max(0, originTop + point.clientY - startY), Math.max(0, maxTop));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });
}

// 面板居中由 CSS 负责（见 #wm-panel 的 inset + margin:auto）。
// 这里不再用 JS 测量：面板初始 display:none，量到的尺寸为 0，会算错位置。

// ─────────────────────────────────────────────
// 事件绑定
// ─────────────────────────────────────────────

function bindEvents(ctx) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    // 标签页
    $$('.wm-tab-btn', panel).forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tab === 'inject') applyInjection(ctx);
            switchTab(btn.dataset.tab);
        });
    });

    // 头部
    $('#wm-toggle-enabled')?.addEventListener('change', (event) => {
        const settings = getSettings(ctx);
        settings.enabled = event.target.checked;
        saveSettings(ctx);
        renderHeader(ctx);
        if (settings.enabled) {
            resetSettle();
            startPolling(ctx, { renderPanel: renderAllDebounced, notify: (message, type) => toast(message, type) });
        } else {
            stopPolling();
        }
    });

    $('#wm-btn-minimize')?.addEventListener('click', () => closePanel());
    $('#wm-btn-close')?.addEventListener('click', () => closePanel());

    // 全局操作
    $('#wm-btn-analyze')?.addEventListener('click', () => onAnalyze(ctx));
    $('#wm-btn-inject')?.addEventListener('click', () => onInjectNow(ctx));
    $('#wm-btn-refresh')?.addEventListener('click', () => {
        renderAll(ctx);
        toast('已刷新', 'info');
    });

    // 世界状态
    $('#wm-world-save')?.addEventListener('click', () => onSaveWorld(ctx));

    // 规则
    $('#wm-rule-add')?.addEventListener('click', () => onAddRule(ctx));
    $('#wm-rule-search')?.addEventListener('input', debounce((event) => {
        uiState.ruleSearch = event.target.value;
        renderRules(ctx);
    }, 150));

    // 规则待办
    $('#wm-draft-add')?.addEventListener('click', () => onAddRuleDraft(ctx));
    $('#wm-draft-input')?.addEventListener('keydown', (event) => {
        // Ctrl/Cmd + Enter 快速加入
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onAddRuleDraft(ctx);
        }
    });
    $('#wm-draft-to-input')?.addEventListener('click', () => onDraftsToInput(ctx));
    $('#wm-draft-to-ai')?.addEventListener('click', () => { void onDraftsToAnalyzer(ctx); });
    $('#wm-draft-clear')?.addEventListener('click', () => {
        if (getRuleDrafts(ctx).length === 0) return;
        if (!confirmDialog('确定清空全部规则待办？')) return;
        clearRuleDrafts(ctx);
        renderRuleDrafts(ctx);
        setDraftStatus(ctx, '已清空');
    });
    $('#wm-retired-clear')?.addEventListener('click', () => {
        clearRetiredRules(ctx);
        renderRules(ctx);
        applyInjection(ctx);
        toast('已清空失效记录', 'success');
    });

    // 角色
    $('#wm-char-add')?.addEventListener('click', () => onAddCharacter(ctx));
    $('#wm-char-search')?.addEventListener('input', debounce((event) => {
        uiState.charSearch = event.target.value;
        renderCharacters(ctx);
    }, 150));

    // 衣柜（开关在设置页与注入页，这里只做展示与编辑）

    // 注入
    $('#wm-modulator-save')?.addEventListener('click', () => {
        const settings = getSettings(ctx);
        settings.modulatorInjection = String($('#wm-modulator-text')?.value || '');
        saveSettings(ctx);
        applyInjection(ctx);
        renderInjectStatus(ctx);
        toast('已保存并注入', 'success');
    });
    $('#wm-modulator-reset')?.addEventListener('click', () => {
        const textarea = $('#wm-modulator-text');
        if (textarea) textarea.value = DEFAULT_MODULATOR_INJECTION;
        toast('已恢复默认，记得点保存', 'info');
    });

    // 设置：API
    $('#wm-api-mode')?.addEventListener('change', (event) => {
        const settings = getSettings(ctx);
        settings.apiMode = event.target.value;
        saveSettings(ctx);
        renderSettings(ctx);
    });
    $('#wm-api-url')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.apiUrl = String(event.target.value || '').trim();
        saveSettings(ctx);
    });
    $('#wm-api-key')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.apiKey = String(event.target.value || '');
        saveSettings(ctx);
    });
    $('#wm-api-model')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.model = String(event.target.value || '').trim();
        saveSettings(ctx);
    });
    $('#wm-model-list')?.addEventListener('change', (event) => {
        const next = String(event.target.value || '').trim();
        if (!next) return;
        const settings = getSettings(ctx);
        settings.model = next;
        saveSettings(ctx);
        const input = $('#wm-api-model');
        if (input) input.value = next;
    });
    $('#wm-api-fetch-models')?.addEventListener('click', () => {
        void connectAndLoadModels(ctx);
    });

    // 设置：连接配置组
    $('#wm-profile-select')?.addEventListener('change', (event) => {
        const name = String(event.target.value || '').trim();
        if (!name) return;
        try {
            const settings = getSettings(ctx);
            applyApiProfile(settings, name);
            saveSettings(ctx);
            renderSettings(ctx);
            const nameInput = $('#wm-profile-name');
            if (nameInput) nameInput.value = name;
            const status = $('#wm-connect-status');
            if (status) status.textContent = '已切换配置组';
            toast(`已套用配置组「${name}」`, 'success');
        } catch (error) {
            toast(String(error?.message || error), 'error');
        }
    });
    $('#wm-profile-save')?.addEventListener('click', () => {
        const name = String($('#wm-profile-name')?.value || '').trim();
        if (!name) return toast('请先输入配置组名称', 'warning');
        try {
            const settings = getSettings(ctx);
            const existed = (settings.apiProfiles || []).some((p) => p.name === name);
            if (existed && !confirmDialog(`已有配置组「${name}」，要用当前设置覆盖吗？`)) return;
            saveApiProfile(settings, name);
            saveSettings(ctx);
            renderProfileSelect(ctx, name);
            toast(`已${existed ? '覆盖' : '保存'}配置组「${name}」`, 'success');
        } catch (error) {
            toast(String(error?.message || error), 'warning');
        }
    });
    $('#wm-profile-delete')?.addEventListener('click', () => {
        const name = String($('#wm-profile-select')?.value || $('#wm-profile-name')?.value || '').trim();
        if (!name) return toast('请先选择要删除的配置组', 'warning');
        if (!confirmDialog(`确定删除配置组「${name}」？当前连接设置不受影响。`)) return;
        try {
            const settings = getSettings(ctx);
            deleteApiProfile(settings, name);
            saveSettings(ctx);
            renderProfileSelect(ctx);
            const nameInput = $('#wm-profile-name');
            if (nameInput) nameInput.value = '';
            toast(`已删除配置组「${name}」`, 'success');
        } catch (error) {
            toast(String(error?.message || error), 'error');
        }
    });

    // 设置：预设
    $('#wm-use-preset')?.addEventListener('change', (event) => {
        const settings = getSettings(ctx);
        settings.usePreset = event.target.checked;
        saveSettings(ctx);
        renderPresetPrompts(ctx);
    });
    $('#wm-preset-name')?.addEventListener('change', (event) => {
        const settings = getSettings(ctx);
        const next = String(event.target.value || '').trim();
        settings.presetName = next;
        // 选了别的预设，「使用预设」开关自动打开，否则条目区不显示，很费解
        if (next && settings.usePreset !== true) {
            settings.usePreset = true;
            const toggle = $('#wm-use-preset');
            if (toggle) toggle.checked = true;
        }
        saveSettings(ctx);
        renderPresetPrompts(ctx);
    });
    $('#wm-preset-refresh')?.addEventListener('click', () => {
        renderPresetOptions(ctx);
        toast('已刷新预设列表', 'info');
    });
    $('#wm-preset-all-on')?.addEventListener('click', () => setAllPresetPrompts(ctx, true));
    $('#wm-preset-all-off')?.addEventListener('click', () => setAllPresetPrompts(ctx, false));
    $('#wm-preset-reset-override')?.addEventListener('click', () => {
        const settings = getSettings(ctx);
        const name = String(settings?.presetName || '').trim();
        if (!name) return;
        clearPresetPromptOverrides(settings, name);
        saveSettings(ctx);
        renderPresetPrompts(ctx);
        toast('已恢复预设默认开关', 'success');
    });

    $('#wm-temperature')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.temperature = Number(event.target.value) || 0;
        saveSettings(ctx);
    });
    $('#wm-timeout')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        const seconds = Math.max(5, Number(event.target.value) || 120);
        settings.apiTimeoutMs = seconds * 1000;
        saveSettings(ctx);
    });
    $('#wm-poll-ms')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.pollMs = Math.max(800, Number(event.target.value) || 1800);
        saveSettings(ctx);
        if (isPolling()) startPolling(ctx, { renderPanel: renderAllDebounced, notify: (message, type) => toast(message, type) });
    });
    $('#wm-context-size')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.contextSize = Math.max(1, Math.min(60, Number(event.target.value) || 12));
        saveSettings(ctx);
    });
    $('#wm-settle-ms')?.addEventListener('input', (event) => {
        const settings = getSettings(ctx);
        settings.settleMs = Math.max(200, Number(event.target.value) || 1400);
        saveSettings(ctx);
    });

    // 档案版本（在角色页，用事件委托以便面板重渲染后依然有效）
    document.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('#wm-profile-mode .wm-scope-btn');
        if (!btn) return;
        const mode = btn.dataset.mode;
        if (!mode) return;
        const settings = getSettings(ctx);
        if (settings.profileMode === mode) return;
        settings.profileMode = mode;
        saveSettings(ctx);
        renderCharacters(ctx);
        renderSettings(ctx);
        applyInjection(ctx);
        toast(mode === 'full' ? '已切换到正常版档案' : '已切换到简化版档案', 'info');
    });

    // 外观：主题切换
    document.addEventListener('click', (event) => {
        const card = event.target?.closest?.('#wm-theme-grid .wm-theme-card');
        if (!card) return;
        const theme = card.dataset.theme;
        if (!theme) return;
        const settings = getSettings(ctx);
        if (settings.theme === theme) return;
        settings.theme = theme;
        saveSettings(ctx);
        applyTheme(ctx);
        renderThemePicker(ctx);
        const label = THEMES.find((t) => t.key === theme)?.name || theme;
        toast(`已切换到「${label}」主题`, 'success');
    });

    // 数据
    $('#wm-data-export')?.addEventListener('click', () => onExportData(ctx));
    $('#wm-data-clear-chat')?.addEventListener('click', () => onClearChatData(ctx));
    $('#wm-data-import')?.addEventListener('click', () => $('#wm-data-import-file')?.click());
    $('#wm-data-import-file')?.addEventListener('change', (event) => {
        const file = event.target?.files?.[0];
        void onImportData(ctx, file).finally(() => {
            if (event.target) event.target.value = '';
        });
    });
    $('#wm-sibling-refresh')?.addEventListener('click', () => {
        renderSiblingList(ctx);
        toast('已刷新跨卡列表', 'info');
    });
}

// ─────────────────────────────────────────────
// 数据操作
// ─────────────────────────────────────────────

function onExportData(ctx) {
    const settings = getSettings(ctx);
    const payload = {
        exportedAt: new Date().toISOString(),
        chatKey: getChatKey(ctx),
        settings: {
            enabled: settings.enabled,
            profileMode: settings.profileMode,
            injectToggles: settings.injectToggles,
            modulatorInjection: settings.modulatorInjection,
            apiMode: settings.apiMode,
            apiUrl: settings.apiUrl,
            model: settings.model,
            temperature: settings.temperature,
            usePreset: settings.usePreset,
            presetName: settings.presetName,
            presetPromptOverrides: settings.presetPromptOverrides,
            // 配置组含 API Key，导出文件请自行妥善保管
            apiProfiles: settings.apiProfiles,
            trackWorldState: settings.trackWorldState,
            trackWorldRules: settings.trackWorldRules,
            trackRecommendRules: settings.trackRecommendRules,
            trackWardrobe: settings.trackWardrobe,
            pollMs: settings.pollMs,
            contextSize: settings.contextSize,
            settleMs: settings.settleMs,
        },
        globalRules: settings.globalRules,
        globalCharacters: settings.globalCharacters,
        chatData: getChatData(ctx, settings),
        exportedBy: 'World Modulator',
        schemaVersion: 1,
    };
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `world-modulator-${Date.now()}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('已导出', 'success');
    } catch (error) {
        console.error(`[${MODULE_NAME}] 导出失败`, error);
        toast('导出失败，详见控制台', 'error');
    }
}

/** 从导出的 JSON 恢复数据 */
async function onImportData(ctx, file) {
    if (!file) return;
    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object') throw new Error('文件内容不是有效的 JSON 对象');

        const settings = getSettings(ctx);
        const incoming = payload.settings || {};

        // 连接与预设设置：整体覆盖（导出时已含这些字段）
        for (const key of [
            'enabled', 'profileMode', 'injectToggles', 'modulatorInjection',
            'apiMode', 'apiUrl', 'model', 'temperature', 'usePreset', 'presetName',
            'presetPromptOverrides', 'apiProfiles',
            'trackWorldState', 'trackWorldRules', 'trackRecommendRules', 'trackWardrobe',
            'pollMs', 'contextSize', 'settleMs',
        ]) {
            if (incoming[key] !== undefined) settings[key] = incoming[key];
        }
        settings.apiProfiles = normalizeApiProfiles(settings.apiProfiles);

        if (payload.globalRules && typeof payload.globalRules === 'object') {
            settings.globalRules = { ...settings.globalRules, ...payload.globalRules };
        }
        if (payload.globalCharacters && typeof payload.globalCharacters === 'object') {
            settings.globalCharacters = { ...settings.globalCharacters, ...payload.globalCharacters };
        }

        // 聊天数据合并进当前聊天
        if (payload.chatData && typeof payload.chatData === 'object') {
            const current = getChatData(ctx, settings);
            for (const key of ['worldState', 'rules', 'recommendedRules', 'characters', 'wardrobe', 'retiredRules']) {
                const value = payload.chatData[key];
                if (!value || typeof value !== 'object') continue;
                current[key] = { ...(current[key] || {}), ...value };
            }
            if (Array.isArray(payload.chatData.ruleDrafts)) {
                current.ruleDrafts = payload.chatData.ruleDrafts;
            }
        }

        await saveSettingsNow(ctx);
        renderAll(ctx);
        applyInjection(ctx);
        toast('数据已导入', 'success');
    } catch (error) {
        console.error(`[${MODULE_NAME}] 导入失败`, error);
        toast(`导入失败：${error?.message || error}`, 'error');
    }
}

async function onClearChatData(ctx) {
    if (!confirmDialog('确定清空当前聊天的全部调制器数据？此操作不可撤销。')) return;
    const settings = getSettings(ctx);
    const key = getChatKey(ctx);
    dropChatData(ctx, key, settings);
    await saveSettingsNow(ctx);
    clearInjection(ctx);
    renderAll(ctx);
    toast('已清空本聊天数据', 'success');
}

// ─────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────

async function loadTemplate() {
    const response = await fetch(TEMPLATE_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`无法加载模板：HTTP ${response.status}`);
    return response.text();
}

// ─────────────────────────────────────────────
// 魔杖菜单入口
// ─────────────────────────────────────────────

/**
 * 往 ST 的魔杖菜单（#extensionsMenu）插入本插件入口。
 * 菜单是页面加载后才由 ST 渲染的，所以找不到时要靠外层重试。
 * @returns {boolean} 是否已就位
 */
function createMenuItem(ctx) {
    if (document.getElementById(MENU_ITEM_ID)) return true;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;

    const item = document.createElement('div');
    item.id = MENU_ITEM_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-atom extensionsMenuExtensionButton"></div><span>World Modulator</span>';

    const activate = (event) => {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        if (event.type === 'keydown') event.preventDefault();
        togglePanel();
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', activate);

    // 扩展设置的齿轮按钮也会触发 click，这里拦下以免误弹面板
    menu.appendChild(item);
    return true;
}

/** 打开 / 收起主面板（复用已有 togglePanel） */

async function ensureDom(ctx) {
    if (!document.getElementById(ORB_ID)) {
        const html = await loadTemplate();
        const holder = document.createElement('div');
        holder.innerHTML = html;
        while (holder.firstChild) {
            document.body.appendChild(holder.firstChild);
        }
    }

    // 绑定与定位只做一次，避免重试时重复挂监听
    if (uiState.domBound) return;
    uiState.domBound = true;

    const panel = document.getElementById(PANEL_ID);
    const orb = document.getElementById(ORB_ID);
    if (panel) {
        setupPanelDrag(panel);
    }
    if (orb) {
        restoreOrbPosition(orb);
        setupOrbDrag(orb);
    }
    bindEvents(ctx);

    window.addEventListener('resize', () => {
        const p = document.getElementById(PANEL_ID);
        if (p && p.style.left) {
            const rect = p.getBoundingClientRect();
            const maxLeft = window.innerWidth - rect.width;
            const maxTop = window.innerHeight - rect.height;
            if (rect.left > maxLeft) p.style.left = `${Math.max(0, maxLeft)}px`;
            if (rect.top > maxTop) p.style.top = `${Math.max(0, maxTop)}px`;
        }
    });
}

/** 启动轮询与初始注入 */
function bootstrapRuntime(ctx) {
    const settings = getSettings(ctx);
    if (!settings) return;

    // 首次注入
    applyInjection(ctx);
    resetSettle();

    // 总开关打开时启动轮询
    if (settings.enabled === true) {
        startPolling(ctx, { renderPanel: renderAllDebounced, notify: (message, type) => toast(message, type) });
    }

    const deps = { renderPanel: renderAllDebounced, notify: (message, type) => toast(message, type) };

    try {
        ctx.eventSource?.on?.(ctx.eventTypes?.CHAT_CHANGED, () => {
            resetSettle();
            applyInjection(ctx);
            renderAllDebounced();
        });
        ctx.eventSource?.on?.(ctx.eventTypes?.MESSAGE_RECEIVED, () => {
            renderAllDebounced();
        });
        ctx.eventSource?.on?.(ctx.eventTypes?.MESSAGE_SENT, () => {
            resetSettle();
            renderAllDebounced();
        });
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 事件订阅失败`, error);
    }
    void deps;
}

/**
 * 插件入口。
 *
 * ST 加载第三方扩展脚本的时机早于宿主 context 与魔杖菜单就绪，因此：
 *   1. ctx 拿不到时不能直接放弃，外层会重试；
 *   2. 界面（悬浮球 + 面板）与菜单项都允许重复调用，幂等。
 */
export async function init() {
    const ctx = getContextSafe();
    if (!ctx) return false;

    const firstRun = !uiState.ready;
    try {
        // 先套主题再建界面，避免首帧闪成默认皮肤
        applyTheme(ctx);
        await ensureDom(ctx);
        uiState.ready = true;
        createMenuItem(ctx);
        if (firstRun) {
            bootstrapRuntime(ctx);
            renderAll(ctx);
            console.log(`[${MODULE_NAME}] 已加载（v1.0.0）`);
        }
        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] 初始化失败`, error);
        return false;
    }
}

/** 带重试的启动：context、DOM、魔杖菜单都可能晚于脚本就绪 */
function scheduleInit(retries = BOOT_RETRY_MAX) {
    const attempt = async () => {
        if (typeof document === 'undefined') return;
        const ctx = getContextSafe();
        if (ctx) {
            const done = await init().catch((error) => {
                console.error(`[${MODULE_NAME}] 启动失败`, error);
                return false;
            });
            // 菜单项没插上（#extensionsMenu 还没渲染）时继续重试
            if (done && document.getElementById(MENU_ITEM_ID)) return;
        }
        if (retries > 0) {
            setTimeout(attempt, BOOT_RETRY_DELAY_MS);
        } else {
            console.warn(`[${MODULE_NAME}] 启动重试已用尽；可在控制台执行 __worldModulator__.init()`);
        }
    };
    setTimeout(attempt, 0);
}

/** 模块加载即初始化（不依赖 manifest hooks） */
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => scheduleInit(), { once: true });
    } else {
        scheduleInit();
    }
}

// 便于在控制台调试
globalThis.__worldModulator__ = {
    init,
    applyInjection,
    runTracker: (reason = 'manual') => runTracker(getContextSafe(), reason),
    poll: () => poll(getContextSafe()),
    getDebugInfo,
    getSettings,
    getRunState,
    /** 打开 / 收起主面板（控制台可用） */
    toggle: () => togglePanel(),
    open: () => openPanel(),
    close: () => closePanel(),
    /** 诊断：逐项报告界面与状态是否就位 */
    diagnose() {
        const panel = document.getElementById(PANEL_ID);
        const orb = document.getElementById(ORB_ID);
        const menu = document.getElementById(MENU_ITEM_ID);
        const report = {
            'context 可取': Boolean(getContextSafe()),
            'uiState.ready': uiState.ready,
            'uiState.domBound': uiState.domBound,
            '悬浮球存在': Boolean(orb),
            '悬浮球可见': Boolean(orb && orb.getBoundingClientRect().width > 0),
            '悬浮球位置': orb ? { left: orb.style.left, top: orb.style.top, right: orb.style.right, bottom: orb.style.bottom } : null,
            '面板存在': Boolean(panel),
            '面板已打开': Boolean(panel && panel.classList.contains('wm-open')),
            '菜单项存在': Boolean(menu),
            '菜单容器存在': Boolean(document.getElementById('extensionsMenu')),
        };
        console.table(report);
        return report;
    },
};
