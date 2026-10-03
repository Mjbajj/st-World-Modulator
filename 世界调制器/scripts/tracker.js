/**
 * World Modulator —— 追踪管道
 *
 * 职责：判断「主模型是否刚说完一段完整的话」→ 调用分析模型 → 应用结果 → 重新注入提示词。
 *
 * 设计要点（参考 BS BioTracker 的踩坑经验）：
 *   1. 不用 GENERATION_ENDED 直接触发：流式输出期间消息是半成品。
 *      改用「内容签名连续稳定 settleMs 毫秒」作为完成判据。
 *   2. 轮询驱动，但用运行锁 + 看门狗防止并发与死锁。
 *   3. 处理进度用消息签名记录，只有内容变化才重新分析。
 *   4. 失败时若对话未变化则暂停自动重试，避免无限重发。
 */

import { MODULE_NAME, PROFILE_MODES, buildAnalyzerSystemPrompt } from './prompts.js';
import { callAnalyzer, recordDebugRequest } from './api.js';
import { applyAnalysisResult, describeApplied } from './tools.js';
import { applyInjection } from './inject.js';
import {
    DEFAULT_ANALYZER_PROMPT_WRAPPER,
    buildRecentMessages,
    buildSignature,
    describeCharactersForPrompt,
    getChatData,
    getMergedCharacters,
    getMergedRules,
    getSettings,
    saveSettings,
} from './state.js';

export const POLL_RUNTIME_KEY = `__${MODULE_NAME}_poll__`;
export const RUN_RUNTIME_KEY = `__${MODULE_NAME}_running__`;
export const RUN_STARTED_AT_KEY = `__${MODULE_NAME}_running_at__`;
export const UPDATE_CUE_EVENT = `${MODULE_NAME}:update-cue`;

/** 看门狗余量 */
const WATCHDOG_MARGIN_MS = 60000;
/** 运行锁超时自愈上限 */
const RUN_STALE_MS = 10 * 60 * 1000;
/** 单次运行内最多连续处理的消息条数，防止长对话卡死 */
const MAX_MESSAGES_PER_RUN = 5;

/** 运行状态（挂全局便于在控制台排查） */
const runState = {
    running: false,
    startedAt: 0,
    lastError: '',
    lastResult: null,
};
globalThis[`__${MODULE_NAME}_debug_run__`] = runState;

/** 上一次正文稳定检测的快照 */
let settleSnapshot = { signature: '', at: 0 };

// ─────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────

function getChat(ctx) {
    return Array.isArray(ctx?.chat) ? ctx.chat : [];
}

function markProgress() {
    globalThis[RUN_STARTED_AT_KEY] = Date.now();
}

function isRunStale() {
    const started = Number(globalThis[RUN_STARTED_AT_KEY]);
    if (!Number.isFinite(started) || started <= 0) return true;
    return Date.now() - started > RUN_STALE_MS + WATCHDOG_MARGIN_MS;
}

/** 正文稳定判定：只看最后一条是否为 AI 消息且有内容，且签名稳定 */
export function isAssistantMessageSettled(ctx, settings, advance = true) {
    const chat = getChat(ctx);
    const last = chat[chat.length - 1];
    if (!last || last.is_user) return false;
    const text = String(last.mes || '');
    if (!text.trim()) return false;

    const signature = buildSignature(ctx, chat.length);
    const now = Date.now();
    const settleMs = Math.max(100, Number(settings?.settleMs) || 1400);

    if (settleSnapshot.signature !== signature) {
        if (advance) settleSnapshot = { signature, at: now };
        return false;
    }
    return now - settleSnapshot.at >= settleMs;
}

/** 重置稳定检测（切换聊天、手动触发时调用） */
export function resetSettle() {
    settleSnapshot = { signature: '', at: 0 };
}

/** 是否存在待处理的新内容 */
function hasPendingContent(ctx, chatData) {
    const chat = getChat(ctx);
    if (chat.length === 0) return false;
    const processed = String(chatData?.meta?.lastProcessedSignature || '');
    if (!processed) return true;
    return buildSignature(ctx, chat.length) !== processed;
}

/** 失败拦截：对话没变就别重试 */
function isFailedRetryBlocked(ctx, chatData) {
    const chat = getChat(ctx);
    if (chat.length === 0) return false;
    const failed = String(chatData?.meta?.lastFailedSignature || '');
    if (!failed) return false;
    return failed === buildSignature(ctx, chat.length);
}

function emitCue(detail) {
    try {
        globalThis.dispatchEvent?.(new CustomEvent(UPDATE_CUE_EVENT, { detail }));
    } catch { /* ignore */ }
}

// ─────────────────────────────────────────────
// 载荷组装
// ─────────────────────────────────────────────

/**
 * 组装发给分析模型的载荷。
 */
export function buildPayload(ctx, settings, endIndexExclusive = null) {
    const chatData = getChatData(ctx, settings);
    const recentMessages = buildRecentMessages(ctx, settings, endIndexExclusive);
    const rules = getMergedRules(ctx, settings);
    const characters = getMergedCharacters(ctx, settings);

    const payload = {
        recent_messages: recentMessages,
        world_state: { ...chatData.worldState },
        world_rules: Object.fromEntries(
            Object.entries(rules)
                .filter(([, rule]) => rule?.enabled !== false)
                .map(([name, rule]) => [name, { 规则描述: rule.description }]),
        ),
        characters: describeCharactersForPrompt(characters, settings?.profileMode || PROFILE_MODES.SIMPLE),
        recommend_enabled: settings?.trackRecommendRules !== false,
        wardrobe_enabled: settings?.trackWardrobe === true,
        instructions: String(settings?.analyzerWrapper || DEFAULT_ANALYZER_PROMPT_WRAPPER),
    };

    if (settings?.trackWardrobe === true) {
        payload.wardrobe = Object.fromEntries(
            Object.entries(chatData.wardrobe || {}).map(([name, entries]) => [
                name,
                Array.isArray(entries) ? entries.slice(-5) : [],
            ]),
        );
    }

    return payload;
}

/** 取用户名（用于提示词里的 {{user}} 说明） */
function getUserName(ctx) {
    try {
        const name = String(ctx?.name1 || '').trim();
        return name || 'user';
    } catch {
        return 'user';
    }
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

/**
 * 处理单条消息：调用分析模型并应用结果。
 * @returns {Promise<{triggered:boolean, applied?:boolean, reason?:string, detail?:object}>}
 */
async function processMessage(ctx, settings, chatData, messageIndex, reason) {
    const chat = getChat(ctx);
    const signature = buildSignature(ctx, messageIndex + 1);

    const systemPrompt = buildAnalyzerSystemPrompt({
        profileMode: settings?.profileMode || PROFILE_MODES.SIMPLE,
        rulesEnabled: settings?.trackWorldRules !== false,
        recommendEnabled: settings?.trackRecommendRules !== false,
        wardrobeEnabled: settings?.trackWardrobe === true,
        userName: getUserName(ctx),
    });
    const payload = buildPayload(ctx, settings, messageIndex + 1);

    recordDebugRequest({ reason, messageIndex, systemPrompt, payload });

    const result = await callAnalyzer(settings, ctx, { systemPrompt, payload });

    // 请求往返期间聊天若被改动，本次结果作废
    const postSignature = buildSignature(ctx, messageIndex + 1);
    if (postSignature !== signature) {
        console.warn(`[${MODULE_NAME}] 分析期间聊天内容变化，本次结果作废。`);
        chatData.meta.lastFailedSignature = '';
        saveSettings(ctx);
        return { triggered: true, applied: false, reason: 'message_changed' };
    }

    const applied = applyAnalysisResult(ctx, result, { sourceSignature: signature });
    return { triggered: true, applied: applied.applied, detail: applied };
}

/**
 * 执行一次追踪。
 * @param {object} ctx
 * @param {'manual'|'poll'} reason
 * @param {object} deps 界面回调 { renderPanel, notify }
 * @returns {Promise<object>}
 */
export async function runTracker(ctx, reason = 'manual', deps = {}) {
    const settings = getSettings(ctx);
    if (!settings) return { skipped: true, reason: 'no_settings' };

    const chatData = getChatData(ctx, settings);
    const chat = getChat(ctx);

    if (chat.length === 0) {
        return { skipped: true, reason: 'empty_chat' };
    }

    // 运行锁
    if (runState.running) {
        if (!isRunStale()) {
            return { skipped: true, reason: 'already_running' };
        }
        console.warn(`[${MODULE_NAME}] 上一轮追踪超时未结束，强制释放运行锁。`);
        runState.running = false;
    }
    // 总开关（手动触发不受限）
    if (reason === 'poll' && settings.enabled !== true) {
        return { skipped: true, reason: 'disabled' };
    }

    runState.running = true;
    runState.startedAt = Date.now();
    runState.lastError = '';
    markProgress();

    try {
        // 确定起点
        let startIndex;
        if (reason === 'manual') {
            startIndex = Math.max(0, chat.length - 1);
        } else {
            const processed = String(chatData.meta.lastProcessedSignature || '');
            let resume = 0;
            if (processed) {
                for (let count = chat.length; count >= 1; count -= 1) {
                    if (buildSignature(ctx, count) === processed) {
                        resume = count;
                        break;
                    }
                }
            } else {
                // 从未处理过：只处理最近 contextSize 条，不从头跑整个聊天
                resume = Math.max(0, chat.length - Math.max(1, Number(settings.contextSize) || 12));
            }
            startIndex = resume;
        }

        if (startIndex >= chat.length) {
            return { skipped: true, reason: 'no_pending' };
        }

        let processedCount = 0;
        let changedCount = 0;
        const details = [];

        const end = Math.min(chat.length, startIndex + MAX_MESSAGES_PER_RUN);
        for (let index = startIndex; index < end; index += 1) {
            markProgress();
            const outcome = await processMessage(ctx, settings, chatData, index, reason);
            processedCount += 1;
            if (outcome?.detail?.applied) {
                changedCount += 1;
                details.push(describeApplied(outcome.detail));
            }
            if (outcome?.reason === 'message_changed') break;
        }

        // 注入最新状态
        applyInjection(ctx);

        runState.lastResult = { processedCount, changedCount, details };
        emitCue({ reason, processedCount, changedCount });

        deps.renderPanel?.(ctx);
        if (changedCount > 0) {
            deps.notify?.(`已更新 ${changedCount} 处`, 'success');
        } else if (reason === 'manual') {
            deps.notify?.('本轮无状态变化', 'info');
        }
        return { skipped: false, processedCount, changedCount };
    } catch (error) {
        runState.lastError = String(error?.message || error);
        chatData.meta.lastFailedSignature = buildSignature(ctx, chat.length);
        saveSettings(ctx);
        console.error(`[${MODULE_NAME}] 追踪失败`, error);
        deps.notify?.(`分析失败：${runState.lastError}`, 'error');
        deps.renderPanel?.(ctx);
        throw error;
    } finally {
        runState.running = false;
        globalThis[RUN_STARTED_AT_KEY] = 0;
        if (runState.running === false) {
            globalThis[RUN_RUNTIME_KEY] = null;
        }
        deps.renderPanel?.(ctx);
    }
}

/**
 * 轮询入口：判断是否该自动分析。
 */
export async function poll(ctx, deps = {}) {
    const settings = getSettings(ctx);
    if (!settings) return { skipped: true, reason: 'no_settings' };
    if (settings.enabled !== true) return { skipped: true, reason: 'disabled' };
    if (runState.running) return { skipped: true, reason: 'already_running' };

    const chatData = getChatData(ctx, settings);

    if (!isAssistantMessageSettled(ctx, settings, true)) {
        return { skipped: true, reason: 'not_settled' };
    }
    if (!hasPendingContent(ctx, chatData)) {
        return { skipped: true, reason: 'no_pending' };
    }
    if (isFailedRetryBlocked(ctx, chatData)) {
        return { skipped: true, reason: 'failed_blocked' };
    }

    try {
        return await runTracker(ctx, 'poll', deps);
    } catch {
        return { skipped: true, reason: 'error' };
    }
}

/** 启动轮询 */
export function startPolling(ctx, deps = {}) {
    stopPolling();
    const settings = getSettings(ctx);
    const interval = Math.max(800, Number(settings?.pollMs) || 1800);
    globalThis[POLL_RUNTIME_KEY] = setInterval(() => {
        poll(ctx, deps).catch((error) => console.error(`[${MODULE_NAME}] poll 失败`, error));
    }, interval);
}

/** 停止轮询 */
export function stopPolling() {
    if (globalThis[POLL_RUNTIME_KEY]) {
        clearInterval(globalThis[POLL_RUNTIME_KEY]);
        globalThis[POLL_RUNTIME_KEY] = null;
    }
}

/** 轮询是否在运行 */
export function isPolling() {
    return Boolean(globalThis[POLL_RUNTIME_KEY]);
}

/** 当前是否正在分析 */
export function isRunning() {
    return runState.running;
}

/** 取运行状态（界面显示） */
export function getRunState() {
    return { ...runState };
}
