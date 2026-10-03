/**
 * World Modulator —— 结果应用层
 *
 * 把分析模型返回的 JSON 落到状态上。
 *
 * 模型输出结构（全部字段可选）：
 * {
 *   "world_state": { "当前时间": "...", "当前位置": "...", "当前天气": "..." },
 *   "world_rules": { "规则名": { "规则描述": "..." } },
 *   "recommended_rules": { "规则名": { "规则描述": "..." } },
 *   "characters": { "角色名": { "字段": "值", ... } },
 *   "wardrobe": { "角色名": [{ "time","scene","outfit" }] },
 *   "summary": "本轮变化的简述"
 * }
 */

import { MODULE_NAME, SCOPES, getProfileFields, PROFILE_MODES } from './prompts.js';
import {
    appendWardrobeEntry,
    getChatData,
    getSettings,
    saveSettings,
    upsertCharacter,
} from './state.js';

/** 从各种可能的包装里取出规则描述文本 */
function readRuleDescription(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
        for (const key of ['规则描述', 'description', 'desc', '内容', '效果']) {
            if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
        }
    }
    return '';
}

/** 取对象的第一个字符串值（容忍模型用别的键名） */
/**
 * 从模型返回的值里取一段文本。
 *
 * 模型对同一字段可能给出字符串、数字、布尔，或包一层对象/数组，
 * 这里都要能接住——否则像「年龄」返回 18 这种会被整条丢掉。
 */
function firstStringValue(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const text = firstStringValue(item);
            if (text) return text;
        }
        return '';
    }
    if (value && typeof value === 'object') {
        // 常见包装：优先取有语义的字段名，避免把 id/时间戳当成内容
        for (const preferred of ['描述', '内容', '值', '说明', '文本', 'text', 'value', 'description', 'content']) {
            const item = value[preferred];
            if (item !== undefined) {
                const text = firstStringValue(item);
                if (text) return text;
            }
        }
        for (const item of Object.values(value)) {
            const text = firstStringValue(item);
            if (text) return text;
        }
    }
    return '';
}

/**
 * 归一化模型返回的对象表。
 * 模型有时会返回数组、有时会包一层 { name: {...} }，这里统一成 Record。
 */
function normalizeRecord(value) {
    if (!value) return {};
    if (Array.isArray(value)) {
        const out = {};
        for (const item of value) {
            if (!item || typeof item !== 'object') continue;
            const name = String(item.名字 || item.name || item.名称 || item.规则名 || '').trim();
            if (name) out[name] = item;
        }
        return out;
    }
    if (typeof value === 'object') return value;
    return {};
}

// ─────────────────────────────────────────────
// 各部分应用
// ─────────────────────────────────────────────

/**
 * 更新世界状态。只接受非空值，避免模型回传空串把已有内容抹掉。
 * @returns {string[]} 实际改变的字段名
 */
function applyWorldState(chatData, worldState) {
    if (!worldState || typeof worldState !== 'object') return [];
    const changed = [];
    for (const field of ['当前时间', '当前位置', '当前天气']) {
        const next = firstStringValue(worldState[field]);
        if (!next) continue;
        if (chatData.worldState[field] !== next) {
            chatData.worldState[field] = next;
            changed.push(field);
        }
    }
    return changed;
}

/**
 * 更新世界规则。
 * @returns {{added:string[], updated:string[], removed:string[]}}
 */
function applyWorldRules(chatData, worldRules) {
    const result = { added: [], updated: [], removed: [] };
    const record = normalizeRecord(worldRules);
    for (const [rawName, value] of Object.entries(record)) {
        const name = String(rawName).trim();
        if (!name) continue;
        const description = readRuleDescription(value);

        // 显式删除：描述为空 + 标记删除
        const isDelete = value && typeof value === 'object'
            && (value.删除 === true || value.delete === true || value.removed === true);
        if (isDelete || !description && description !== '' && value === null) {
            if (Object.hasOwn(chatData.rules, name)) {
                delete chatData.rules[name];
                result.removed.push(name);
            }
            continue;
        }
        if (!description) continue;

        if (Object.hasOwn(chatData.rules, name)) {
            if (chatData.rules[name].description !== description) {
                chatData.rules[name].description = description;
                chatData.rules[name].updatedAt = Date.now();
                result.updated.push(name);
            }
        } else {
            chatData.rules[name] = { description, enabled: true, updatedAt: Date.now() };
            result.added.push(name);
        }
    }
    return result;
}

/**
 * 替换推荐规则（先清空旧的，再写入新的）。
 * @returns {string[]} 新推荐规则名
 */
function applyRecommendedRules(chatData, recommendedRules) {
    chatData.recommendedRules = {};
    const record = normalizeRecord(recommendedRules);
    for (const [rawName, value] of Object.entries(record)) {
        const name = String(rawName).trim();
        if (!name) continue;
        const description = readRuleDescription(value);
        if (!description) continue;
        chatData.recommendedRules[name] = { description, updatedAt: Date.now() };
    }
    return Object.keys(chatData.recommendedRules);
}

/**
 * 合并单个角色的字段。只覆盖模型确实给出的字段，未给出的保持原值。
 * 字段名做了容错（去掉首尾空白、忽略大小写近似）。
 */
function applyCharacterFields(ctx, settings, name, fields) {
    if (!name || !fields || typeof fields !== 'object') return null;
    const allowedFields = getProfileFields(settings?.profileMode || PROFILE_MODES.SIMPLE);
    const allowedKeys = new Map(allowedFields.map((f) => [f.key, f]));
    // 常见别名容错
    const aliases = new Map([
        ['名称', '名字'],
        ['姓名', '名字'],
        ['与user的关系', '和user的关系'],
        ['和User的关系', '和user的关系'],
        ['和{{user}}的关系', '和user的关系'],
        ['淫乱程度', '淫乱化程度'],
        ['性癖', '性癖喜好'],
    ]);

    const patch = {};
    for (const [rawKey, rawValue] of Object.entries(fields)) {
        let key = String(rawKey).trim();
        if (key === '名字' || key === 'name') continue;
        if (aliases.has(key)) key = aliases.get(key);
        const fieldDef = allowedKeys.get(key);
        if (!fieldDef) continue;

        if (fieldDef.type === 'number') {
            const num = Number(rawValue);
            if (Number.isFinite(num)) patch[key] = num;
        } else {
            const text = firstStringValue(rawValue);
            if (text) patch[key] = text;
        }
    }
    if (Object.keys(patch).length === 0) return null;

    const entry = upsertCharacter(ctx, name, patch, SCOPES.LOCAL, settings);
    if (entry) entry.initialized = true;
    return { name, patch };
}

/**
 * 写入衣柜纪录。
 * @returns {{name:string, count:number}[]}
 */
function applyWardrobe(ctx, settings, wardrobe) {
    const record = normalizeRecord(wardrobe);
    const out = [];
    for (const [rawName, value] of Object.entries(record)) {
        const name = String(rawName).trim();
        if (!name) continue;
        const entries = Array.isArray(value) ? value : [value];
        let count = 0;
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') {
                const text = firstStringValue(entry);
                if (!text) continue;
                appendWardrobeEntry(ctx, name, { outfit: text }, settings);
                count += 1;
                continue;
            }
            // 字段名容错：模型可能用「穿着/装扮/服饰」等不同写法
            const outfit = String(
                entry.outfit || entry.服装 || entry.衣着 || entry.穿着 || entry.装扮
                || entry.服饰 || entry.描述 || entry.内容 || '',
            ).trim();
            if (!outfit) continue;
            appendWardrobeEntry(ctx, name, {
                time: String(entry.time || entry.时间 || entry.日期 || ''),
                scene: String(entry.scene || entry.场合 || entry.场景 || entry.地点 || ''),
                outfit,
            }, settings);
            count += 1;
        }
        if (count > 0) out.push({ name, count });
    }
    return out;
}

// ─────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────

/**
 * 把分析结果应用到聊天状态。
 *
 * @param {object} ctx 宿主 context
 * @param {object} result 模型返回的 JSON
 * @param {object} options
 * @param {string} options.sourceSignature 本次分析对应的消息签名
 * @returns {{
 *   applied: boolean,
 *   summary: string,
 *   worldState: string[],
 *   rules: {added:string[], updated:string[], removed:string[]},
 *   recommended: string[],
 *   characters: {name:string, patch:object}[],
 *   wardrobe: {name:string, count:number}[],
 *   skipped: string[],
 * }}
 */
export function applyAnalysisResult(ctx, result, options = {}) {
    const settings = getSettings(ctx);
    const chatData = getChatData(ctx, settings);
    const out = {
        applied: false,
        summary: '',
        worldState: [],
        rules: { added: [], updated: [], removed: [] },
        recommended: [],
        characters: [],
        wardrobe: [],
        skipped: [],
    };
    if (!result || typeof result !== 'object') {
        out.skipped.push('模型返回为空或非对象');
        return out;
    }

    // 世界状态
    if (settings?.trackWorldState !== false) {
        out.worldState = applyWorldState(chatData, result.world_state || result.世界状态);
    }

    // 世界规则
    if (settings?.trackWorldRules !== false) {
        out.rules = applyWorldRules(chatData, result.world_rules || result.世界规则 || result.rules);
    } else if (result.world_rules || result.世界规则) {
        out.skipped.push('世界规则（追踪已关闭）');
    }

    // 推荐规则
    if (settings?.trackRecommendRules !== false) {
        out.recommended = applyRecommendedRules(chatData, result.recommended_rules || result.推荐规则 || result.规则推荐栏);
    } else if (Object.keys(chatData.recommendedRules || {}).length > 0) {
        // 关闭追踪后，旧推荐不应继续留在界面上
        chatData.recommendedRules = {};
        out.recommended = [];
        out.skipped.push('推荐规则（追踪已关闭，已清空旧推荐）');
    }

    // 角色档案
    const characters = normalizeRecord(result.characters || result.角色列表);
    for (const [rawName, fields] of Object.entries(characters)) {
        const name = String(rawName).trim();
        if (!name) continue;
        const patch = applyCharacterFields(ctx, settings, name, fields);
        if (patch) out.characters.push(patch);
        else out.skipped.push(`角色「${name}」没有可用字段`);
    }

    // 衣柜
    if (settings?.trackWardrobe === true) {
        out.wardrobe = applyWardrobe(ctx, settings, result.wardrobe || result.角色衣柜);
    } else if (result.wardrobe || result.角色衣柜) {
        out.skipped.push('衣柜（追踪已关闭）');
    }

    // 简述
    const summary = firstStringValue(result.summary || result.简述 || result.总结);
    out.summary = summary;
    chatData.meta.lastSummary = summary;
    chatData.meta.lastRawResult = {
        worldState: out.worldState,
        rules: out.rules,
        recommended: out.recommended,
        characters: out.characters.map((item) => item.name),
        at: Date.now(),
    };
    chatData.meta.lastRunAt = Date.now();
    if (options.sourceSignature) {
        chatData.meta.lastProcessedSignature = String(options.sourceSignature);
    }
    chatData.meta.lastFailedSignature = '';

    out.applied = out.worldState.length > 0
        || out.rules.added.length > 0
        || out.rules.updated.length > 0
        || out.rules.removed.length > 0
        || out.recommended.length > 0
        || out.characters.length > 0
        || out.wardrobe.length > 0;

    saveSettings(ctx);
    return out;
}

/**
 * 生成一句话描述本轮变化（用于提示与界面）。
 */
export function describeApplied(out) {
    if (!out) return '无结果';
    const parts = [];
    if (out.worldState.length > 0) parts.push(`世界状态 ${out.worldState.join('/')}`);
    if (out.rules.added.length > 0) parts.push(`新增规则 ${out.rules.added.length}`);
    if (out.rules.updated.length > 0) parts.push(`更新规则 ${out.rules.updated.length}`);
    if (out.rules.removed.length > 0) parts.push(`删除规则 ${out.rules.removed.length}`);
    if (out.recommended.length > 0) parts.push(`推荐 ${out.recommended.length} 条`);
    if (out.characters.length > 0) parts.push(`角色 ${out.characters.map((c) => c.name).join('、')}`);
    if (out.wardrobe.length > 0) parts.push(`衣柜 ${out.wardrobe.length} 人`);
    if (parts.length === 0) parts.push('本轮无变化');
    return parts.join('，');
}

export { MODULE_NAME };
