/**
 * World Modulator —— 状态与存储层
 *
 * 数据结构总览：
 *   extension_settings[MODULE_NAME] = {
 *     ...settings,                       // 全局设置（API、开关等）
 *     globalRules: { [规则名]: {...} },   // 全局规则库（跨卡可用）
 *     globalCharacters: { [角色名]: {...} }, // 全局角色库（跨卡可用）
 *     chatData: { [chatKey]: ChatData },  // 按聊天的数据
 *   }
 *
 *   ChatData = {
 *     worldState: { 当前时间, 当前位置, 当前天气 },
 *     rules: { [规则名]: { description, enabled } },       // 本卡规则
 *     recommendedRules: { [规则名]: { description } },     // 推荐规则（每轮刷新）
 *     characters: { [角色名]: { fields..., scope } },      // 本卡角色
 *     wardrobe: { [角色名]: [ { time, scene, outfit } ] }, // 衣柜
 *     meta: { lastProcessedSignature, lastRunAt, lastSummary, lastRawResult, snapshots }
 *   }
 */

import {
    MODULE_NAME,
    PROFILE_MODES,
    SCOPES,
    DEFAULT_MODULATOR_INJECTION,
    getProfileFields,
} from './prompts.js';

export { MODULE_NAME, PROFILE_MODES, SCOPES };

/** 聊天数据 schema 版本，结构变更时递增并写迁移 */
export const CHAT_DATA_SCHEMA_VERSION = 1;

export const DEFAULT_ANALYZER_PROMPT_WRAPPER =
    '以下是当前世界的状态。请阅读最近的剧情正文，判断发生了哪些变化，并按系统提示词的要求输出 JSON。';

export const DEFAULT_SETTINGS = Object.freeze({
    /** 总开关：插件是否自动分析 */
    enabled: false,
    /** 是否注入调制器说明到主模型 */
    injectModulator: true,
    /** 调制器说明文本（可编辑，默认使用内置模板） */
    modulatorInjection: DEFAULT_MODULATOR_INJECTION,
    /** 档案版本 */
    profileMode: PROFILE_MODES.SIMPLE,
    /** 是否追踪世界规则 */
    trackWorldRules: true,
    /** 是否生成推荐规则 */
    trackRecommendRules: true,
    /** 是否追踪衣柜 */
    trackWardrobe: false,
    /** 是否追踪世界状态（时间/位置/天气） */
    trackWorldState: true,

    /** ── API ── */
    /** 'main' = 复用主模型配置；'custom' = 使用独立配置 */
    apiMode: 'main',
    apiUrl: '',
    apiKey: '',
    model: '',
    modelOptions: [],
    /** 已保存的连接配置组（每套含端点到温度的全套连接设置） */
    apiProfiles: [],
    apiTimeoutMs: 120000,
    /** 分析模型温度 */
    temperature: 0.3,
    /** 是否使用预设 */
    usePreset: false,
    /** 预设名称 */
    presetName: '',
    /** 预设所属 apiId */
    presetApiId: 'openai',
    /** 逐条开关某个预设内的提示词：{ [预设名]: { [条目标识]: boolean } } */
    presetPromptOverrides: {},

    /** ── 触发 ── */
    /** 轮询间隔（毫秒） */
    pollMs: 1800,
    /** 携带多少条最近消息 */
    contextSize: 12,
    /** 正文稳定判定窗口（毫秒） */
    settleMs: 1400,

    /** ── 注入开关（逐项） ── */
    injectToggles: {
        modulator: true,
        worldState: true,
        worldRules: true,
        characters: true,
        wardrobe: false,
    },
    /** 注入位置：'in_prompt' | 'before_prompt' */
    injectPosition: 'in_prompt',
    /** 注入深度（仅 in_chat 用，预留） */
    injectDepth: 0,

    /** ── 界面 ── */
    /** 悬浮球位置 */
    floatingPosition: null,
    /** 上次打开的标签页 */
    lastTab: 'rules',
    /** 主面板尺寸 */
    panelSize: null,

    /** ── 存储 ── */
    globalRules: {},
    globalCharacters: {},
    chatData: {},
});

/** 返回一份全新的空 ChatData */
export function createEmptyChatData() {
    return {
        schemaVersion: CHAT_DATA_SCHEMA_VERSION,
        worldState: {
            当前时间: '',
            当前位置: '',
            当前天气: '',
        },
        rules: {},
        /** 已失效规则名 → 失效原因；注入时要显式告知主模型这些规则不再生效 */
        retiredRules: {},
        recommendedRules: {},
        characters: {},
        wardrobe: {},
        /** 跨卡搬运用的规则待办草稿 [{ id, text, createdAt }] */
        ruleDrafts: [],
        meta: {
            lastProcessedSignature: '',
            lastRunAt: 0,
            lastSummary: '',
            lastRawResult: null,
            snapshots: [],
        },
    };
}

/** 返回一个空角色档案（按当前档案版本填写字段） */
export function createEmptyCharacter(name = '', mode = PROFILE_MODES.SIMPLE) {
    const profile = { 名字: String(name || '') };
    for (const field of getProfileFields(mode)) {
        profile[field.key] = field.type === 'number' ? 0 : '';
    }
    return {
        name: String(name || ''),
        scope: SCOPES.LOCAL,
        profile,
        updatedAt: 0,
    };
}

// ─────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────

function clone(value) {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

/** 安全取宿主 context；扩展加载时机可能拿不到 */
export function getContextSafe() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 无法获取 SillyTavern context`, error);
        return null;
    }
}

/**
 * 确保 extension_settings 上有本插件的设置对象。
 *
 * 注意：已有对象必须「原地补齐」而不是整体替换。外部代码常常这样写：
 *     const settings = getSettings(ctx);
 *     ... 中间又调用了别的 getSettings()/getChatData() ...
 *     settings.enabled = true;
 * 如果每次都返回新对象，后一次写入就会落到已被丢弃的旧对象上而静默丢失。
 */
export function ensureSettingsObject(ctx) {
    if (!ctx) return null;
    if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') return null;

    const existing = ctx.extensionSettings[MODULE_NAME];
    const target = (existing && typeof existing === 'object') ? existing : {};

    // 补齐顶层缺失字段（不覆盖已有值）
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (target[key] === undefined) {
            target[key] = clone(value);
        }
    }
    // 嵌套对象单独补齐
    if (!target.injectToggles || typeof target.injectToggles !== 'object') {
        target.injectToggles = clone(DEFAULT_SETTINGS.injectToggles);
    } else {
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS.injectToggles)) {
            if (target.injectToggles[key] === undefined) target.injectToggles[key] = value;
        }
    }
    if (!target.globalRules || typeof target.globalRules !== 'object') target.globalRules = {};
    if (!target.globalCharacters || typeof target.globalCharacters !== 'object') target.globalCharacters = {};
    if (!target.chatData || typeof target.chatData !== 'object') target.chatData = {};

    ctx.extensionSettings[MODULE_NAME] = target;
    return target;
}

export function getSettings(ctx = null) {
    const context = ctx || getContextSafe();
    return ensureSettingsObject(context);
}

export function saveSettings(ctx = null) {
    const context = ctx || getContextSafe();
    try {
        context?.saveSettingsDebounced?.();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 保存设置失败`, error);
    }
}

/** 立即可确认的保存（用于破坏性操作） */
export async function saveSettingsNow(ctx = null) {
    const context = ctx || getContextSafe();
    try {
        if (typeof context?.saveSettings === 'function') {
            await context.saveSettings();
            return true;
        }
        context?.saveSettingsDebounced?.();
        return false;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] 立即保存设置失败`, error);
        return false;
    }
}

// ─────────────────────────────────────────────
// 聊天标识与数据存取
// ─────────────────────────────────────────────

/**
 * 取当前聊天的稳定标识。
 * 优先用聊天 ID；退而用 角色ID:群组ID 组合。
 */
export function getChatKey(ctx = null) {
    const context = ctx || getContextSafe();
    if (!context) return '';
    try {
        const chatId = context.getCurrentChatId?.();
        if (chatId !== undefined && chatId !== null && String(chatId)) {
            return String(chatId);
        }
    } catch {
        /* ignore */
    }
    const characterId = context.characterId ?? 'char';
    const groupId = context.groupId ?? 'solo';
    return `${characterId}:${groupId}`;
}

/**
 * 取当前角色卡标识（用于"仅当前卡"作用域与卡片继承）。
 */
export function getCharacterKey(ctx = null) {
    const context = ctx || getContextSafe();
    if (!context) return '';
    try {
        if (context.groupId) return `group:${context.groupId}`;
        const character = context.characters?.[context.characterId];
        const avatar = character?.avatar;
        if (avatar) return `char:${avatar}`;
    } catch {
        /* ignore */
    }
    return `char:${context.characterId ?? 'unknown'}`;
}

/** 取当前聊天的数据对象（不存在则创建） */
export function getChatData(ctx = null, settings = null) {
    const context = ctx || getContextSafe();
    const s = settings || getSettings(context);
    if (!s) return createEmptyChatData();
    const key = getChatKey(context);
    if (!key) return createEmptyChatData();
    let data = s.chatData[key];
    if (!data || typeof data !== 'object') {
        data = createEmptyChatData();
        s.chatData[key] = data;
    }
    // 结构补全（旧存档迁移）
    if (!data.worldState || typeof data.worldState !== 'object') data.worldState = { 当前时间: '', 当前位置: '', 当前天气: '' };
    for (const field of ['当前时间', '当前位置', '当前天气']) {
        if (typeof data.worldState[field] !== 'string') data.worldState[field] = '';
    }
    if (!data.rules || typeof data.rules !== 'object') data.rules = {};
    if (!data.recommendedRules || typeof data.recommendedRules !== 'object') data.recommendedRules = {};
    if (!data.characters || typeof data.characters !== 'object') data.characters = {};
    if (!data.wardrobe || typeof data.wardrobe !== 'object') data.wardrobe = {};
    if (!data.meta || typeof data.meta !== 'object') data.meta = createEmptyChatData().meta;
    if (!Array.isArray(data.meta.snapshots)) data.meta.snapshots = [];
    data.schemaVersion = CHAT_DATA_SCHEMA_VERSION;
    return data;
}

/**
 * 新建聊天时从同角色的其他聊天继承数据。
 * 规则、角色档案、世界状态可继承；推荐规则与处理进度不继承。
 */
export function inheritFromSiblingChat(ctx, settings) {
    const context = ctx || getContextSafe();
    const s = settings || getSettings(context);
    if (!s) return false;
    const targetKey = getChatKey(context);
    const characterKey = getCharacterKey(context);
    const target = getChatData(context, s);

    // 已有实质内容就不覆盖
    const hasContent = Object.keys(target.rules).length > 0
        || Object.keys(target.characters).length > 0
        || Object.values(target.worldState).some((value) => String(value || '').trim());
    if (hasContent) return false;

    let source = null;
    for (const [key, data] of Object.entries(s.chatData)) {
        if (key === targetKey) continue;
        if (!key.startsWith(String(context.characterId ?? '\u0000'))) continue;
        if (data && typeof data === 'object') {
            source = data;
            break;
        }
    }
    if (!source) return false;

    target.rules = clone(source.rules || {});
    target.characters = clone(source.characters || {});
    target.worldState = clone(source.worldState || target.worldState);
    target.wardrobe = clone(source.wardrobe || {});
    void characterKey;
    saveSettings(context);
    return true;
}

/** 删除某个聊天的数据（聊天被删除时清理） */
export function dropChatData(ctx, chatKey, settings = null) {
    const context = ctx || getContextSafe();
    const s = settings || getSettings(context);
    if (!s || !chatKey) return false;
    if (!Object.hasOwn(s.chatData, chatKey)) return false;
    delete s.chatData[chatKey];
    saveSettings(context);
    return true;
}

// ─────────────────────────────────────────────
// 作用域合并视图
// ─────────────────────────────────────────────

/**
 * 取合并后的规则表：全局规则 + 本地规则，本地同名覆盖全局。
 * @returns {Record<string, {description:string, enabled:boolean, scope:'global'|'local'}>}
 */
export function getMergedRules(ctx = null, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s) return {};
    const data = getChatData(ctx, s);
    const merged = {};
    for (const [name, rule] of Object.entries(s.globalRules || {})) {
        merged[name] = { ...rule, scope: SCOPES.GLOBAL };
    }
    for (const [name, rule] of Object.entries(data.rules || {})) {
        merged[name] = { ...rule, scope: SCOPES.LOCAL };
    }
    return merged;
}

/**
 * 取合并后的角色表：全局角色 + 本地角色，本地同名覆盖全局。
 */
export function getMergedCharacters(ctx = null, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s) return {};
    const data = getChatData(ctx, s);
    const merged = {};
    for (const [name, entry] of Object.entries(s.globalCharacters || {})) {
        merged[name] = { ...entry, scope: SCOPES.GLOBAL };
    }
    for (const [name, entry] of Object.entries(data.characters || {})) {
        merged[name] = { ...entry, scope: SCOPES.LOCAL };
    }
    return merged;
}

/** 把一条规则写入指定作用域 */
export function setRule(ctx, name, description, scope = SCOPES.LOCAL, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return;
    const entry = { description: String(description || ''), enabled: true, updatedAt: Date.now() };
    if (scope === SCOPES.GLOBAL) {
        s.globalRules[name] = entry;
    } else {
        getChatData(ctx, s).rules[name] = entry;
    }
    // 重新写入同名规则视为重新生效，清掉旧的失效记录
    const data = getChatData(ctx, s);
    if (data.retiredRules && Object.hasOwn(data.retiredRules, name)) {
        delete data.retiredRules[name];
    }
    saveSettings(ctx);
}

/** 删除一条规则 */
export function removeRule(ctx, name, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return false;
    let removed = false;
    if (Object.hasOwn(s.globalRules, name)) {
        delete s.globalRules[name];
        removed = true;
    }
    const data = getChatData(ctx, s);
    if (Object.hasOwn(data.rules, name)) {
        delete data.rules[name];
        removed = true;
    }
    // 记下失效规则，注入时要显式告知主模型它已不再生效
    if (removed) {
        if (!data.retiredRules || typeof data.retiredRules !== 'object') data.retiredRules = {};
        data.retiredRules[name] = { since: Date.now() };
        saveSettings(ctx);
    }
    return removed;
}

/** 规则是否处于失效状态 */
export function isRuleRetired(ctx, name, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    return Object.hasOwn(data.retiredRules || {}, name);
}

/** 取失效规则名列表 */
export function getRetiredRuleNames(ctx, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    return Object.keys(data.retiredRules || {});
}

/** 让某条规则重新生效（从失效名单里移除） */
export function reviveRule(ctx, name, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return false;
    const data = getChatData(ctx, s);
    if (!data.retiredRules || !Object.hasOwn(data.retiredRules, name)) return false;
    delete data.retiredRules[name];
    saveSettings(ctx);
    return true;
}

/** 清空失效规则记录 */
export function clearRetiredRules(ctx, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    data.retiredRules = {};
    saveSettings(ctx);
}

// ─────────────────────────────────────────────
// 规则待办草稿（先攒着，再一键送进输入框或交给 AI 补充）
// ─────────────────────────────────────────────

/** 取规则草稿列表 */
export function getRuleDrafts(ctx, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    return Array.isArray(data.ruleDrafts) ? data.ruleDrafts : [];
}

/** 新增一条规则草稿 */
export function addRuleDraft(ctx, text, settings = null) {
    const s = settings || getSettings(ctx);
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const data = getChatData(ctx, s);
    if (!Array.isArray(data.ruleDrafts)) data.ruleDrafts = [];
    const draft = {
        id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: trimmed,
        createdAt: Date.now(),
    };
    data.ruleDrafts.push(draft);
    saveSettings(ctx);
    return draft;
}

/** 修改一条规则草稿 */
export function updateRuleDraft(ctx, id, text, settings = null) {
    const s = settings || getSettings(ctx);
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    const data = getChatData(ctx, s);
    const list = Array.isArray(data.ruleDrafts) ? data.ruleDrafts : [];
    const target = list.find((d) => d.id === id);
    if (!target) return false;
    target.text = trimmed;
    target.updatedAt = Date.now();
    saveSettings(ctx);
    return true;
}

/** 删除一条规则草稿 */
export function removeRuleDraft(ctx, id, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    const list = Array.isArray(data.ruleDrafts) ? data.ruleDrafts : [];
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    data.ruleDrafts = next;
    saveSettings(ctx);
    return true;
}

/** 清空全部规则草稿 */
export function clearRuleDrafts(ctx, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    data.ruleDrafts = [];
    saveSettings(ctx);
}

/** 把草稿拼成一段可直接插入输入框的文本 */
export function formatRuleDrafts(ctx, settings = null) {
    const drafts = getRuleDrafts(ctx, settings);
    if (drafts.length === 0) return '';
    const body = drafts.map((d) => `- ${d.text}`).join('\n');
    return `请把以下要求整理成世界规则并逐条添加：\n${body}`;
}

// ─────────────────────────────────────────────
// 跨角色卡搬运
// ─────────────────────────────────────────────

/**
 * 列出其他聊天（角色卡）里存过数据的条目。
 *
 * 返回结构：
 *   [{ chatKey, rules: {name: rule}, characters: {name: entry}, wardrobe: {name: [...]} }, ...]
 * 不含当前聊天。空聊天会被过滤掉。
 */
export function listSiblingChatData(ctx = null, settings = null) {
    const context = ctx || getContextSafe();
    const s = settings || getSettings(context);
    if (!s || !s.chatData || typeof s.chatData !== 'object') return [];
    const currentKey = getChatKey(context);
    const out = [];
    for (const [chatKey, data] of Object.entries(s.chatData)) {
        if (chatKey === currentKey) continue;
        if (!data || typeof data !== 'object') continue;
        const rules = (data.rules && typeof data.rules === 'object') ? data.rules : {};
        const characters = (data.characters && typeof data.characters === 'object') ? data.characters : {};
        const wardrobe = (data.wardrobe && typeof data.wardrobe === 'object') ? data.wardrobe : {};
        const ruleCount = Object.keys(rules).length;
        const charCount = Object.keys(characters).length;
        const wardrobeCount = Object.keys(wardrobe).length;
        if (ruleCount + charCount + wardrobeCount === 0) continue;
        out.push({
            chatKey,
            lastRunAt: Number(data.meta?.lastRunAt) || 0,
            rules,
            characters,
            wardrobe,
            ruleCount,
            charCount,
            wardrobeCount,
        });
    }
    return out.sort((a, b) => b.lastRunAt - a.lastRunAt);
}

/** 把别处的规则复制到当前卡 */
export function copyRuleToCurrentChat(ctx, sourceChatKey, name, settings = null) {
    const s = settings || getSettings(ctx);
    const source = s.chatData?.[sourceChatKey]?.rules?.[name];
    if (!source) return false;
    const data = getChatData(ctx, s);
    data.rules[name] = { ...source, updatedAt: Date.now(), copiedFrom: sourceChatKey };
    if (data.retiredRules && Object.hasOwn(data.retiredRules, name)) delete data.retiredRules[name];
    saveSettings(ctx);
    return true;
}

/** 把别处的角色档案复制到当前卡 */
export function copyCharacterToCurrentChat(ctx, sourceChatKey, name, settings = null) {
    const s = settings || getSettings(ctx);
    const source = s.chatData?.[sourceChatKey]?.characters?.[name];
    if (!source) return false;
    const data = getChatData(ctx, s);
    data.characters[name] = {
        ...source,
        profile: { ...(source.profile || {}) },
        scope: SCOPES.LOCAL,
        copiedFrom: sourceChatKey,
    };
    saveSettings(ctx);
    return true;
}

/** 把别处的衣柜记录复制到当前卡（追加，不覆盖已有） */
export function copyWardrobeToCurrentChat(ctx, sourceChatKey, name, settings = null) {
    const s = settings || getSettings(ctx);
    const source = s.chatData?.[sourceChatKey]?.wardrobe?.[name];
    if (!Array.isArray(source) || source.length === 0) return false;
    const data = getChatData(ctx, s);
    if (!data.wardrobe[name] || !Array.isArray(data.wardrobe[name])) data.wardrobe[name] = [];
    data.wardrobe[name].push(...source.map((entry) => ({ ...entry, copiedFrom: sourceChatKey })));
    saveSettings(ctx);
    return true;
}

/** 把某条本地规则/角色提升为全局（跨卡可用） */
export function promoteToGlobal(ctx, kind, name, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    if (kind === 'rule') {
        const rule = data.rules?.[name];
        if (!rule) return false;
        s.globalRules[name] = { ...rule, scope: SCOPES.GLOBAL };
        delete data.rules[name];
    } else if (kind === 'character') {
        const character = data.characters?.[name];
        if (!character) return false;
        s.globalCharacters[name] = { ...character, scope: SCOPES.GLOBAL };
        delete data.characters[name];
    } else {
        return false;
    }
    saveSettings(ctx);
    return true;
}

/** 把全局条目收回当前卡 */
export function demoteToLocal(ctx, kind, name, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    if (kind === 'rule') {
        const rule = s.globalRules?.[name];
        if (!rule) return false;
        data.rules[name] = { ...rule, scope: SCOPES.LOCAL };
        delete s.globalRules[name];
    } else if (kind === 'character') {
        const character = s.globalCharacters?.[name];
        if (!character) return false;
        data.characters[name] = { ...character, scope: SCOPES.LOCAL };
        delete s.globalCharacters[name];
    } else {
        return false;
    }
    saveSettings(ctx);
    return true;
}

/** 写入角色档案（按字段合并，只覆盖提供的字段） */
export function upsertCharacter(ctx, name, fields, scope = SCOPES.LOCAL, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return null;
    const target = scope === SCOPES.GLOBAL ? s.globalCharacters : getChatData(ctx, s).characters;
    const existing = target[name] || createEmptyCharacter(name, s.profileMode);
    const profile = { ...existing.profile, ...fields, 名字: name };
    target[name] = {
        ...existing,
        name,
        scope,
        profile,
        updatedAt: Date.now(),
    };
    saveSettings(ctx);
    return target[name];
}

/** 删除角色档案 */
export function removeCharacter(ctx, name, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return false;
    let removed = false;
    if (Object.hasOwn(s.globalCharacters, name)) {
        delete s.globalCharacters[name];
        removed = true;
    }
    const data = getChatData(ctx, s);
    if (Object.hasOwn(data.characters, name)) {
        delete data.characters[name];
        removed = true;
    }
    if (removed) saveSettings(ctx);
    return removed;
}

/** 追加一条衣柜纪录 */
export function appendWardrobeEntry(ctx, name, entry, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return;
    const data = getChatData(ctx, s);
    if (!Array.isArray(data.wardrobe[name])) data.wardrobe[name] = [];
    data.wardrobe[name].push({
        time: String(entry?.time || data.worldState.当前时间 || ''),
        scene: String(entry?.scene || ''),
        outfit: String(entry?.outfit || ''),
        at: Date.now(),
    });
    saveSettings(ctx);
}

/** 取某角色的全部衣柜记录 */
export function getWardrobeEntries(ctx, name, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    const list = data.wardrobe?.[name];
    return Array.isArray(list) ? list : [];
}

/** 按索引更新一条衣柜记录 */
export function updateWardrobeEntry(ctx, name, index, patch, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    const list = data.wardrobe?.[name];
    if (!Array.isArray(list) || index < 0 || index >= list.length) return false;
    const entry = list[index];
    if (patch.time !== undefined) entry.time = String(patch.time || '');
    if (patch.scene !== undefined) entry.scene = String(patch.scene || '');
    if (patch.outfit !== undefined) entry.outfit = String(patch.outfit || '');
    entry.editedAt = Date.now();
    saveSettings(ctx);
    return true;
}

/** 按索引删除一条衣柜记录 */
export function removeWardrobeEntry(ctx, name, index, settings = null) {
    const s = settings || getSettings(ctx);
    const data = getChatData(ctx, s);
    const list = data.wardrobe?.[name];
    if (!Array.isArray(list) || index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    if (list.length === 0) delete data.wardrobe[name];
    saveSettings(ctx);
    return true;
}

/** 手动新增一条衣柜记录 */
export function addWardrobeEntry(ctx, name, entry, settings = null) {
    const s = settings || getSettings(ctx);
    if (!s || !name) return false;
    const data = getChatData(ctx, s);
    if (!Array.isArray(data.wardrobe[name])) data.wardrobe[name] = [];
    data.wardrobe[name].push({
        time: String(entry?.time || data.worldState.当前时间 || ''),
        scene: String(entry?.scene || ''),
        outfit: String(entry?.outfit || ''),
        at: Date.now(),
        manual: true,
    });
    saveSettings(ctx);
    return true;
}

// ─────────────────────────────────────────────
// 消息签名（防重复分析）
// ─────────────────────────────────────────────

/**
 * 计算"处理到第 count 条消息"的内容指纹。
 * 取首尾内容与长度，足以识别增删改，成本低。
 * @returns {string}
 */
export function buildSignature(ctx, count) {
    const context = ctx || getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const end = Math.max(0, Math.min(Number(count) || 0, chat.length));
    if (end <= 0) return '0|';
    const parts = [String(end)];
    const first = chat[0];
    const last = chat[end - 1];
    const tail = (message) => {
        const text = String(message?.mes || '');
        return `${message?.is_user ? 'u' : 'a'}:${text.length}:${text.slice(0, 60)}:${text.slice(-60)}`;
    };
    parts.push(tail(first));
    if (end > 1) parts.push(tail(last));
    return parts.join('|');
}

/** 取最近 N 条消息（发给分析模型） */
export function buildRecentMessages(ctx, settings, endIndexExclusive = null) {
    const context = ctx || getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const end = endIndexExclusive === null || endIndexExclusive === undefined
        ? chat.length
        : Math.min(Number(endIndexExclusive) || 0, chat.length);
    const size = Math.max(1, Math.floor(Number(settings?.contextSize) || 12));
    const start = Math.max(0, end - size);
    return chat.slice(start, end)
        .filter((message) => message && String(message.mes || '').trim())
        .map((message) => ({
            name: String(message.name || (message.is_user ? '用户' : '角色')),
            is_user: Boolean(message.is_user),
            text: String(message.mes || ''),
        }));
}

/** 把角色档案转成紧凑的可读文本（发给分析模型，避免 JSON 冗余） */
export function describeCharactersForPrompt(characters, profileMode) {
    const fields = getProfileFields(profileMode);
    const out = {};
    for (const [name, entry] of Object.entries(characters || {})) {
        const profile = entry?.profile || {};
        const slim = {};
        for (const field of fields) {
            const value = profile[field.key];
            if (value === undefined || value === null || value === '') continue;
            if (field.type === 'number' && (value === 0 || value === '0')) {
                // 0 是需要保留的有意义值（处女次数），但空档案不必发
                if (!entry?.initialized) continue;
            }
            slim[field.key] = value;
        }
        if (Object.keys(slim).length === 0) continue;
        out[name] = { ...slim, __scope: entry?.scope || SCOPES.LOCAL };
    }
    return out;
}

// ─────────────────────────────────────────────
// 连接配置组（可保存多套 API 配置随时切换）
// ─────────────────────────────────────────────

/** 最多保存的配置组数量 */
export const API_PROFILE_LIMIT = 30;

/** 一个配置组包含的连接字段 */
export const API_PROFILE_FIELDS = Object.freeze([
    'apiMode', 'apiUrl', 'apiKey', 'model', 'temperature',
]);

/** 规范化配置组列表：去空白、去重名、截断数量、过滤非法项 */
export function normalizeApiProfiles(list) {
    const seen = new Set();
    const profiles = [];
    for (const entry of (Array.isArray(list) ? list : [])) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const name = String(entry.name || '').trim().slice(0, 40);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        profiles.push({
            name,
            apiMode: entry.apiMode === 'custom' ? 'custom' : 'main',
            apiUrl: String(entry.apiUrl || '').trim(),
            apiKey: String(entry.apiKey || ''),
            model: String(entry.model || '').trim(),
            temperature: Number.isFinite(Number(entry.temperature)) ? Number(entry.temperature) : 0.3,
            modelOptions: Array.isArray(entry.modelOptions)
                ? entry.modelOptions.map((m) => String(m || '').trim()).filter(Boolean)
                : [],
        });
        if (profiles.length >= API_PROFILE_LIMIT) break;
    }
    return profiles;
}

/**
 * 以当前连接设置新增或覆盖同名配置组。
 * @returns {boolean} 是否为覆盖已有配置组
 */
export function saveApiProfile(settings, name) {
    const trimmed = String(name || '').trim().slice(0, 40);
    if (!trimmed) throw new Error('请先输入配置组名称');
    const profiles = normalizeApiProfiles(settings.apiProfiles);
    const index = profiles.findIndex((profile) => profile.name === trimmed);
    if (index < 0 && profiles.length >= API_PROFILE_LIMIT) {
        throw new Error(`最多保存 ${API_PROFILE_LIMIT} 组`);
    }
    const profile = {
        name: trimmed,
        ...Object.fromEntries(API_PROFILE_FIELDS.map((field) => [field, settings[field]])),
        // 模型列表跟着配置走，切换后不必重新拉取
        modelOptions: Array.isArray(settings.modelOptions) ? [...settings.modelOptions] : [],
    };
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    settings.apiProfiles = normalizeApiProfiles(profiles);
    return index >= 0;
}

/** 把配置组套回当前连接设置 */
export function applyApiProfile(settings, name) {
    const trimmed = String(name || '').trim();
    const profile = normalizeApiProfiles(settings.apiProfiles).find((entry) => entry.name === trimmed);
    if (!profile) throw new Error('找不到这个配置组');
    for (const field of API_PROFILE_FIELDS) settings[field] = profile[field];
    settings.modelOptions = [...profile.modelOptions];
    return profile;
}

export function deleteApiProfile(settings, name) {
    const trimmed = String(name || '').trim();
    const profiles = normalizeApiProfiles(settings.apiProfiles);
    const next = profiles.filter((profile) => profile.name !== trimmed);
    if (next.length === profiles.length) throw new Error('找不到这个配置组');
    settings.apiProfiles = next;
}

// ─────────────────────────────────────────────
// 预设条目覆盖（逐条开关预设内的提示词）
// ─────────────────────────────────────────────

/**
 * 取某个预设的条目开关覆盖表。
 * 结构：settings.presetPromptOverrides = { [预设名]: { [条目标识]: boolean } }
 */
export function getPresetPromptOverrides(settings, presetName) {
    const all = settings?.presetPromptOverrides;
    if (!all || typeof all !== 'object') return {};
    const one = all[String(presetName || '')];
    return (one && typeof one === 'object' && !Array.isArray(one)) ? one : {};
}

/** 写入某个预设某条目的开关状态 */
export function setPresetPromptOverride(settings, presetName, identifier, enabled) {
    const name = String(presetName || '').trim();
    const id = String(identifier || '').trim();
    if (!name || !id) return;
    if (!settings.presetPromptOverrides || typeof settings.presetPromptOverrides !== 'object') {
        settings.presetPromptOverrides = {};
    }
    if (!settings.presetPromptOverrides[name] || typeof settings.presetPromptOverrides[name] !== 'object') {
        settings.presetPromptOverrides[name] = {};
    }
    settings.presetPromptOverrides[name][id] = Boolean(enabled);
}

/** 清掉某个预设的全部条目覆盖 */
export function clearPresetPromptOverrides(settings, presetName) {
    const name = String(presetName || '').trim();
    if (!settings?.presetPromptOverrides || typeof settings.presetPromptOverrides !== 'object') return;
    delete settings.presetPromptOverrides[name];
}
