/**
 * World Modulator —— 提示词注入
 *
 * 把世界状态、规则、角色档案、调制器说明注入到主模型的提示词中。
 * 每一项都有独立开关，由设置里的 injectToggles 控制。
 *
 * 使用 ST 官方接口 setExtensionPrompt(key, value, position, depth, scan, role)。
 * extension_prompts 是内存对象，页面刷新即清空，因此每次状态变化都要重新注入。
 */

import { MODULE_NAME, PROFILE_MODES, getProfileFields } from './prompts.js';
import { getChatData, getMergedCharacters, getMergedRules, getRetiredRuleNames, getSettings } from './state.js';

/** 注入用的键前缀 */
const KEY_BASE = `${MODULE_NAME}_inject`;

/** ST 注入位置常量（与 public/script.js 的 extension_prompt_types 一致） */
export const POSITIONS = Object.freeze({
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
});

/** ST 注入身份常量 */
export const ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

// ─────────────────────────────────────────────
// 文本拼装
// ─────────────────────────────────────────────

/** 世界状态 → 文本 */
export function renderWorldState(chatData) {
    const state = chatData?.worldState || {};
    const lines = [];
    if (String(state.当前时间 || '').trim()) lines.push(`当前时间：${state.当前时间}`);
    if (String(state.当前位置 || '').trim()) lines.push(`当前位置：${state.当前位置}`);
    if (String(state.当前天气 || '').trim()) lines.push(`当前天气：${state.当前天气}`);
    if (lines.length === 0) return '';
    return `【世界状态】\n${lines.join('\n')}`;
}

/**
 * 世界规则 → 文本。
 *
 * 生效规则正常列出；被关闭或删除的规则要显式声明「已失效」——
 * 否则主模型可能仍按上一轮提示词里的旧规则继续叙事。
 * @param {object} rules 合并后的规则表
 * @param {string[]} retiredNames 已失效规则名（来自本轮禁用/删除的记录）
 */
export function renderWorldRules(rules, retiredNames = []) {
    const entries = Object.entries(rules || {});
    const active = entries.filter(([, rule]) => (
        rule && rule.enabled !== false && String(rule.description || '').trim()
    ));
    const disabled = entries.filter(([, rule]) => rule && rule.enabled === false);

    // 合并显式失效名单与当前处于禁用状态的规则，去重
    const retired = [...new Set([
        ...(Array.isArray(retiredNames) ? retiredNames : []),
        ...disabled.map(([name]) => name),
    ])].filter((name) => name && !active.some(([n]) => n === name));

    const blocks = [];
    if (active.length > 0) {
        const body = active.map(([name, rule]) => `- ${name}：${rule.description}`).join('\n');
        blocks.push(`【世界规则】\n以下是本世界当前生效的规则，叙事必须严格遵守：\n${body}`);
    }
    if (retired.length > 0) {
        const body = retired.map((name) => `- ${name}`).join('\n');
        blocks.push(`【已失效规则】\n以下规则已被废除，**不再生效**。叙事中不得再依据这些规则行事，也不得让角色表现出受其约束的迹象：\n${body}`);
    }
    return blocks.join('\n\n');
}

/** 角色档案 → 文本 */
export function renderCharacters(characters, profileMode) {
    const fields = getProfileFields(profileMode);
    const blocks = [];
    for (const [name, entry] of Object.entries(characters || {})) {
        const profile = entry?.profile || {};
        const lines = [];
        for (const field of fields) {
            const value = profile[field.key];
            if (value === undefined || value === null || value === '') continue;
            if (field.type === 'number' && value === 0 && !entry?.initialized) continue;
            lines.push(`${field.label}：${value}`);
        }
        if (lines.length === 0) continue;
        blocks.push(`◆ ${name}\n${lines.join('\n')}`);
    }
    if (blocks.length === 0) return '';
    return `【角色档案】\n${blocks.join('\n\n')}`;
}

/** 衣柜 → 文本（取每人最近若干条） */
export function renderWardrobe(chatData, perCharacterLimit = 5) {
    const wardrobe = chatData?.wardrobe || {};
    const blocks = [];
    for (const [name, entries] of Object.entries(wardrobe)) {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const recent = entries.slice(-Math.max(1, perCharacterLimit));
        const lines = recent.map((entry) => {
            const time = String(entry.time || '').trim();
            const scene = String(entry.scene || '').trim();
            const outfit = String(entry.outfit || '').trim();
            const head = [time, scene].filter(Boolean).join(' · ');
            return head ? `- ${head}：${outfit}` : `- ${outfit}`;
        });
        if (lines.length === 0) continue;
        blocks.push(`◆ ${name}\n${lines.join('\n')}`);
    }
    if (blocks.length === 0) return '';
    return `【角色衣柜·历史穿着】\n${blocks.join('\n\n')}`;
}

/**
 * 组装全部注入片段。
 * @param {object} ctx
 * @returns {Record<string, string>} 键为片段名，值为文本（空串表示不注入）
 */
export function buildInjectionSegments(ctx) {
    const settings = getSettings(ctx);
    if (!settings) return {};
    const toggles = settings.injectToggles || {};
    const chatData = getChatData(ctx, settings);
    const segments = {};

    if (toggles.modulator) {
        const text = String(settings.modulatorInjection || '').trim();
        if (text) segments.modulator = text;
    }
    if (toggles.worldState) {
        const text = renderWorldState(chatData);
        if (text) segments.worldState = text;
    }
    if (toggles.worldRules) {
        const text = renderWorldRules(
            getMergedRules(ctx, settings),
            getRetiredRuleNames(ctx, settings),
        );
        if (text) segments.worldRules = text;
    }
    if (toggles.characters) {
        const text = renderCharacters(getMergedCharacters(ctx, settings), settings.profileMode || PROFILE_MODES.SIMPLE);
        if (text) segments.characters = text;
    }
    if (toggles.wardrobe) {
        const text = renderWardrobe(chatData);
        if (text) segments.wardrobe = text;
    }
    return segments;
}

// ─────────────────────────────────────────────
// 注入执行
// ─────────────────────────────────────────────

let lastInjectedKeys = [];

/**
 * 执行注入：先清掉上一轮的键，再写入本轮内容。
 *
 * @param {object} ctx 宿主 context
 * @returns {{injected: string[], length: number}}
 */
export function applyInjection(ctx) {
    const settings = getSettings(ctx);
    if (!settings) return { injected: [], length: 0 };

    // 清理上一轮
    for (const key of lastInjectedKeys) {
        try {
            ctx.setExtensionPrompt?.(key, '', POSITIONS.IN_PROMPT, 0);
        } catch { /* ignore */ }
    }
    lastInjectedKeys = [];

    const segments = buildInjectionSegments(ctx);
    const position = settings.injectPosition === 'before_prompt' ? POSITIONS.BEFORE_PROMPT : POSITIONS.IN_PROMPT;
    const depth = Math.max(0, Math.floor(Number(settings.injectDepth) || 0));
    const injected = [];
    let length = 0;

    for (const [name, text] of Object.entries(segments)) {
        if (!text) continue;
        const key = `${KEY_BASE}_${name}`;
        try {
            ctx.setExtensionPrompt?.(key, text, position, depth, false, ROLES.SYSTEM);
            injected.push(name);
            lastInjectedKeys.push(key);
            length += text.length;
        } catch (error) {
            console.warn(`[${MODULE_NAME}] 注入「${name}」失败`, error);
        }
    }

    return { injected, length };
}

/** 清空全部注入 */
export function clearInjection(ctx) {
    for (const key of lastInjectedKeys) {
        try {
            ctx.setExtensionPrompt?.(key, '', POSITIONS.IN_PROMPT, 0);
        } catch { /* ignore */ }
    }
    lastInjectedKeys = [];
}

/** 取当前已注入的键（界面显示用） */
export function getInjectedKeys() {
    return [...lastInjectedKeys];
}
