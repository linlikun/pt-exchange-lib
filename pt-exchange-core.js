/* =========================================================================
 * PT Exchange Core v1.0.1
 * 共享核心库：主题 / UI / 自动兑换 / 历史 / 配置存储 / 工具
 *
 * v1.0.1 修复：
 *   - [Bug]  多并列最佳时点击非首个卡片错误弹出 qtyInput 提示
 *   - [Bug]  checkPendingExchange 未校验站点，跨站可能误判兑换成功
 *   - [Fix]  siteKey 改用 host 优先，避免同名站点配置串号
 *   - [Opt]  getAutoConfig 加内存缓存，减少 localStorage 读取
 *   - [Opt]  injectUI 在 body 兜底时改为 appendChild，避免面板插到页面顶部
 *   - [Opt]  面板 ID 支持配置化；CSS 选择器改用 .kf-exchange-panel
 *   - [New]  暴露 assertVersion() 供主脚本做版本校验
 * ========================================================================= */
(function () {
    'use strict';

    var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    if (W.KFExchange) return;

    var DEBUG = true;
    function log() { if (DEBUG) { try { console.log.apply(console, arguments); } catch (e) {} } }

    // ============================================================
    // 常量
    // ============================================================
    var DEFAULT_AUTO_ENABLED = false;
    var DEFAULT_AUTO_INTERVAL = 11000;
    var DEFAULT_RESERVE_BONUS = 0;
    var DEFAULT_THEME = 'cyber';
    var DEFAULT_PANEL_ID = 'exchange-assistant-panel';
    var PANEL_CLASS = 'kf-exchange-panel';   // 固定 class，用于 CSS 选择器

    var STORAGE_AUTO_CONFIG = 'exchange_auto_config';
    var STORAGE_AUTO_CONFIG_PREFIX = 'exchange_auto_config::';
    var STORAGE_UPLOAD_LIMIT = 'kf_upload_limit_tb';
    var STORAGE_UPLOAD_LIMIT_PREFIX = 'exchange_upload_limit::';
    var STORAGE_THEME = 'exchange_theme';
    var STORAGE_HR_CONFIG_PREFIX = 'exchange_hr_config::';
    var STORAGE_HR_VERSION_KEY = 'kf_hr_config_version';
    var HR_CONFIG_VERSION = 2;
    var DEFAULT_HR_MAX_COUNT = 0;
    var DEFAULT_HR_PER_COST = 0;

    var STORAGE_PENDING = 'exchange_assistant_pending';
    var STORAGE_HISTORY = 'exchange_assistant_history';
    var MAX_HISTORY = 20;
    var PENDING_TIMEOUT = 3600000;

    var THEMES = {
        cyber:       { name: '赛博霓虹', icon: '⚡', desc: '深色背景 + 霓虹光效',   className: 'kf-theme-cyber' },
        elegant:     { name: '淡雅',     icon: '🌸', desc: '纯色柔和 · 清爽简约',   className: 'kf-theme-elegant' },
        neumorphism: { name: '金币质感', icon: '🪙', desc: '暖金光泽 · 货币风格', className: 'kf-theme-neumorphism' }
    };

    // ============================================================
    // 工具函数
    // ============================================================
    function parseSizeToGB(sizeStr) {
        if (!sizeStr) return 0;
        var m = String(sizeStr).match(/^([\d,]+\.?[\d]*)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|T|G|M|K)/i);
        if (!m) return 0;
        var v = parseFloat(m[1].replace(/,/g, ''));
        var u = m[2].toUpperCase();
        if (u === 'TB' || u === 'TIB' || u === 'T') return v * 1024;
        if (u === 'GB' || u === 'GIB' || u === 'G') return v;
        if (u === 'MB' || u === 'MIB' || u === 'M') return v / 1024;
        if (u === 'KB' || u === 'KIB' || u === 'K') return v / 1024 / 1024;
        return v;
    }

    function formatGB(GB) {
        if (!isFinite(GB) || GB < 0) return '0 GB';
        if (GB >= 1024) { var s = (GB / 1024).toFixed(2).replace(/\.?0+$/, ''); return s + ' TB'; }
        if (GB >= 1)    { var s2 = GB.toFixed(2).replace(/\.?0+$/, '');       return s2 + ' GB'; }
        return (GB * 1024).toFixed(2).replace(/\.?0+$/, '') + ' MB';
    }

    function fmtSize(config, gb, digits) {
        digits = typeof digits === 'number' ? digits : 1;
        var uGB = (config && config.sizeUnitGB) || 'GB';
        var uTB = (config && config.sizeUnitTB) || 'TB';
        if (!isFinite(gb) || gb < 0) return '0 ' + uGB;
        var s = gb >= 1024 ? (gb / 1024).toFixed(digits) + ' ' + uTB : gb.toFixed(digits) + ' ' + uGB;
        return s.replace(/(\.\d*?)0+(?=\s)/, '$1').replace(/\.(?=\s)/, '');
    }

    function getCsrfToken() {
        var meta = document.querySelector('meta[name="x-csrf-token"]')
                || document.querySelector('meta[name="csrf-token"]')
                || document.querySelector('meta[name="_token"]');
        if (meta) { var v = meta.getAttribute('content') || meta.content || ''; if (v) return v; }
        var m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    }

    function getSiteFavicon() {
        var link = document.querySelector('link[rel*="icon"]') || document.querySelector('link[rel="shortcut icon"]');
        return (link && link.href) ? link.href : (window.location.origin + '/favicon.ico');
    }

    // ============================================================
    // siteKey：[Fix] 优先使用 host（保证唯一），无 host 时回落到 name
    // ============================================================
    function siteKey(prefix, siteConfig) {
        var id;
        if (siteConfig && siteConfig.host) {
            id = String(siteConfig.host).toLowerCase();
        } else if (siteConfig && siteConfig.name) {
            id = String(siteConfig.name).toLowerCase().replace(/\s+/g, '_');
        } else {
            // 最终回落到 location.hostname，避免 '__global__' 互相覆盖
            id = (window.location && window.location.hostname) || '__global__';
        }
        return prefix + id;
    }

    function getTheme() { try { var r = localStorage.getItem(STORAGE_THEME); if (r && THEMES[r]) return r; } catch (e) {} return DEFAULT_THEME; }
    function saveTheme(t) { if (THEMES[t]) try { localStorage.setItem(STORAGE_THEME, t); } catch (e) {} }
    function formatTime(ts) { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }

    // ============================================================
    // 自动兑换配置（[Opt] 增加内存缓存）
    // ============================================================
    var _autoCfgCache = {};   // { key: cfgObj }

    function getAutoConfig(siteConfig, siteDefaultReserve, siteDefaultInterval, lockInterval) {
        var key = siteKey(STORAGE_AUTO_CONFIG_PREFIX, siteConfig);
        var cacheKey = key + '|' + (siteDefaultReserve || 0) + '|' + (siteDefaultInterval || 0) + '|' + (lockInterval ? 1 : 0);
        if (_autoCfgCache[cacheKey]) return _autoCfgCache[cacheKey];

        var defReserve  = typeof siteDefaultReserve === 'number' && siteDefaultReserve >= 0 ? siteDefaultReserve : DEFAULT_RESERVE_BONUS;
        var defInterval = typeof siteDefaultInterval === 'number' && siteDefaultInterval > 0 ? siteDefaultInterval : DEFAULT_AUTO_INTERVAL;
        var defEnabled  = (siteConfig && typeof siteConfig.defaultAutoEnabled === 'boolean') ? siteConfig.defaultAutoEnabled : DEFAULT_AUTO_ENABLED;
        var normalize = function (cfg) {
            return {
                enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : defEnabled,
                interval: (lockInterval && siteDefaultInterval > 0) ? defInterval : (typeof cfg.interval === 'number' && cfg.interval > 0 ? cfg.interval : defInterval),
                reserveBonus: typeof cfg.reserveBonus === 'number' && cfg.reserveBonus >= 0 ? cfg.reserveBonus : defReserve
            };
        };
        var result;
        try {
            var raw = localStorage.getItem(key);
            if (raw) result = normalize(JSON.parse(raw));
        } catch (e) {}
        if (!result) result = { enabled: defEnabled, interval: defInterval, reserveBonus: defReserve };
        _autoCfgCache[cacheKey] = result;
        return result;
    }

    function saveAutoConfig(siteConfig, c) {
        try { localStorage.setItem(siteKey(STORAGE_AUTO_CONFIG_PREFIX, siteConfig), JSON.stringify(c)); } catch (e) {}
        // 失效缓存
        var prefix = siteKey(STORAGE_AUTO_CONFIG_PREFIX, siteConfig);
        Object.keys(_autoCfgCache).forEach(function (k) {
            if (k.indexOf(prefix + '|') === 0) delete _autoCfgCache[k];
        });
    }

    function getUploadLimit(siteConfig) {
        var key = siteKey(STORAGE_UPLOAD_LIMIT_PREFIX, siteConfig);
        try { var v = parseFloat(localStorage.getItem(key)); if (!isNaN(v) && v > 0) return v; } catch (e) {}
        if (siteConfig && typeof siteConfig.defaultUploadLimitTB === 'number') return siteConfig.defaultUploadLimitTB;
        return (siteConfig && siteConfig.uploadLimitTB) || 24;
    }
    function saveUploadLimit(siteConfig, v) {
        try { localStorage.setItem(siteKey(STORAGE_UPLOAD_LIMIT_PREFIX, siteConfig), String(v)); } catch (e) {}
    }

    // ============================================================
    // H&R 配置
    // ============================================================
    function migrateHrConfigOnce() {
        try {
            var cur = parseInt(localStorage.getItem(STORAGE_HR_VERSION_KEY) || '1', 10);
            if (cur >= HR_CONFIG_VERSION) return;
            var toRemove = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf(STORAGE_HR_CONFIG_PREFIX) === 0) toRemove.push(k);
            }
            toRemove.forEach(function (k) { localStorage.removeItem(k); });
            localStorage.setItem(STORAGE_HR_VERSION_KEY, String(HR_CONFIG_VERSION));
        } catch (e) {}
    }

    function getHrConfig(siteConfig) {
        var defaults = (siteConfig && siteConfig.hrConfig) || {};
        var defMax  = typeof defaults.maxCount === 'number' && defaults.maxCount >= 0 ? defaults.maxCount : DEFAULT_HR_MAX_COUNT;
        var defCost = typeof defaults.perCost === 'number' && defaults.perCost >= 0 ? defaults.perCost : DEFAULT_HR_PER_COST;
        var key = siteKey(STORAGE_HR_CONFIG_PREFIX, siteConfig);
        try {
            var raw = localStorage.getItem(key);
            if (raw) {
                var cfg = JSON.parse(raw);
                return {
                    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : false,
                    maxCount: typeof cfg.maxCount === 'number' && cfg.maxCount >= 0 ? cfg.maxCount : defMax,
                    perCost:  typeof cfg.perCost  === 'number' && cfg.perCost  >= 0 ? cfg.perCost  : defCost
                };
            }
        } catch (e) {}
        return { enabled: false, maxCount: defMax, perCost: defCost };
    }
    function saveHrConfig(siteConfig, c) {
        try { localStorage.setItem(siteKey(STORAGE_HR_CONFIG_PREFIX, siteConfig), JSON.stringify(c)); } catch (e) {}
    }
    function getHrReserveMin(siteConfig) {
        var cfg = getHrConfig(siteConfig);
        if (!cfg.enabled) return 0;
        return Math.max(0, (cfg.maxCount || 0) * (cfg.perCost || 0));
    }

    function cleanupLegacyGlobalKeys() {
        try {
            if (localStorage.getItem(STORAGE_AUTO_CONFIG) !== null) {
                log('[Core] 清理旧全局 key：exchange_auto_config');
                localStorage.removeItem(STORAGE_AUTO_CONFIG);
            }
            if (localStorage.getItem(STORAGE_UPLOAD_LIMIT) !== null) {
                log('[Core] 清理旧全局 key：kf_upload_limit_tb');
                localStorage.removeItem(STORAGE_UPLOAD_LIMIT);
            }
        } catch (e) {}
    }

    // ============================================================
    // 历史记录 / Pending
    // ============================================================
    function getPendingExchange() { try { var d = localStorage.getItem(STORAGE_PENDING); return d ? JSON.parse(d) : null; } catch (e) { return null; } }
    function savePendingExchange(r) { try { localStorage.setItem(STORAGE_PENDING, JSON.stringify(r)); } catch (e) {} }
    function clearPendingExchange() { try { localStorage.removeItem(STORAGE_PENDING); } catch (e) {} }

    function getHistory(site) {
        try {
            var d = localStorage.getItem(STORAGE_HISTORY);
            var all = d ? JSON.parse(d) : [];
            return site ? all.filter(function (h) { return h.site === site; }) : all;
        } catch (e) { return []; }
    }
    function addHistoryRecord(site, record) {
        var h = getHistory();
        h.unshift(Object.assign({ timestamp: Date.now(), site: site }, record));
        if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
        try { localStorage.setItem(STORAGE_HISTORY, JSON.stringify(h)); } catch (e) {}
    }

    // ============================================================
    // checkPendingExchange：[Fix] 增加站点校验，避免跨站误判
    //   调用方需传入 currentSite（推荐传 config.name 或 config.host）
    //   如果不传，保持向后兼容，仅做时间/增量校验
    // ============================================================
    function checkPendingExchange(currentUploadGB, currentSite) {
        var pending = getPendingExchange(); if (!pending) return null;
        if (Date.now() - pending.timestamp > PENDING_TIMEOUT) { clearPendingExchange(); return null; }
        // 站点不匹配：直接跳过（不清除 pending，避免影响原本站点的检测）
        if (currentSite && pending.site && currentSite !== pending.site) return null;
        var inc = currentUploadGB - pending.uploadGB;
        if (inc > 0.01) {
            addHistoryRecord(pending.site, {
                sizeGB: pending.option.sizeGB,
                increaseGB: inc,
                price: pending.option.price,
                efficiency: pending.option.efficiency
            });
            clearPendingExchange();
            return { increaseGB: inc, option: pending.option, previousUploadGB: pending.uploadGB };
        }
        return null;
    }

    // ============================================================
    // 数量推荐（拾刻类站点）
    // ============================================================
    function computeQtyRecommendation(config, userData) {
        var qi = config.qtyInput; if (!qi) return null;
        var ratioLimit    = qi.ratioLimit || 3;
        var uploadLimitGB = qi.uploadLimitGB || 10;
        var unitPrice     = qi.unitPrice || 1000;
        var discountAt    = qi.discountAt || 10;
        var discountRate  = qi.discountRate || 0.9;
        var unitSizeGB    = qi.unitSizeGB || 1;
        var step          = qi.step || 10;
        var ratio    = userData.ratio;
        var uploadGB = userData.uploadGB;
        var downloadGB = userData.downloadGB;
        var bonus    = userData.currentBonus;

        if (ratio > ratioLimit && uploadGB > uploadLimitGB) {
            var nd = Math.max(0, uploadGB / ratioLimit - downloadGB);
            return { qty: 0, blocked: true, needDownload: nd, reason: '需先下载 ' + formatGB(nd) + ' 使分享率降至 ' + ratioLimit + ' 以下' };
        }
        var maxByRatio = 0;
        if (downloadGB > 0) maxByRatio = Math.floor((ratioLimit * downloadGB - uploadGB) / unitSizeGB);
        maxByRatio = Math.max(0, maxByRatio);
        var costPerStep = Math.round(step * unitPrice * discountRate);
        var maxByBonus = 0;
        if (bonus >= costPerStep) maxByBonus = Math.floor(bonus / costPerStep) * step;
        else if (bonus >= unitPrice) maxByBonus = Math.min(discountAt - 1, Math.floor(bonus / unitPrice));
        var maxQty = Math.min(maxByRatio, maxByBonus);
        maxQty = Math.floor(maxQty / step) * step;
        var cost = maxQty >= discountAt ? Math.round(maxQty * unitPrice * discountRate) : maxQty * unitPrice;
        return { qty: maxQty, blocked: false, cost: cost, maxByRatio: maxByRatio, maxByBonus: maxByBonus };
    }

    // ============================================================
    // KEEPFRDS 辅助
    // ============================================================
    function getKeepfrdsRequiredRatio(level, downloadGB) {
        var map = {
            'User': 1.0, 'Power User': 1.0, 'Elite User': 1.5, 'Crazy User': 2.0,
            'Insane User': 2.5, 'Veteran User': 3.5, 'Extreme User': 4.0,
            'Ultimate User': 4.5, 'Nexus Master': 5.0
        };
        if (map[level] !== undefined) return map[level];
        if (downloadGB > 800) return 0.8;
        if (downloadGB > 400) return 0.7;
        if (downloadGB > 200) return 0.6;
        if (downloadGB > 100) return 0.5;
        return 0.4;
    }

    // ============================================================
    // 主题样式注入
    //   [Opt] 所有 #exchange-assistant-panel 已改为 .kf-exchange-panel
    // ============================================================
    function injectThemeStyles() {
        if (document.getElementById('kf-theme-styles')) return;
        var style = document.createElement('style');
        style.id = 'kf-theme-styles';
        style.textContent = `
            .kf-dashboard {
                border-radius: 16px !important;
                padding: 20px !important;
                margin: 16px 0 !important;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important;
                position: relative !important;
                animation: kf-slide-in 0.4s ease-out !important;
                color: #f8fafc !important;
                width: auto !important;
                max-width: 100% !important;
                box-sizing: border-box !important;
                transition: all 0.4s ease !important;
            }
            .kf-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; position: relative; z-index: 1; gap: 10px; flex-wrap: wrap; }
            .kf-title { font-size: 15px; font-weight: 600; letter-spacing: 0.3px; display: flex; align-items: center; gap: 6px; }
            .kf-title img { width: 20px; height: 20px; border-radius: 4px; background: rgba(255,255,255,0.1); flex-shrink: 0; }
            .kf-theme-select { background: rgba(255,255,255,0.08) !important; border: 1px solid rgba(255,255,255,0.15) !important; border-radius: 6px !important; color: #f8fafc !important; padding: 4px 10px; font-size: 13px; font-weight: 500; cursor: pointer; outline: none; transition: border-color 0.2s, background 0.2s; backdrop-filter: blur(4px); max-width: 160px; box-sizing: border-box; color-scheme: dark; }
            .kf-theme-select:hover { border-color: rgba(255,255,255,0.3) !important; background: rgba(255,255,255,0.12) !important; }
            .kf-theme-select:focus { border-color: #8b5cf6 !important; }
            .kf-theme-select option { background: #1e1b4b !important; color: #f8fafc !important; }
            .kf-exchange-panel.kf-theme-elegant .kf-theme-select { background: #ffffff !important; border-color: #e2e8f0 !important; color: #1e293b !important; color-scheme: light; }
            .kf-exchange-panel.kf-theme-elegant .kf-theme-select option { background: #ffffff !important; color: #1e293b !important; }
            .kf-exchange-panel.kf-theme-elegant .kf-theme-select:hover { border-color: #cbd5e1 !important; background: #f8fafc !important; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-theme-select { background: #e8e8e8 !important; border: none !important; box-shadow: inset 2px 2px 4px #b8b8b8, inset -2px -2px 4px #ffffff !important; color: #2d2d2d !important; color-scheme: light; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-theme-select option { background: #e8e8e8 !important; color: #2d2d2d !important; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-theme-select:hover { box-shadow: inset 1px 1px 2px #b8b8b8, inset -1px -1px 2px #ffffff !important; }
            .kf-status { display: flex; align-items: center; gap: 8px; padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; background: rgba(16,185,129,0.12); color: #34d399; border: 1px solid rgba(16,185,129,0.3); white-space: nowrap; }
            .kf-status.blocked { background: rgba(239,68,68,0.12); color: #f87171; border-color: rgba(239,68,68,0.3); }
            .kf-status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: kf-breathe 2s ease-in-out infinite; }
            .kf-theme-cyber { background: linear-gradient(145deg, #0a0a0a 0%, #1a0a2e 50%, #0a0a0a 100%) !important; border: 1px solid rgba(255,0,255,0.2) !important; box-shadow: 0 0 40px rgba(255,0,255,0.08), inset 0 0 60px rgba(0,255,255,0.03) !important; }
            .kf-theme-cyber::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,0,255,0.02) 2px, rgba(255,0,255,0.02) 4px); pointer-events: none; z-index: 0; }
            .kf-theme-cyber .kf-stat-card { background: rgba(0,0,0,0.5) !important; border: 1px solid rgba(255,0,255,0.15) !important; box-shadow: 0 0 15px rgba(255,0,255,0.05) !important; transition: all 0.3s; }
            .kf-theme-cyber .kf-stat-card:hover { border-color: rgba(0,255,255,0.4) !important; box-shadow: 0 0 30px rgba(0,255,255,0.1) !important; transform: translateY(-2px); }
            .kf-theme-cyber .kf-best-card { background: linear-gradient(135deg, rgba(255,0,255,0.08), rgba(0,255,255,0.05)) !important; border: 2px solid #ff00ff !important; box-shadow: 0 0 40px rgba(255,0,255,0.15), inset 0 0 40px rgba(0,255,255,0.05) !important; animation: cyber-pulse 3s ease-in-out infinite !important; }
            .kf-theme-cyber .kf-best-card.blocked { border-color: #ff4444 !important; box-shadow: 0 0 40px rgba(255,68,68,0.2) !important; animation: cyber-pulse-red 2s ease-in-out infinite !important; }
            .kf-theme-cyber .kf-best-left-bar { background: linear-gradient(180deg, #ff00ff, #00ffff) !important; }
            .kf-theme-cyber .kf-badge { background: linear-gradient(135deg, #ff00ff, #00ffff) !important; color: #0a0a0a !important; box-shadow: 0 0 20px rgba(255,0,255,0.4) !important; }
            .kf-theme-cyber .kf-btn-primary { background: linear-gradient(135deg, #ff00ff, #00ffff) !important; color: #0a0a0a !important; box-shadow: 0 4px 20px rgba(255,0,255,0.3) !important; font-weight: 700 !important; }
            .kf-theme-cyber .kf-btn-primary:hover { box-shadow: 0 0 40px rgba(255,0,255,0.5) !important; transform: scale(1.02); }
            .kf-theme-cyber .kf-option-card { background: rgba(0,0,0,0.4) !important; border: 1px solid rgba(255,0,255,0.1) !important; }
            .kf-theme-cyber .kf-option-card:hover { border-color: rgba(0,255,255,0.3) !important; transform: translateX(4px); }
            .kf-theme-cyber .kf-history-toggle { background: rgba(0,0,0,0.4) !important; border: 1px solid rgba(255,0,255,0.1) !important; }
            .kf-theme-cyber .kf-history-toggle:hover { background: rgba(0,0,0,0.6) !important; border-color: rgba(0,255,255,0.2) !important; }
            .kf-theme-cyber .kf-auto-config { background: rgba(0,0,0,0.4) !important; border: 1px solid rgba(255,0,255,0.1) !important; }
            .kf-theme-elegant { background: #f5f7fa !important; border: 1px solid #e2e8f0 !important; box-shadow: 0 4px 16px rgba(0,0,0,0.06) !important; color: #1e293b !important; }
            .kf-theme-elegant .kf-stat-card { background: #ffffff !important; border: 1px solid #eef2f6 !important; box-shadow: 0 1px 3px rgba(0,0,0,0.04) !important; transition: all 0.2s; }
            .kf-theme-elegant .kf-stat-card:hover { border-color: #cbd5e1 !important; box-shadow: 0 4px 12px rgba(0,0,0,0.06) !important; transform: translateY(-1px); }
            .kf-theme-elegant .kf-stat-label { color: #64748b !important; }
            .kf-theme-elegant .kf-stat-value { color: #0f172a !important; }
            .kf-theme-elegant .kf-stat-value.gold { color: #4f46e5 !important; }
            .kf-theme-elegant .kf-best-card { background: linear-gradient(135deg, #ffffff, #f8fafc) !important; border: 2px solid #c7d2fe !important; box-shadow: 0 4px 16px rgba(79,70,229,0.08) !important; animation: none !important; }
            .kf-theme-elegant .kf-best-card.blocked { border-color: #fca5a5 !important; box-shadow: 0 4px 16px rgba(239,68,68,0.08) !important; }
            .kf-theme-elegant .kf-best-left-bar { background: linear-gradient(180deg, #818cf8, #6366f1) !important; }
            .kf-theme-elegant .kf-badge { background: linear-gradient(135deg, #818cf8, #6366f1) !important; color: #ffffff !important; box-shadow: 0 2px 8px rgba(99,102,241,0.2) !important; }
            .kf-theme-elegant .kf-btn-primary { background: linear-gradient(135deg, #818cf8, #4f46e5) !important; color: #ffffff !important; box-shadow: 0 2px 12px rgba(79,70,229,0.25) !important; font-weight: 500; }
            .kf-theme-elegant .kf-btn-primary:hover { box-shadow: 0 4px 20px rgba(79,70,229,0.35) !important; transform: translateY(-1px); }
            .kf-theme-elegant .kf-option-card { background: #ffffff !important; border: 1px solid #eef2f6 !important; box-shadow: 0 1px 2px rgba(0,0,0,0.03) !important; }
            .kf-theme-elegant .kf-option-card:hover { border-color: #cbd5e1 !important; background: #fafcfd !important; transform: translateX(3px); }
            .kf-theme-elegant .kf-option-rank { color: #94a3b8 !important; }
            .kf-theme-elegant .kf-option-size { color: #0f172a !important; }
            .kf-theme-elegant .kf-option-price-value { color: #0f172a !important; }
            .kf-theme-elegant .kf-history-toggle { background: #ffffff !important; border: 1px solid #eef2f6 !important; color: #1e293b !important; box-shadow: 0 1px 2px rgba(0,0,0,0.03) !important; }
            .kf-theme-elegant .kf-history-toggle:hover { background: #f8fafc !important; border-color: #cbd5e1 !important; }
            .kf-theme-elegant .kf-auto-config { background: #ffffff !important; border: 1px solid #eef2f6 !important; color: #1e293b !important; box-shadow: 0 1px 2px rgba(0,0,0,0.03) !important; }
            .kf-theme-elegant .kf-auto-config label { color: #334155 !important; }
            .kf-exchange-panel.kf-theme-elegant .kf-auto-config input[type="number"] { width: 60px !important; max-width: 60px !important; height: 26px !important; min-width: 0 !important; flex: 0 0 auto !important; box-sizing: border-box !important; appearance: textfield !important; -moz-appearance: textfield !important; background: #f1f5f9 !important; border: 1px solid #e2e8f0 !important; color: #0f172a !important; border-radius: 4px !important; padding: 0 6px !important; font-size: 13px !important; line-height: 26px !important; margin: 0 !important; color-scheme: light; }
            .kf-exchange-panel.kf-theme-elegant .kf-auto-config input[type="number"]:focus { border-color: #818cf8 !important; outline: none !important; }
            .kf-exchange-panel.kf-theme-elegant .kf-auto-config input[type="number"]::-webkit-outer-spin-button,
            .kf-exchange-panel.kf-theme-elegant .kf-auto-config input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none !important; margin: 0 !important; }
            .kf-theme-elegant .kf-footer { color: #94a3b8 !important; }
            .kf-theme-elegant .kf-alert { background: #fef2f2 !important; border-left: 6px solid #f87171 !important; color: #991b1b !important; }
            .kf-theme-elegant .kf-alert strong { color: #991b1b !important; }
            .kf-theme-elegant .kf-banner { background: #ecfdf5 !important; border: 1px solid #6ee7b7 !important; }
            .kf-theme-elegant .kf-banner-message { color: #065f46 !important; }
            .kf-theme-elegant .kf-best-efficiency, .kf-theme-elegant .kf-option-efficiency { color: #4f46e5 !important; text-shadow: none !important; -webkit-text-stroke: unset !important; }
            .kf-theme-elegant .kf-info-panel { background: rgba(241,245,249,0.6) !important; border: 1px solid #e2e8f0 !important; }
            .kf-theme-elegant .kf-info-panel.blocked { background: #fef2f2 !important; border-color: #fca5a5 !important; }
            .kf-theme-elegant .kf-info-label { color: #64748b !important; }
            .kf-theme-elegant .kf-info-value { color: #0f172a !important; }
            .kf-theme-elegant .kf-info-total { color: #4f46e5 !important; }
            .kf-theme-elegant .kf-info-total.blocked-text { color: #dc2626 !important; }
            .kf-theme-elegant .kf-progress-bar { background: #e2e8f0 !important; }
            .kf-theme-elegant .kf-progress-fill { background: linear-gradient(90deg, #818cf8, #4f46e5) !important; }
            .kf-theme-elegant .kf-progress-fill.blocked-fill { background: linear-gradient(90deg, #fca5a5, #ef4444) !important; }
            .kf-theme-elegant .kf-best-desc { color: #64748b !important; }
            .kf-theme-elegant .kf-best-price-label { color: #94a3b8 !important; }
            .kf-theme-elegant .kf-best-price-value { color: #0f172a !important; }
            .kf-theme-elegant .kf-best-price-unit { color: #64748b !important; }
            .kf-theme-elegant .kf-option-desc { color: #94a3b8 !important; }
            .kf-theme-elegant .kf-option-price-unit { color: #94a3b8 !important; }
            .kf-theme-elegant .kf-countdown-area { color: #64748b !important; }
            .kf-theme-elegant .kf-countdown-area .kf-countdown-timer { color: #4f46e5 !important; }
            .kf-theme-elegant .kf-stop-reason { color: #dc2626 !important; }
            .kf-theme-elegant .kf-history-item { border-bottom-color: #f1f5f9 !important; color: #64748b !important; }
            .kf-theme-elegant .kf-history-item .kf-h-detail { color: #0f172a !important; }
            .kf-theme-elegant .kf-history-item .kf-h-increase { color: #4f46e5 !important; }
            .kf-theme-elegant .kf-history-empty { color: #94a3b8 !important; }
            .kf-theme-neumorphism { background: linear-gradient(145deg, #f9e7b3, #f5d78c) !important; border: 2px solid #d4af37 !important; box-shadow: 0 8px 32px rgba(212, 175, 55, 0.3), inset 0 0 40px rgba(255, 215, 0, 0.1) !important; color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-stat-card { background: radial-gradient(ellipse at center, #fdf3d0, #f7e5b5) !important; border: 1px solid #d4af37 !important; box-shadow: 0 2px 8px rgba(212, 175, 55, 0.2), inset 0 1px 2px rgba(255, 255, 255, 0.6) !important; border-radius: 16px !important; transition: all 0.3s; }
            .kf-theme-neumorphism .kf-stat-card:hover { box-shadow: 0 4px 16px rgba(212, 175, 55, 0.3), inset 0 1px 2px rgba(255, 255, 255, 0.8) !important; transform: translateY(-2px); }
            .kf-theme-neumorphism .kf-stat-label { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-stat-value { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-stat-value.gold { color: #b8860b !important; text-shadow: 0 0 8px rgba(184, 134, 11, 0.3); }
            .kf-theme-neumorphism .kf-best-card { background: radial-gradient(ellipse at center, #fdf3d0, #f7e5b5) !important; border: 3px solid #d4af37 !important; box-shadow: 0 8px 24px rgba(212, 175, 55, 0.4), inset 0 1px 4px rgba(255, 215, 0, 0.3) !important; border-radius: 20px !important; animation: coin-glow 3s ease-in-out infinite !important; }
            .kf-theme-neumorphism .kf-best-card.blocked { border-color: #b8860b !important; box-shadow: 0 8px 24px rgba(184, 134, 11, 0.3) !important; animation: none !important; }
            .kf-theme-neumorphism .kf-best-left-bar { background: linear-gradient(180deg, #d4af37, #b8860b) !important; border-radius: 20px 0 0 20px !important; width: 8px !important; }
            .kf-theme-neumorphism .kf-badge { background: linear-gradient(135deg, #d4af37, #b8860b) !important; color: #ffffff !important; box-shadow: 0 2px 8px rgba(184, 134, 11, 0.4) !important; text-shadow: 0 1px 2px rgba(0,0,0,0.2); }
            .kf-theme-neumorphism .kf-btn-primary { background: linear-gradient(135deg, #d4af37, #b8860b) !important; color: #ffffff !important; box-shadow: 0 4px 12px rgba(184, 134, 11, 0.4) !important; border: none !important; font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,0.2); }
            .kf-theme-neumorphism .kf-btn-primary:hover { box-shadow: 0 6px 20px rgba(184, 134, 11, 0.5) !important; transform: translateY(-2px); }
            .kf-theme-neumorphism .kf-option-card { background: radial-gradient(ellipse at center, #fdf3d0, #f7e5b5) !important; border: 1px solid #d4af37 !important; box-shadow: 0 2px 8px rgba(212, 175, 55, 0.2), inset 0 1px 2px rgba(255,255,255,0.6) !important; border-radius: 14px !important; }
            .kf-theme-neumorphism .kf-option-card:hover { box-shadow: 0 4px 16px rgba(212, 175, 55, 0.3), inset 0 1px 2px rgba(255,255,255,0.8) !important; transform: translateX(4px); }
            .kf-theme-neumorphism .kf-option-rank { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-option-size { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-option-price-value { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-history-toggle { background: radial-gradient(ellipse at center, #fdf3d0, #f7e5b5) !important; border: 1px solid #d4af37 !important; color: #3d2b1f !important; box-shadow: 0 2px 8px rgba(212, 175, 55, 0.2) !important; border-radius: 12px !important; }
            .kf-theme-neumorphism .kf-history-toggle:hover { box-shadow: 0 4px 12px rgba(212, 175, 55, 0.3) !important; }
            .kf-theme-neumorphism .kf-auto-config { background: radial-gradient(ellipse at center, #fdf3d0, #f7e5b5) !important; border: 1px solid #d4af37 !important; box-shadow: inset 0 2px 4px rgba(0,0,0,0.05) !important; border-radius: 12px !important; color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-auto-config label { color: #3d2b1f !important; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-auto-config input[type="number"] { width: 60px !important; max-width: 60px !important; height: 26px !important; min-width: 0 !important; flex: 0 0 auto !important; box-sizing: border-box !important; appearance: textfield !important; -moz-appearance: textfield !important; background: #fdf3d0 !important; border: 1px solid #d4af37 !important; color: #3d2b1f !important; border-radius: 6px !important; box-shadow: inset 0 1px 3px rgba(0,0,0,0.1) !important; padding: 0 6px !important; font-size: 13px !important; line-height: 26px !important; margin: 0 !important; color-scheme: light; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-auto-config input[type="number"]:focus { border-color: #b8860b !important; outline: none !important; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-auto-config input[type="number"]::-webkit-outer-spin-button,
            .kf-exchange-panel.kf-theme-neumorphism .kf-auto-config input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none !important; margin: 0 !important; }
            .kf-theme-neumorphism .kf-footer { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-alert { background: rgba(184, 134, 11, 0.15) !important; border-left: 6px solid #b8860b !important; color: #5a3e1a !important; }
            .kf-theme-neumorphism .kf-alert strong { color: #5a3e1a !important; }
            .kf-theme-neumorphism .kf-banner { background: rgba(212, 175, 55, 0.12) !important; border: 1px solid #d4af37 !important; color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-banner-message { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-best-efficiency, .kf-theme-neumorphism .kf-option-efficiency { color: #b8860b !important; text-shadow: 0 0 12px rgba(184, 134, 11, 0.3) !important; -webkit-text-stroke: unset !important; }
            .kf-theme-neumorphism .kf-info-panel { background: rgba(253, 243, 208, 0.7) !important; border: 1px solid #d4af37 !important; }
            .kf-theme-neumorphism .kf-info-panel.blocked { background: rgba(184, 134, 11, 0.15) !important; border-color: #b8860b !important; }
            .kf-theme-neumorphism .kf-info-label { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-info-value { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-info-total { color: #b8860b !important; }
            .kf-theme-neumorphism .kf-info-total.blocked-text { color: #a0522d !important; }
            .kf-theme-neumorphism .kf-progress-bar { background: #e8d5a0 !important; }
            .kf-theme-neumorphism .kf-progress-fill { background: linear-gradient(90deg, #d4af37, #b8860b) !important; }
            .kf-theme-neumorphism .kf-progress-fill.blocked-fill { background: linear-gradient(90deg, #b8860b, #8b6914) !important; }
            .kf-theme-neumorphism .kf-best-desc { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-best-price-label { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-best-price-value { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-best-price-unit { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-option-desc { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-option-price-unit { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-countdown-area { color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-countdown-area .kf-countdown-timer { color: #b8860b !important; }
            .kf-theme-neumorphism .kf-stop-reason { color: #a0522d !important; }
            .kf-theme-neumorphism .kf-history-item { border-bottom-color: #e8d5a0 !important; color: #7a5d3c !important; }
            .kf-theme-neumorphism .kf-history-item .kf-h-detail { color: #3d2b1f !important; }
            .kf-theme-neumorphism .kf-history-item .kf-h-increase { color: #b8860b !important; }
            .kf-theme-neumorphism .kf-history-empty { color: #7a5d3c !important; }
            .kf-theme-elegant .kf-best-efficiency,
            .kf-theme-elegant .kf-option-efficiency {
                background: #eef2ff !important;
                border: 1px solid #c7d2fe !important;
                color: #3730a3 !important;
                text-shadow: none !important;
            }
            .kf-theme-neumorphism .kf-best-efficiency,
            .kf-theme-neumorphism .kf-option-efficiency {
                background: rgba(184,134,11,0.20) !important;
                border: 1px solid rgba(184,134,11,0.55) !important;
                color: #78350f !important;
                text-shadow: none !important;
            }
            @keyframes cyber-pulse { 0%, 100% { box-shadow: 0 0 20px rgba(255,0,255,0.15), inset 0 0 20px rgba(0,255,255,0.05); } 50% { box-shadow: 0 0 60px rgba(255,0,255,0.25), inset 0 0 60px rgba(0,255,255,0.1); } }
            @keyframes cyber-pulse-red { 0%, 100% { box-shadow: 0 0 20px rgba(255,68,68,0.2); } 50% { box-shadow: 0 0 50px rgba(255,68,68,0.3); } }
            @keyframes coin-glow { 0%, 100% { box-shadow: 0 8px 24px rgba(212, 175, 55, 0.4), inset 0 1px 4px rgba(255, 215, 0, 0.3); } 50% { box-shadow: 0 8px 32px rgba(212, 175, 55, 0.6), inset 0 1px 8px rgba(255, 215, 0, 0.5); } }
            @keyframes kf-slide-in { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes kf-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
            @keyframes kf-fade-out { 0% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-10px); } }
            .kf-alert { background: rgba(220, 38, 38, 0.15) !important; border-left: 6px solid #f87171 !important; border-radius: 8px !important; padding: 12px 18px !important; margin-bottom: 16px !important; font-weight: 600 !important; font-size: 14px !important; display: flex !important; align-items: center !important; gap: 8px !important; animation: kf-slide-in 0.5s ease-out !important; }
            .kf-alert .kf-alert-icon { font-size: 20px !important; margin-right: 8px !important; }
            .kf-zero-download-notice { background: rgba(251,191,36,0.12) !important; border-left: 6px solid #fbbf24 !important; border-radius: 8px !important; padding: 12px 18px !important; margin-bottom: 16px !important; font-weight: 600 !important; font-size: 14px !important; color: #fbbf24 !important; display: flex !important; align-items: center !important; gap: 8px !important; animation: kf-slide-in 0.5s ease-out !important; position: relative !important; z-index: 1 !important; }
            .kf-zero-download-notice .kf-zdn-icon { font-size: 20px !important; margin-right: 8px !important; flex-shrink: 0 !important; }
            .kf-theme-elegant .kf-zero-download-notice { background: #fffbeb !important; border-left-color: #f59e0b !important; color: #92400e !important; }
            .kf-theme-neumorphism .kf-zero-download-notice { background: rgba(245, 158, 11, 0.15) !important; border-left-color: #d97706 !important; color: #92400e !important; }
            .kf-reserve-highlight { color: #fbbf24 !important; }
            .kf-need-download-highlight { color: #fbbf24 !important; }
            .kf-exchange-panel.kf-theme-elegant .kf-reserve-highlight,
            .kf-exchange-panel.kf-theme-elegant .kf-need-download-highlight { color: #b45309 !important; }
            .kf-exchange-panel.kf-theme-neumorphism .kf-reserve-highlight,
            .kf-exchange-panel.kf-theme-neumorphism .kf-need-download-highlight { color: #8b5a00 !important; }
            .kf-best-efficiency, .kf-option-efficiency {
                font-weight: 800 !important;
                display: inline-block !important;
                padding: 2px 8px !important;
                border-radius: 6px !important;
                background: rgba(251,191,36,0.18) !important;
                border: 1px solid rgba(251,191,36,0.55) !important;
                color: #fde047 !important;
                text-shadow: 0 1px 2px rgba(0,0,0,0.85) !important;
                -webkit-text-stroke: 0 !important;
                line-height: 1.4 !important;
                margin-top: 4px !important;
            }
            .kf-stats-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 20px; position: relative; z-index: 1; }
            .kf-stats-grid-5 { grid-template-columns: repeat(5,1fr); }
            @media (max-width: 900px) { .kf-stats-grid-5 { grid-template-columns: repeat(3,1fr); } }
            @media (max-width: 768px) { .kf-stats-grid-5 { grid-template-columns: repeat(2,1fr); } }
            @media (max-width: 480px) { .kf-stats-grid-5 { grid-template-columns: 1fr; } }
            .kf-stat-card { border-radius: 12px; padding: 14px 16px; transition: transform 0.2s,border-color 0.2s; position: relative; }
            .kf-stat-label { font-size: 11px; font-weight: 500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; }
            .kf-stat-value { font-size: 20px; font-weight: 700; line-height: 1.2; }
            .kf-stat-value.gold { color: #fbbf24; }
            .kf-stat-sub { color: #34d399; font-size: 11px; margin-left: 6px; }
            .kf-upload-increase { display: inline-block; margin-left: 8px; color: #34d399; font-size: 18px; font-weight: 700; animation: kf-slide-in 0.3s ease-out; }
            .kf-upload-increase.fade-out { animation: kf-fade-out 0.8s ease-out forwards; }
            .kf-section-title { color: #94a3b8; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 10px 4px; position: relative; z-index: 1; }
            .kf-best-card { border-radius: 16px; padding: 20px; position: relative; overflow: hidden; transition: transform 0.15s cubic-bezier(0.34,1.56,0.64,1); cursor: pointer; z-index: 1; user-select: none; -webkit-user-select: none; }
            .kf-best-card:hover { transform: scale(1.008) translateY(-2px); }
            .kf-best-card:active { transform: scale(0.98); transition: transform 0.08s ease-out; }
            .kf-best-left-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 2px 0 0 2px; }
            .kf-best-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
            .kf-badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; font-size: 11px; font-weight: 700; border-radius: 20px; }
            .kf-best-body { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
            .kf-best-spec { flex: 0 0 auto; }
            .kf-best-size { font-size: 26px; font-weight: 700; line-height: 1.1; }
            .kf-best-desc { font-size: 13px; margin-top: 2px; color: #94a3b8; }
            .kf-best-price { flex: 0 0 auto; }
            .kf-best-price-label { color: #64748b; font-size: 11px; margin-bottom: 2px; }
            .kf-best-price-value { font-size: 22px; font-weight: 700; }
            .kf-best-price-unit { font-size: 13px; margin-left: 2px; }
            .kf-info-panel { flex: 1 1 280px; background: rgba(0,0,0,0.15); border-radius: 8px; padding: 14px 18px; min-width: 260px; }
            .kf-info-panel.blocked { background: rgba(220,38,38,0.08); border: 1px solid rgba(239,68,68,0.2); }
            .kf-info-row { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
            .kf-info-label { color: #94a3b8; font-size: 12px; }
            .kf-info-value { font-size: 22px; font-weight: 700; }
            .kf-info-unit { color: #94a3b8; font-size: 13px; }
            .kf-info-total { font-size: 13px; font-weight: 600; margin-top: 6px; color: #fbbf24; }
            .kf-info-total.blocked-text { color: #f87171; }
            .kf-progress-bar { width: 100%; height: 5px; background: rgba(255,255,255,0.08); border-radius: 3px; margin-top: 10px; overflow: hidden; }
            .kf-progress-fill { height: 100%; background: linear-gradient(90deg,#fbbf24,#f59e0b); border-radius: 3px; transition: width 0.6s ease-out; }
            .kf-progress-fill.blocked-fill { background: linear-gradient(90deg,#f87171,#dc2626); }
            .kf-btn { flex: 0 0 auto; padding: 12px 28px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; position: relative; overflow: hidden; }
            .kf-btn-disabled { background: linear-gradient(135deg,#374151,#4b5563); color: #9ca3af; cursor: not-allowed; }
            .kf-option-card { border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; gap: 20px; margin-top: 10px; transition: all 0.2s; position: relative; z-index: 1; }
            .kf-option-rank { color: #64748b; font-size: 11px; font-weight: 600; min-width: 28px; }
            .kf-option-spec { flex: 0 0 140px; }
            .kf-option-size { font-size: 17px; font-weight: 600; }
            .kf-option-desc { color: #64748b; font-size: 12px; }
            .kf-option-price { flex: 0 0 160px; }
            .kf-option-price-value { font-size: 17px; font-weight: 600; }
            .kf-option-price-unit { color: #94a3b8; font-size: 12px; margin-left: 2px; }
            .kf-option-spacer { flex: 1; }
            .kf-option-btn { padding: 8px 20px; border: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
            .kf-option-btn-active { background: linear-gradient(135deg,#8b5cf6,#6366f1); color: #fff; opacity: 0.9; }
            .kf-option-btn-active:hover { opacity: 1; transform: scale(1.03); }
            .kf-option-btn-disabled { background: linear-gradient(135deg,#374151,#4b5563); color: #9ca3af; cursor: not-allowed; }
            .kf-history-toggle { display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 12px 16px; border-radius: 8px; margin: 16px 0 8px; transition: background 0.2s; position: relative; z-index: 1; user-select: none; }
            .kf-history-toggle .kf-arrow { transition: transform 0.3s; color: #94a3b8; }
            .kf-history-toggle .kf-arrow.open { transform: rotate(180deg); }
            .kf-history-content { overflow: hidden; max-height: 0; transition: max-height 0.4s ease-out; position: relative; z-index: 1; }
            .kf-history-content.open { max-height: 600px; }
            .kf-history-list { margin: 8px 0 0; padding: 0; list-style: none; }
            .kf-history-item { display: flex; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 13px; color: #94a3b8; }
            .kf-history-item:last-child { border-bottom: none; }
            .kf-history-item .kf-h-time { color: #64748b; font-size: 12px; }
            .kf-history-item .kf-h-detail { color: #f8fafc; font-weight: 500; }
            .kf-history-item .kf-h-increase { color: #34d399; font-weight: 600; }
            .kf-history-empty { color: #64748b; font-size: 13px; padding: 12px; text-align: center; }
            .kf-history-pager { display: flex; gap: 6px; justify-content: center; margin-top: 10px; flex-wrap: wrap; }
            .kf-history-pager button { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #94a3b8; border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
            .kf-history-pager button:hover:not(:disabled) { border-color: #8b5cf6; color: #f8fafc; }
            .kf-history-pager button.active { background: rgba(139,92,246,0.35); border-color: #8b5cf6; color: #f8fafc; font-weight: 600; }
            .kf-history-pager button:disabled { opacity: 0.4; cursor: not-allowed; }
            .kf-h-site { display: inline-block; padding: 1px 6px; border-radius: 4px; background: rgba(139,92,246,0.25); color: #c4b5fd; font-size: 11px; }
            .kf-banner { border-radius: 8px; padding: 12px 18px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; animation: kf-slide-in 0.4s ease-out; position: relative; z-index: 2; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3); }
            .kf-banner-message { color: #34d399; font-size: 14px; font-weight: 600; }
            .kf-banner-close { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 0 8px; transition: color 0.2s; }
            .kf-banner-close:hover { color: #f8fafc; }
            .kf-footer { text-align: center; color: #64748b; font-size: 11px; margin-top: 16px; position: relative; z-index: 1; }
            .kf-rule-highlight { background: rgba(220,38,38,0.12) !important; border-left: 4px solid #f87171 !important; border-radius: 6px !important; padding: 10px 14px !important; color: #f87171 !important; font-weight: 600 !important; display: block !important; margin: 6px 0 !important; }
            .kf-rule-highlight .kf-rule-marker { color: #fbbf24 !important; margin-right: 8px !important; font-weight: 700 !important; }
            .kf-auto-config { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 10px 16px; border-radius: 8px; margin-bottom: 12px; }
            .kf-auto-config label { display: flex; align-items: center; gap: 6px; color: #94a3b8; font-size: 13px; cursor: pointer; }
            .kf-auto-config input[type="checkbox"] { width: 16px; height: 16px; accent-color: #8b5cf6 !important; cursor: pointer; color-scheme: dark; }
            .kf-exchange-panel .kf-auto-config input[type="number"] { width: 60px !important; max-width: 60px !important; height: 26px !important; min-width: 0 !important; flex: 0 0 auto !important; box-sizing: border-box !important; appearance: textfield !important; -moz-appearance: textfield !important; background: rgba(255,255,255,0.08) !important; border: 1px solid rgba(255,255,255,0.15) !important; border-radius: 4px !important; color: #f8fafc !important; padding: 0 6px !important; font-size: 13px !important; line-height: 26px !important; margin: 0 !important; transition: border-color 0.2s; color-scheme: dark; }
            .kf-exchange-panel .kf-auto-config input[type="number"]:focus { outline: none !important; border-color: #8b5cf6 !important; }
            .kf-exchange-panel .kf-auto-config input[type="number"]::-webkit-outer-spin-button,
            .kf-exchange-panel .kf-auto-config input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none !important; margin: 0 !important; }
            .kf-auto-config .kf-config-hint { color: #64748b; font-size: 11px; margin-left: 4px; }
            .kf-countdown-area { text-align: center; color: #94a3b8; font-size: 14px; margin-top: 8px; padding: 4px 0; }
            .kf-countdown-area .kf-countdown-timer { font-weight: 700; color: #fbbf24; font-size: 16px; min-width: 30px; display: inline-block; }
            .kf-stop-reason { color: #f87171; font-size: 13px; font-weight: 600; margin-top: 4px; text-align: center; }
            .kf-auto-warning { background: rgba(239,68,68,0.14); border: 1px solid rgba(239,68,68,0.45); border-left: 5px solid #ef4444; border-radius: 10px; padding: 10px 16px; margin-bottom: 12px; color: #fca5a5; font-size: 13px; font-weight: 600; line-height: 1.7; position: relative; z-index: 1; }
            .kf-chd-notice { font-size: 13px; line-height: 1.9; margin-bottom: 8px; }
            .kf-tip-trigger { position: relative; cursor: help; color: #fbbf24; text-decoration: underline dotted; white-space: nowrap; }
            .kf-tip-box { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) translateZ(0); will-change: transform, opacity; backface-visibility: hidden; width: 480px; max-width: 90vw; max-height: 80vh; overflow-y: auto; background: #1e1b4b; color: #e2e8f0; border: 1px solid #8b5cf6; border-radius: 12px; padding: 16px; z-index: 9999; box-shadow: 0 12px 32px rgba(0,0,0,0.55); text-align: left; font-size: 12px; line-height: 1.8; white-space: normal; cursor: default; text-decoration: none; }
            .kf-tip-trigger:hover .kf-tip-box { display: block; }
            .kf-tip-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
            .kf-tip-item { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; }
            .kf-tip-title { display: block; font-weight: 700; color: #c4b5fd; margin-bottom: 6px; font-size: 12px; }
            @media (max-width: 600px) { .kf-tip-grid { grid-template-columns: 1fr; } .kf-tip-box { width: 320px; } }
            @media (max-width:900px) { .kf-dashboard { padding: 16px; margin: 12px 8px; } .kf-best-body { gap: 16px; } .kf-best-size { font-size: 22px; } .kf-best-price-value { font-size: 20px; } .kf-info-panel { min-width: 220px; } .kf-auto-config { gap: 12px; } .kf-header { flex-wrap: wrap; } }
            @media (max-width:768px) { .kf-stats-grid { grid-template-columns: repeat(2,1fr); gap: 8px; } .kf-stat-card { padding: 10px 12px; } .kf-stat-value { font-size: 16px; } .kf-best-body { flex-direction: column; align-items: stretch; gap: 14px; } .kf-best-spec, .kf-best-price { text-align: center; } .kf-info-panel { width: 100%; min-width: unset; } .kf-option-card { flex-wrap: wrap; gap: 10px; padding: 12px 14px; } .kf-option-spec { flex: 1 1 100px; } .kf-option-price { flex: 1 1 120px; } .kf-option-spacer { display: none; } .kf-option-btn { width: 100%; margin-top: 4px; } .kf-section-title { margin: 16px 0 8px 2px; } .kf-auto-config { flex-direction: column; align-items: stretch; gap: 8px; } .kf-theme-select { max-width: 100%; } }
            @media (max-width:480px) { .kf-stats-grid { grid-template-columns: 1fr; } .kf-header { flex-direction: column; align-items: stretch; gap: 8px; } .kf-title { font-size: 14px; } .kf-best-card { padding: 14px; } .kf-best-size { font-size: 20px; } .kf-option-size { font-size: 15px; } .kf-option-price-value { font-size: 15px; } .kf-footer { font-size: 10px; padding: 0 8px; } .kf-status { align-self: flex-start; } }
            .kf-site-notice .kf-tip-trigger { position: relative; cursor: help; text-decoration: underline dotted; transform: translateZ(0); backface-visibility: hidden; }
            .kf-tip-box b { color: inherit; }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // M-Team / KEEPFRDS 表格样式
    // ============================================================
    function injectMTeamStyles() {
        if (document.getElementById('kf-mteam-styles')) return;
        var style = document.createElement('style');
        style.id = 'kf-mteam-styles';
        style.textContent = `
        .kf-mteam-table-wrap {
            margin: 8px 0;
            overflow-x: auto;
            width: fit-content;
            max-width: 100%;
            padding: 1px;
            background: linear-gradient(135deg, rgba(139,92,246,0.35), rgba(236,72,153,0.25));
            border-radius: 11px;
        }
        .kf-mteam-table {
            border-collapse: separate !important;
            border-spacing: 0 !important;
            border: none !important;
            font-size: 12px;
            width: auto;
            border-radius: 10px;
            overflow: hidden;
            background: #0f0a1e;
        }
        .kf-mteam-table th,
        .kf-mteam-table td {
            border: none !important;
            border-top: none !important;
            border-left: none !important;
            border-right: none !important;
            border-bottom: 1px solid rgba(255,255,255,0.06) !important;
            padding: 8px 14px;
            white-space: nowrap;
            vertical-align: middle;
            background-clip: padding-box;
        }
        .kf-mteam-table thead th {
            background: linear-gradient(180deg, rgba(139,92,246,0.35), rgba(139,92,246,0.18)) !important;
            text-align: left;
            font-weight: 700;
            color: #e9d5ff;
            border-bottom: 2px solid rgba(139,92,246,0.45) !important;
            letter-spacing: 0.3px;
        }
        .kf-mteam-table thead th:first-child { border-top-left-radius: 10px; }
        .kf-mteam-table thead th:last-child  { border-top-right-radius: 10px; }
        .kf-mteam-table tbody tr:last-child td:first-child { border-bottom-left-radius: 10px; }
        .kf-mteam-table tbody tr:last-child td:last-child  { border-bottom-right-radius: 10px; }
        .kf-mteam-table tbody tr:last-child td { border-bottom: none !important; }
        .kf-mteam-table tbody tr:hover { background: rgba(139,92,246,0.10); }
        .kf-mteam-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.015); }
        .kf-mteam-table tbody tr:nth-child(odd)  { background: rgba(0,0,0,0.08); }
        .kf-mteam-table tbody tr.kf-row-keep {
            background: linear-gradient(90deg, rgba(251,191,36,0.28), rgba(251,191,36,0.14)) !important;
            color: #fde047 !important;
            font-weight: 800;
        }
        .kf-mteam-table tbody tr.kf-row-graduate {
            background: linear-gradient(90deg, rgba(16,185,129,0.28), rgba(16,185,129,0.14)) !important;
            color: #6ee7b7 !important;
            font-weight: 800;
        }
        .kf-mteam-table tbody tr.kf-row-keep:hover { background: linear-gradient(90deg, rgba(251,191,36,0.36), rgba(251,191,36,0.22)) !important; }
        .kf-mteam-table tbody tr.kf-row-graduate:hover { background: linear-gradient(90deg, rgba(16,185,129,0.36), rgba(16,185,129,0.22)) !important; }
        .kf-theme-elegant .kf-mteam-table-wrap {
            background: linear-gradient(135deg, #ddd6fe, #fbcfe8);
        }
        .kf-theme-elegant .kf-mteam-table { background: #ffffff; }
        .kf-theme-elegant .kf-mteam-table th,
        .kf-theme-elegant .kf-mteam-table td {
            border-bottom: 1px solid #eef2f6 !important;
        }
        .kf-theme-elegant .kf-mteam-table thead th {
            background: #f1f5f9 !important;
            color: #334155;
            border-bottom: 2px solid #cbd5e1 !important;
        }
        .kf-theme-elegant .kf-mteam-table tbody tr:nth-child(even) { background: #fafbfc; }
        .kf-theme-elegant .kf-mteam-table tbody tr:nth-child(odd)  { background: #ffffff; }
        .kf-theme-elegant .kf-mteam-table tbody tr:hover { background: #f1f5f9; }
        .kf-theme-elegant .kf-mteam-table tbody tr.kf-row-keep {
            background: #fef3c7 !important; color: #b45309 !important;
        }
        .kf-theme-elegant .kf-mteam-table tbody tr.kf-row-graduate {
            background: #d1fae5 !important; color: #047857 !important;
        }
        .kf-mteam-warning {
            background: rgba(251,191,36,0.12);
            border-left: 4px solid #fbbf24;
            padding: 12px 16px;
            border-radius: 8px;
            margin: 12px 0;
            color: #fbbf24;
            font-size: 13px;
            line-height: 1.7;
        }
        .kf-mteam-warning b { color: #fbbf24; }
        .kf-mteam-hint { display: flex; gap: 16px; padding: 18px 22px; border-radius: 12px; margin: 16px 0; border: 1px solid; align-items: flex-start; }
        .kf-mteam-hint-icon { font-size: 30px; flex-shrink: 0; line-height: 1.2; }
        .kf-mteam-hint-body { flex: 1; min-width: 0; }
        .kf-mteam-hint-title { font-size: 17px; font-weight: 800; margin-bottom: 8px; letter-spacing: 0.5px; }
        .kf-mteam-hint-text { font-size: 14px; line-height: 1.8; font-weight: 500; }
        .kf-mteam-hint-text b { font-weight: 800; font-size: 15px; }
        .kf-mteam-hint-reserve { margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.2); font-size: 14px; line-height: 1.7; font-weight: 500; }
        .kf-mteam-hint-reserve b { font-weight: 800; font-size: 17px; }
        .kf-mteam-hint-blocked { background: rgba(239,68,68,0.14); border-color: rgba(239,68,68,0.45); border-left: 5px solid #ef4444; }
        .kf-mteam-hint-blocked .kf-mteam-hint-title { color: #ff6b6b; }
        .kf-mteam-hint-blocked .kf-mteam-hint-text { color: #fecaca; }
        .kf-mteam-hint-blocked .kf-mteam-hint-text b { color: #fde047; }
        .kf-mteam-hint-blocked .kf-mteam-hint-reserve { color: #fde047; border-top-color: rgba(251,191,36,0.4); }
        .kf-mteam-hint-blocked .kf-mteam-hint-reserve b { color: #fde047; }
        .kf-mteam-hint-ok { background: rgba(16,185,129,0.14); border-color: rgba(16,185,129,0.45); border-left: 5px solid #10b981; }
        .kf-mteam-hint-ok .kf-mteam-hint-title { color: #34d399; }
        .kf-mteam-hint-ok .kf-mteam-hint-text { color: #a7f3d0; }
        .kf-mteam-hint-ok .kf-mteam-hint-text b { color: #fde047; }
        .kf-mteam-rules-row { display: flex; gap: 16px; margin: 16px 0; flex-wrap: wrap; align-items: stretch; }
        .kf-mteam-rules-row > .kf-mteam-rulebox { flex: 1 1 340px; margin: 0; min-width: 0; }
        .kf-mteam-rules-row > .kf-mteam-upgrade { flex: 1 1 420px; min-width: 0; }
        .kf-mteam-upgrade.kf-mteam-rulebox { background: linear-gradient(145deg, rgba(59,130,246,0.08), rgba(139,92,246,0.05)); border-color: rgba(59,130,246,0.3); }
        .kf-mteam-upgrade .kf-mteam-rulebox-title { color: #93c5fd; }
        .kf-mteam-upgrade.kf-mteam-rulebox::before { background: linear-gradient(90deg, #3b82f6, #8b5cf6, #3b82f6); background-size: 200% 100%; }
        .kf-mteam-rulebox { position: relative; background: linear-gradient(145deg, rgba(139,92,246,0.08), rgba(236,72,153,0.05)); border: 1px solid rgba(139,92,246,0.3); border-radius: 12px; padding: 16px 20px; margin: 16px 0; overflow: hidden; }
        .kf-mteam-rulebox::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, #8b5cf6, #ec4899, #8b5cf6); background-size: 200% 100%; animation: kf-mteam-rulebox-flow 4s linear infinite; }
        @keyframes kf-mteam-rulebox-flow { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
        .kf-mteam-rulebox-title { font-size: 13px; font-weight: 700; color: #c4b5fd; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; letter-spacing: 0.5px; }
        .kf-mteam-rulebox-icon { font-size: 15px; }
        .kf-mteam-rulebox-body { font-size: 13px; line-height: 2; color: #cbd5e1; }
        .kf-mteam-rulebox-line { padding: 4px 0; }
        .kf-mteam-rule-highlight { display: inline-block; padding: 1px 8px; border-radius: 4px; background: linear-gradient(135deg, rgba(251,191,36,0.25), rgba(245,158,11,0.18)); color: #fbbf24; font-weight: 700; box-shadow: 0 0 12px rgba(251,191,36,0.12); margin: 0 2px; }
        .kf-mteam-rulebox-formula { margin-top: 12px; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; font-size: 12.5px; color: #94a3b8; font-family: 'SF Mono', Consolas, Monaco, monospace; text-align: left; letter-spacing: 0.3px; line-height: 1.8; white-space: pre-line; }
        .kf-theme-elegant .kf-mteam-warning { background: #fffbeb; border-left-color: #f59e0b; color: #92400e; }
        .kf-theme-elegant .kf-mteam-warning b { color: #92400e; }
        .kf-theme-elegant .kf-mteam-hint-blocked { background: #fef2f2; border-color: #fca5a5; border-left-color: #ef4444; }
        .kf-theme-elegant .kf-mteam-hint-blocked .kf-mteam-hint-title { color: #b91c1c; }
        .kf-theme-elegant .kf-mteam-hint-blocked .kf-mteam-hint-text { color: #7f1d1d; }
        .kf-theme-elegant .kf-mteam-hint-blocked .kf-mteam-hint-text b { color: #b45309; }
        .kf-theme-elegant .kf-mteam-hint-blocked .kf-mteam-hint-reserve { color: #92400e; border-top-color: #fca5a5; }
        .kf-theme-elegant .kf-mteam-hint-blocked .kf-mteam-hint-reserve b { color: #b45309; }
        .kf-theme-elegant .kf-mteam-hint-ok { background: #ecfdf5; border-color: #6ee7b7; border-left-color: #10b981; }
        .kf-theme-elegant .kf-mteam-hint-ok .kf-mteam-hint-title { color: #047857; }
        .kf-theme-elegant .kf-mteam-hint-ok .kf-mteam-hint-text { color: #065f46; }
        .kf-theme-elegant .kf-mteam-hint-ok .kf-mteam-hint-text b { color: #b45309; }
        .kf-theme-elegant .kf-mteam-rulebox { background: linear-gradient(145deg, #f5f3ff, #fdf4ff); border-color: #ddd6fe; }
        .kf-theme-elegant .kf-mteam-upgrade.kf-mteam-rulebox { background: linear-gradient(145deg, #eff6ff, #f5f3ff); border-color: #bfdbfe; }
        .kf-theme-elegant .kf-mteam-upgrade .kf-mteam-rulebox-title { color: #1d4ed8; }
        .kf-theme-elegant .kf-mteam-rulebox-title { color: #6d28d9; }
        .kf-theme-elegant .kf-mteam-rulebox-body { color: #334155; }
        .kf-theme-elegant .kf-mteam-rule-highlight { background: linear-gradient(135deg, #fef3c7, #fde68a); color: #b45309; box-shadow: none; }
        .kf-theme-elegant .kf-mteam-rulebox-formula { background: #f1f5f9; color: #475569; }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // 切换主题
    // ============================================================
    function switchTheme(panel, newTheme) {
        if (!panel) return;
        Object.keys(THEMES).forEach(function (k) { panel.classList.remove(THEMES[k].className); });
        panel.classList.add(THEMES[newTheme].className);
        var sel = document.getElementById('kf-theme-select');
        if (sel) { sel.value = newTheme; saveTheme(newTheme); }
    }

    // ============================================================
    // 高亮原生规则（NexusPHP 站点）
    // ============================================================
    function highlightNativeRules(config) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (node.parentElement && node.parentElement.closest('.kf-rule-highlight, .kf-exchange-panel')) return NodeFilter.FILTER_REJECT;
                if (node.textContent && node.textContent.indexOf('分享率高于') !== -1) return NodeFilter.FILTER_ACCEPT;
                return NodeFilter.FILTER_REJECT;
            }
        });
        var nodes = [], cn;
        while ((cn = walker.nextNode())) nodes.push(cn);
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var parent = node.parentNode; if (!parent) continue;
            var span = document.createElement('span'); span.className = 'kf-rule-highlight';
            var move = [node];
            var sib = node.nextSibling;
            while (sib) {
                if (sib.nodeType === Node.ELEMENT_NODE) {
                    var tag = sib.tagName.toLowerCase();
                    var isSimple = ['b','strong','i','em','u','s','font','span'].indexOf(tag) !== -1 && !sib.querySelector('*');
                    if (isSimple && /^[0-9.,\s，。、；：！？%）)]*$/.test(sib.textContent)) { move.push(sib); sib = sib.nextSibling; continue; }
                    break;
                }
                if (sib.nodeType === Node.TEXT_NODE) {
                    var t = sib.textContent;
                    if (/^[，。、；：！？)）\s]/.test(t) || /^\s*$/.test(t)) { move.push(sib); sib = sib.nextSibling; continue; }
                    break;
                }
                break;
            }
            parent.insertBefore(span, move[0]);
            move.forEach(function (n) { span.appendChild(n); });
            if (config && config.ruleExtraNote) {
                var note = document.createElement('span');
                note.textContent = ' ' + config.ruleExtraNote;
                note.style.cssText = 'color:#2aabee !important;font-weight:700 !important;';
                span.appendChild(note);
            }
        }
        window._kf_rule_banner = (config && config.ruleDescription) ? config.ruleDescription : null;
    }

    // ============================================================
    // injectUI（v1.0.1 修复版）
    //   [Fix] 多并列最佳时，仅 index===0 的按钮走 qtyInput 逻辑
    //   [Opt] 兜底插入 body 时改为 appendChild，避免面板跑到页面顶部
    //   [Opt] 面板带 .kf-exchange-panel class，避免多脚本 ID 冲突
    // ============================================================
    function injectUI(config, userData, strategy) {
        if (DEBUG) log('[' + config.name + '助手] 开始注入UI...');
        injectThemeStyles();
        injectMTeamStyles();

        var bestOptions = strategy.bestOptions || [];
        if (bestOptions.length === 0) { console.warn('[' + config.name + '助手] 没有最佳选项，跳过UI'); return; }

        var panelId = config.panelId || DEFAULT_PANEL_ID;
        var oldPanel = document.getElementById(panelId);
        if (oldPanel) oldPanel.remove();

        // ---------- 面板插入位置解析 ----------
        var outer, insertBeforeNode, insertResolved = false, useAppend = false;
        if (config.panelInsertBefore) {
            var t1 = document.querySelector(config.panelInsertBefore);
            if (t1 && t1.parentElement) { outer = t1.parentElement; insertBeforeNode = t1; insertResolved = true; }
        }
        if (!insertResolved && config.panelContainer) {
            var c1 = document.querySelector(config.panelContainer);
            if (c1) { outer = c1; insertBeforeNode = c1.firstChild; insertResolved = true; }
        }
        if (!insertResolved && config.insertBeforeUserbar) {
            var ub = document.querySelector('#info_block.userbar') || document.querySelector('#info_block');
            if (ub && ub.parentElement) { outer = ub.parentElement; insertBeforeNode = ub; insertResolved = true; }
        }
        if (!insertResolved && config.insertBeforeMainTable) {
            var mt = document.querySelector('table.mainouter');
            if (mt && mt.parentElement) { outer = mt.parentElement; insertBeforeNode = mt; insertResolved = true; }
        }
        if (!insertResolved && config.insertAfterNav) {
            var navs = ['#nav','#header','header','#navigation','.navigation','.navbar','nav'];
            for (var ni = 0; ni < navs.length; ni++) {
                var nv = document.querySelector(navs[ni]);
                if (nv && nv.parentElement) { outer = nv.parentElement; insertBeforeNode = nv.nextSibling; insertResolved = true; break; }
            }
        }
        if (!insertResolved) {
            outer = document.querySelector('.mainouter') || document.querySelector('#main') || document.querySelector('#outer');
            if (outer) {
                insertBeforeNode = outer.firstChild;
            } else {
                // [Opt] 最终兜底：body 用 appendChild，避免插到 <script>/<comment> 之前
                outer = document.body;
                useAppend = true;
            }
        }

        var isForceTheme = config.forceTheme && THEMES[config.forceTheme];
        var currentTheme = isForceTheme ? config.forceTheme : getTheme();
        var panel = document.createElement('div');
        panel.id = panelId;
        panel.className = 'kf-dashboard ' + PANEL_CLASS + ' ' + THEMES[currentTheme].className;

        var statusClass = strategy.canExchange ? 'ok' : 'blocked';
        var statusText = strategy.canExchange ? '当前可正常兑换' : '兑换受限';

        var naFields = config.naZeroFields || [];
        var ratioDisplay = naFields.indexOf('ratio') !== -1 ? '-' : (isFinite(userData.ratio) ? userData.ratio.toFixed(3) : '无限');
        var ratioStatus = naFields.indexOf('ratio') !== -1 ? '' : (strategy.canExchange ? '<span class="kf-stat-sub">✓ 正常</span>' : '<span class="kf-stat-sub" style="color:#f87171">⚠ 过高</span>');
        var downloadDisplay = naFields.indexOf('download') !== -1 ? '-' : userData.downloadStr;

        var availableBonus = userData.currentBonus;
        var firstBest = bestOptions[0];

        var planReserveBonus = 0;
        try {
            var _autoCfg = getAutoConfig(config, config.defaultReserveBonus, config.defaultAutoInterval, config.lockAutoInterval);
            planReserveBonus = (_autoCfg && _autoCfg.reserveBonus) || 0;
            var _hrMin = getHrReserveMin(config);
            if (_hrMin > planReserveBonus) planReserveBonus = _hrMin;
        } catch (e) { planReserveBonus = 0; }

        var maxTimes = 0, totalUploadGB = 0;
        var spendableBonus = Math.max(0, availableBonus - planReserveBonus);
        var planBreakdown = [];
        bestOptions.forEach(function (opt) {
            if (opt.disabled) return;
            if (opt.price > 0 && spendableBonus >= opt.price) {
                var times = Math.floor(spendableBonus / opt.price);
                if (times > 0) {
                    maxTimes += times;
                    totalUploadGB += times * opt.sizeGB;
                    spendableBonus -= times * opt.price;
                    planBreakdown.push(fmtSize(config, opt.sizeGB) + ' × ' + times + ' 次');
                }
            }
        });
        var leftoverBonus = spendableBonus + planReserveBonus;
        var TARGET_TIMES = 10;
        var progressPercent = firstBest.price > 0 ? Math.min((availableBonus / firstBest.price / TARGET_TIMES) * 100, 100) : 0;

        var alertHTML = '';
        if (!strategy.canExchange) {
            if (config.name === 'KEEPFRDS') {
                var level = window._kfKeepfrdsLevel || 'User';
                var downloadGB = window._kfKeepfrdsDownloadGB || 0;
                var req = getKeepfrdsRequiredRatio(level, downloadGB);
                var alertRatio = isFinite(userData.ratio) ? userData.ratio.toFixed(3) : '无限';
                var needDL = strategy.needDownloadGB > 0 ? formatGB(strategy.needDownloadGB) : '0 GB';
                alertHTML = '<div class="kf-alert"><span class="kf-alert-icon">🚫</span><span>您的分享率 <strong>' + alertRatio + '</strong> 已超过该限制（兑换上传量的要求是不超过当前等级 ' + level + ' 分享率的 2 倍，即 ' + req.toFixed(2) + ' × 2），需下载 <strong>' + needDL + '</strong> 以恢复兑换资格。</span></div>';
            } else {
                var needDownloadText = (strategy.needDownloadGB > 0 && config.showNeedDownload !== false) ? '需下载 <strong>' + formatGB(strategy.needDownloadGB) + '</strong> 以恢复兑换资格。' : '';
                alertHTML = '<div class="kf-alert"><span class="kf-alert-icon">🚫</span><span><strong>兑换受限：</strong>' + strategy.reason + '。' + needDownloadText + '</span></div>';
            }
        }

        var zeroDownloadNoticeHTML = '';
        if (!config.skipZeroDownloadNotice && userData.downloadGB === 0 && userData.ratio === Infinity) {
            zeroDownloadNoticeHTML = '<div class="kf-zero-download-notice"><span class="kf-zdn-icon">⚠️</span><span><strong>下载量为 0 时限制兑换上传量</strong>（当前分享率为无限，站点通常不允许继续兑换上传量）</span></div>';
        }

        var globalSummaryHTML = '';
        var cardInfoHTML = '';
        var priceUnit = config.currency || '魔力';
        var magicLabel = config.currency || '魔力';

        if (strategy.canExchange) {
            var uGB = config.sizeUnitGB || 'GB';
            var uTB = config.sizeUnitTB || 'TB';

            globalSummaryHTML = '<div class="kf-global-summary" style="background:linear-gradient(135deg,rgba(139,92,246,0.14),rgba(236,72,153,0.06));border:1px solid rgba(139,92,246,0.35);border-radius:12px;padding:14px 18px;margin:12px 0 16px 0;position:relative;z-index:1;">'
                + '<div class="kf-info-row">'
                + '<span class="kf-info-label">💎 ' + priceUnit + '</span>'
                + '<span class="kf-info-value">' + availableBonus.toLocaleString() + '</span>'
                + '<span class="kf-info-unit">可兑换</span>'
                + '<span class="kf-info-value" style="color:#fbbf24">' + maxTimes + '</span>'
                + '<span class="kf-info-unit">次</span>'
                + (planReserveBonus > 0 ? '<span class="kf-info-unit" style="margin-left:10px;color:#a78bfa;">🛡️ 已保留 ' + planReserveBonus.toLocaleString() + '</span>' : '')
                + '</div>'
                + (config.hideTotalLine ? '' : '<div class="kf-info-total">= ' + totalUploadGB.toFixed(0) + ' ' + uGB + ' (' + (totalUploadGB / 1024).toFixed(2) + ' ' + uTB + ') 上传量</div>')
                + (planBreakdown.length > 1 ? '<div class="kf-info-total" style="font-size:11px;font-weight:500;margin-top:2px;color:#94a3b8;">（' + planBreakdown.join(' + ') + '）</div>' : '')
                + '<div class="kf-info-total" style="font-size:12px;font-weight:500;margin-top:4px;color:#94a3b8;">' + (config.remainingHint ? config.remainingHint({ currentBonus: leftoverBonus }) : ('💰 兑换后剩余' + magicLabel + '：' + leftoverBonus.toLocaleString())) + '</div>'
                + '<div class="kf-progress-bar"><div class="kf-progress-fill" style="width:' + progressPercent + '%"></div></div>'
                + '</div>';

            if (firstBest && firstBest.price > 0) {
                var reserveTB = (availableBonus / firstBest.price) * firstBest.sizeGB / 1024;
                cardInfoHTML = '<div class="kf-info-total kf-reserve-highlight" style="font-size:12px;margin-top:6px;">储备上传量：' + magicLabel + '剩余 ' + availableBonus.toLocaleString() + ' / 最佳 ' + fmtSize(config, firstBest.sizeGB) + ' 兑换价格 ' + firstBest.price.toLocaleString() + ' ' + priceUnit + ' = ' + reserveTB.toFixed(3) + ' ' + uTB + '</div>';
            }
        } else {
            var hintRow = config.remainingHint ? '<div class="kf-info-total blocked-text">' + config.remainingHint(userData) + '</div>' : '';
            var needRow = '';
            if (strategy.needDownloadGB > 0 && config.showNeedDownload !== false) {
                var reserveBest = bestOptions[0];
                var reserveLine = '';
                if (reserveBest && reserveBest.price > 0) {
                    var reserveTB2 = (availableBonus / reserveBest.price) * reserveBest.sizeGB / 1024;
                    var bestSizeText = fmtSize(config, reserveBest.sizeGB);
                    var uTB2 = config.sizeUnitTB || 'TB';
                    reserveLine = '<div class="kf-info-total kf-reserve-highlight" style="font-size:12px;">储备上传量：' + magicLabel + '剩余 ' + availableBonus.toLocaleString() + ' / 最佳 ' + bestSizeText + ' 兑换价格 ' + reserveBest.price.toLocaleString() + ' ' + priceUnit + ' = ' + reserveTB2.toFixed(3) + ' ' + uTB2 + '</div>';
                }
                needRow = '<div class="kf-info-row"><span class="kf-info-label">⚠️ 需下载</span><span class="kf-info-value kf-need-download-highlight">' + fmtSize(config, strategy.needDownloadGB, 2) + '</span><span class="kf-info-unit">即可恢复兑换</span></div>' + reserveLine + '<div class="kf-progress-bar"><div class="kf-progress-fill blocked-fill" style="width:0%"></div></div>';
            }
            cardInfoHTML = '<div class="kf-info-panel blocked">' + needRow + hintRow + '</div>';
        }

        var bestCardClass = strategy.canExchange ? 'kf-best-card' : 'kf-best-card blocked';
        var allHistory = getHistory();
        var historyHTML = '<div class="kf-history-toggle" id="kf-history-toggle"><span>📜 兑换历史 (全部站点 ' + allHistory.length + ' 条)</span><span class="kf-arrow" id="kf-history-arrow">▼</span></div><div class="kf-history-content" id="kf-history-content"><div id="kf-history-body"></div></div>';
        var bannerHTML = '<div id="kf-banner-container"></div>';

        var autoCfg = getAutoConfig(config, config.defaultReserveBonus, config.defaultAutoInterval, config.lockAutoInterval);
        var warningHTML = config.autoExchangeWarning ? '<div class="kf-auto-warning">🚫 ' + config.autoExchangeWarning + '</div>' : '';

        var uploadLimitHTML = '';
        if (config.uploadLimitOptions && config.uploadLimitOptions.length) {
            var savedLimit = getUploadLimit(config);
            var quickBtnsHTML = config.uploadLimitOptions.map(function (o) {
                return '<button type="button" class="kf-limit-quick" data-value="' + o.value + '" title="点击设为 ' + o.value + ' TB" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#f8fafc;padding:2px 8px;font-size:11px;cursor:pointer;transition:all 0.2s;">' + o.label + '</button>';
            }).join('');
            uploadLimitHTML = '<label style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">上传量上限<input type="number" id="kf-upload-limit" value="' + savedLimit + '" step="1" min="1" max="10000" style="width:70px;" /><span style="font-size:12px;color:#94a3b8;">TB</span>' + quickBtnsHTML + '<span class="kf-config-hint" style="font-size:11px;">（达到上限后停止自动兑换）</span></label>';
        }

        var reservePresetsHTML = (config.reservePresets || []).map(function (p) {
            return '<button type="button" class="kf-reserve-preset" data-value="' + p.value + '" style="margin-left:6px;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#f8fafc;font-size:11px;cursor:pointer;">' + p.label + '</button>';
        }).join('');

        var intervalHTML = config.hideAutoInterval ? '' : '<label>间隔（秒）<input type="number" id="kf-auto-interval" value="' + (autoCfg.interval / 1000).toFixed(1) + '" step="0.1" min="0.5" /></label>';

        var hrCfg = getHrConfig(config);
        var hrTipHTML = (config.hrConfig && config.hrConfig.tip) ? '<span class="kf-tip-trigger" style="cursor:help;color:#fbbf24;font-size:14px;margin-left:2px;">ⓘ<span class="kf-tip-box">' + config.hrConfig.tip + '</span></span>' : '';
        var hrFieldsHTML = '<span id="kf-hr-fields" style="display:' + (hrCfg.enabled ? 'inline-flex' : 'none') + ';align-items:center;gap:12px;flex-wrap:wrap;"><label>最大次数<input type="number" id="kf-hr-max" value="' + hrCfg.maxCount + '" min="0" step="1" /><span style="font-size:12px;color:#94a3b8;">次</span></label><label>消除所需魔力<input type="number" id="kf-hr-cost" value="' + hrCfg.perCost + '" min="0" step="1000" /><span style="font-size:12px;color:#94a3b8;">魔力/个</span></label></span>';

        var configHTML = '<div class="kf-auto-config">'
            + '<label><input type="checkbox" id="kf-auto-enable" ' + (autoCfg.enabled ? 'checked' : '') + ' /><span>自动兑换</span></label>'
            + intervalHTML
            + '<label><input type="checkbox" id="kf-hr-enable" ' + (hrCfg.enabled ? 'checked' : '') + ' /><span>H&R 规则</span></label>'
            + hrTipHTML + hrFieldsHTML
            + '<label>保留魔力值<input type="number" id="kf-reserve-bonus" value="' + autoCfg.reserveBonus + '" step="10000" min="0" style="width:90px;" />' + reservePresetsHTML + '</label>'
            + '<span class="kf-config-hint">（低于此值停止自动兑换）</span>'
            + uploadLimitHTML
            + '</div>';

        var countdownHTML = '<div id="kf-countdown-area" class="kf-countdown-area" style="' + (autoCfg.enabled ? 'display:block;' : 'display:none;') + '">⏳ 下次自动兑换: <span id="kf-countdown-timer" class="kf-countdown-timer">--</span> 秒<div id="kf-stop-reason" class="kf-stop-reason" style="display:none;"></div></div>';

        var iconHTML;
        if (config.emoji) iconHTML = '<span style="font-size:20px;line-height:1;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;">' + config.emoji + '</span>';
        else { var favicon = getSiteFavicon(); iconHTML = '<img src="' + favicon + '" onerror="this.style.display=\'none\'" />'; }

        var themeSelectHTML = config.hideThemeSelect ? '' : '<select id="kf-theme-select" class="kf-theme-select">' + Object.keys(THEMES).map(function (k) { return '<option value="' + k + '" ' + (k === currentTheme ? 'selected' : '') + '>' + THEMES[k].icon + ' ' + THEMES[k].name + '</option>'; }).join('') + '</select>';

        var ruleBanner = window._kf_rule_banner ? '<div class="kf-rule-banner" style="background:rgba(251,191,36,0.1);border-left:4px solid #fbbf24;padding:8px 16px;border-radius:6px;margin-bottom:12px;color:#fbbf24;">⚠️ ' + window._kf_rule_banner + '</div>' : '';

        var qtyRec = config.qtyInput ? computeQtyRecommendation(config, userData) : null;
        var bestCardsHTML = '';
        var isMultiBest = bestOptions.length > 1;

        bestOptions.forEach(function (best, index) {
            var btnClass = best.disabled ? 'kf-btn kf-btn-disabled' : 'kf-btn kf-btn-primary';
            var btnLabel = best.disabled ? '🔒 已禁用' : '立即兑换';
            var btnHTML = '<button class="' + btnClass + '" data-best-index="' + index + '" data-price="' + best.price + '" ' + (best.disabled ? 'disabled' : '') + '>' + btnLabel + '</button>';
            var badgeText = isMultiBest ? ('🏆 最佳 #' + (index + 1)) : '🏆 最佳';
            var qtyHTML = '';

            if (config.qtyInput && index === 0 && qtyRec) {
                if (qtyRec.blocked) {
                    qtyHTML = '<div style="flex:1 1 100%;margin-top:10px;padding:10px 14px;background:rgba(239,68,68,0.1);border-left:3px solid #f87171;border-radius:6px;"><div style="font-size:13px;font-weight:600;color:#fca5a5;">⛔ 当前不可兑换</div><div style="font-size:12px;color:#94a3b8;margin-top:4px;">' + qtyRec.reason + '</div></div>';
                } else {
                    qtyHTML = '<div style="flex:1 1 100%;margin-top:10px;padding:10px 14px;background:rgba(251,191,36,0.08);border-left:3px solid #fbbf24;border-radius:6px;"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><label for="kf-qty-input" style="font-size:13px;color:#94a3b8;font-weight:500;">购买件数</label><input type="number" id="kf-qty-input" min="0" step="10" value="' + qtyRec.qty + '" style="width:90px;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#f8fafc;font-size:13px;outline:none;" /><span style="font-size:12px;color:#94a3b8;">件（10 件起自动 9 折）</span></div><div style="font-size:12px;color:#94a3b8;margin-top:6px;">推荐 <b style="color:#fbbf24;" id="kf-qty-recommend">' + qtyRec.qty + '</b> 件 · 共 <b style="color:#fbbf24;" id="kf-qty-size">' + (qtyRec.qty * (config.qtyInput.unitSizeGB || 1)).toFixed(0) + '</b> GB · 花费 <b style="color:#fbbf24;" id="kf-qty-cost">' + qtyRec.cost.toLocaleString() + '</b> 魔力</div></div>';
                }
            }

            bestCardsHTML += '<div class="' + bestCardClass + '" data-best-index="' + index + '" style="' + (index > 0 ? 'margin-top: 12px;' : '') + '">'
                + '<div class="kf-best-left-bar"></div>'
                + '<div class="kf-best-header"><span class="kf-badge">' + badgeText + '</span>' + (isMultiBest ? '<span style="font-size:12px;color:#94a3b8;">上传量 ' + fmtSize(config, best.sizeGB) + '</span>' : '') + '</div>'
                + '<div class="kf-best-body">'
                + '<div class="kf-best-spec"><div class="kf-best-size">' + fmtSize(config, best.sizeGB) + '</div><div class="kf-best-desc">上传量兑换</div></div>'
                + '<div class="kf-best-price"><div class="kf-best-price-label">价格</div><div><span class="kf-best-price-value">' + best.price.toLocaleString() + '</span><span class="kf-best-price-unit">' + (config.currency || '货币') + '</span></div><div class="kf-best-efficiency">⚡ ' + best.efficiency.toFixed(2) + ' MB/单位</div></div>'
                + (index === 0 ? cardInfoHTML : '')
                + qtyHTML
                + btnHTML
                + '</div></div>';
        });

        var isKeepfrds = config.name === 'KEEPFRDS';
        var statsGridClass = isKeepfrds ? 'kf-stats-grid kf-stats-grid-5' : 'kf-stats-grid';
        var levelCardHTML = isKeepfrds ? '<div class="kf-stat-card"><div class="kf-stat-label">等级</div><div class="kf-stat-value">' + (userData.level || '-') + '</div></div>' : '';
        var keepfrdsTipHTML = isKeepfrds ? '<div class="kf-mteam-warning" style="margin:12px 0;text-align:center;font-weight:800;color:#fde047;background:rgba(251,191,36,0.18);border-left:6px solid #fbbf24;padding:12px 18px;border-radius:8px;">💡 无论是魔力兑换上传量，还是上传量兑换魔力，性价比完全相同，选哪一个都行；两者的兑换价格均扣除了 5% 手续费。</div>' : '';

        panel.innerHTML = '<div class="kf-header"><div class="kf-title">' + iconHTML + config.name + ' 兑换助手' + themeSelectHTML + '</div><div class="kf-status ' + statusClass + '"><span class="kf-status-dot"></span><span>' + statusText + '</span></div></div>'
            + warningHTML
            + (config.blockedNoticeHTML ? '<div class="kf-chd-notice" style="background:rgba(251,191,36,0.08);border-left:4px solid #fbbf24;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;line-height:1.8;color:#e2e8f0;">' + config.blockedNoticeHTML + '</div>' : '')
            + configHTML + countdownHTML + ruleBanner
            + (config.noticeHTML ? '<div class="kf-site-notice" style="background:rgba(0,180,80,0.08);border:1px solid rgba(0,180,80,0.3);border-radius:10px;padding:12px 16px;margin-bottom:12px;font-size:13px;line-height:1.8;color:#e2e8f0;">' + config.noticeHTML + '</div>' : '')
            + alertHTML + zeroDownloadNoticeHTML + bannerHTML
            + '<div class="' + statsGridClass + '">' + levelCardHTML
            + '<div class="kf-stat-card" id="kf-stat-ratio"><div class="kf-stat-label">分享率</div><div class="kf-stat-value">' + ratioDisplay + ratioStatus + '</div></div>'
            + '<div class="kf-stat-card" id="kf-stat-upload"><div class="kf-stat-label">上传量</div><div class="kf-stat-value" id="kf-upload-value">' + userData.uploadStr + '</div></div>'
            + '<div class="kf-stat-card"><div class="kf-stat-label">下载量</div><div class="kf-stat-value">' + downloadDisplay + '</div></div>'
            + '<div class="kf-stat-card"><div class="kf-stat-label">' + (config.currency || '货币') + '</div><div class="kf-stat-value gold">' + availableBonus.toLocaleString() + '</div></div>'
            + '</div>'
            + '<div class="kf-section-title">兑换选项（按性价比排序）' + (isMultiBest ? ' — 并列最佳已全部标注' : '') + '</div>'
            + globalSummaryHTML + keepfrdsTipHTML + bestCardsHTML
            + '<div id="kf-options-list"></div>' + historyHTML
            + '<div class="kf-footer">💡 最佳选项根据 MB/单位 性价比自动计算' + (isMultiBest ? '，多个并列最佳均已标注' : '') + '</div>';

        // ---------- 插入面板 ----------
        if (useAppend) {
            outer.appendChild(panel);
        } else {
            outer.insertBefore(panel, insertBeforeNode);
        }
        panel.style.setProperty('width', '100%', 'important');
        panel.style.setProperty('max-width', '100%', 'important');
        panel.style.setProperty('min-width', '0', 'important');
        panel.style.setProperty('flex', '0 0 100%', 'important');
        panel.style.setProperty('grid-column', '1 / -1', 'important');
        panel.style.setProperty('box-sizing', 'border-box', 'important');
        panel.style.setProperty('clear', 'both', 'important');
        panel.style.setProperty('float', 'none', 'important');
        try {
            var pStyle = window.getComputedStyle(outer);
            if (pStyle.display === 'flex' || pStyle.display === 'inline-flex') outer.style.setProperty('flex-wrap', 'wrap', 'important');
        } catch (e) {}

        // ---------- 输入框尺寸统一 ----------
        var forceInputSizes = function () {
            var themeClasses = panel.className;
            var ctrlBg, ctrlColor, ctrlBorder, ctrlBoxShadow;
            if (themeClasses.indexOf('kf-theme-elegant') !== -1) { ctrlBg = '#f1f5f9'; ctrlColor = '#0f172a'; ctrlBorder = '1px solid #e2e8f0'; ctrlBoxShadow = 'none'; }
            else if (themeClasses.indexOf('kf-theme-neumorphism') !== -1) { ctrlBg = '#fdf3d0'; ctrlColor = '#3d2b1f'; ctrlBorder = '1px solid #d4af37'; ctrlBoxShadow = 'inset 0 1px 3px rgba(0,0,0,0.1)'; }
            else { ctrlBg = 'rgba(255,255,255,0.08)'; ctrlColor = '#f8fafc'; ctrlBorder = '1px solid rgba(255,255,255,0.15)'; ctrlBoxShadow = 'none'; }
            var inputs = panel.querySelectorAll('.kf-auto-config input[type="number"]');
            inputs.forEach(function (inp) {
                inp.style.setProperty('width', '60px', 'important');
                inp.style.setProperty('max-width', '60px', 'important');
                inp.style.setProperty('min-width', '0', 'important');
                inp.style.setProperty('flex', '0 0 auto', 'important');
                inp.style.setProperty('box-sizing', 'border-box', 'important');
                inp.style.setProperty('height', '24px', 'important');
                inp.style.setProperty('min-height', '0', 'important');
                inp.style.setProperty('max-height', '24px', 'important');
                inp.style.setProperty('padding', '0 6px', 'important');
                inp.style.setProperty('margin', '0', 'important');
                inp.style.setProperty('font-size', '13px', 'important');
                inp.style.setProperty('line-height', '22px', 'important');
                inp.style.setProperty('border-radius', '4px', 'important');
                inp.style.setProperty('background', ctrlBg, 'important');
                inp.style.setProperty('color', ctrlColor, 'important');
                inp.style.setProperty('border', ctrlBorder, 'important');
                inp.style.setProperty('box-shadow', ctrlBoxShadow, 'important');
                inp.style.setProperty('outline', 'none', 'important');
                inp.style.setProperty('vertical-align', 'middle', 'important');
            });
            var sel = panel.querySelector('.kf-theme-select');
            if (sel) {
                sel.style.setProperty('background', ctrlBg, 'important');
                sel.style.setProperty('color', ctrlColor, 'important');
                sel.style.setProperty('border', ctrlBorder, 'important');
                sel.style.setProperty('box-shadow', ctrlBoxShadow, 'important');
                sel.style.setProperty('padding', '4px 10px', 'important');
                sel.style.setProperty('border-radius', '6px', 'important');
                sel.style.setProperty('max-width', '160px', 'important');
                sel.style.setProperty('box-sizing', 'border-box', 'important');
                sel.style.setProperty('font-size', '13px', 'important');
            }
        };

        (function setupTooltips() {
            var triggers = panel.querySelectorAll('.kf-tip-trigger');
            if (!triggers.length) return;
            triggers.forEach(function (trigger) {
                var box = trigger.querySelector('.kf-tip-box'); if (!box) return;
                box.style.display = 'none';
                if (box.parentNode) box.parentNode.removeChild(box);
                void document.body.offsetHeight;
                document.body.appendChild(box);
                void box.offsetHeight;
                var hideTimer = null;
                trigger.addEventListener('mouseenter', function () { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } box.style.display = 'block'; });
                trigger.addEventListener('mouseleave', function () { hideTimer = setTimeout(function () { box.style.display = 'none'; hideTimer = null; }, 200); });
                box.addEventListener('mouseenter', function () { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
                box.addEventListener('mouseleave', function () { box.style.display = 'none'; });
            });
            void document.body.offsetHeight;
        })();

        forceInputSizes();
        setTimeout(forceInputSizes, 300);
        setTimeout(forceInputSizes, 1500);
        try {
            var mo = new MutationObserver(forceInputSizes);
            mo.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
            var oldRemove = panel.remove.bind(panel);
            panel.remove = function () { try { mo.disconnect(); } catch (e) {} oldRemove(); };
        } catch (e) {}

        var select = document.getElementById('kf-theme-select');
        if (select && !config.hideThemeSelect) select.addEventListener('change', function () { switchTheme(panel, this.value); });

        // ---------- 自动兑换 / H&R 配置交互 ----------
        var enableCheckbox = document.getElementById('kf-auto-enable');
        var intervalInput = document.getElementById('kf-auto-interval');
        var reserveInput = document.getElementById('kf-reserve-bonus');
        var countdownArea = document.getElementById('kf-countdown-area');
        var stopReason = document.getElementById('kf-stop-reason');

        if (enableCheckbox && reserveInput) {
            var clampReserveByHr = function (val) {
                var hrMin = getHrReserveMin(config);
                if (hrMin > 0 && val < hrMin) return hrMin;
                return val;
            };
            var saveAutoFromUI = function () {
                var enabled = enableCheckbox.checked;
                var interval = intervalInput ? parseFloat(intervalInput.value) : (config.defaultAutoInterval || 11000) / 1000;
                if (isNaN(interval) || interval < 0.5) interval = 0.5;
                var reserve = parseFloat(reserveInput.value);
                if (isNaN(reserve) || reserve < 0) reserve = 0;
                var clamped = clampReserveByHr(reserve);
                if (clamped !== reserve) { reserve = clamped; reserveInput.value = reserve; }
                saveAutoConfig(config, { enabled: enabled, interval: Math.round(interval * 1000), reserveBonus: reserve });
                if (countdownArea) countdownArea.style.display = enabled ? 'block' : 'none';
                if (!enabled && window._countdownInterval) {
                    clearInterval(window._countdownInterval);
                    window._countdownInterval = null;
                    var ts = document.getElementById('kf-countdown-timer');
                    if (ts) ts.textContent = '--';
                    if (stopReason) stopReason.style.display = 'none';
                }
            };
            enableCheckbox.addEventListener('change', saveAutoFromUI);
            if (intervalInput) {
                intervalInput.addEventListener('change', saveAutoFromUI);
                intervalInput.addEventListener('blur', saveAutoFromUI);
                intervalInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { saveAutoFromUI(); this.blur(); } });
            }
            reserveInput.addEventListener('change', saveAutoFromUI);
            reserveInput.addEventListener('blur', saveAutoFromUI);
            reserveInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { saveAutoFromUI(); this.blur(); } });
            panel.querySelectorAll('.kf-reserve-preset').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    reserveInput.value = clampReserveByHr(this.dataset.value);
                    reserveInput.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });

            var hrEnableCheckbox = document.getElementById('kf-hr-enable');
            var hrFields = document.getElementById('kf-hr-fields');
            var hrMaxInput = document.getElementById('kf-hr-max');
            var hrCostInput = document.getElementById('kf-hr-cost');

            if (hrEnableCheckbox && hrMaxInput && hrCostInput) {
                var saveHrFromUI = function (applyToReserve) {
                    var enabled = hrEnableCheckbox.checked;
                    var maxCount = parseInt(hrMaxInput.value, 10);
                    if (isNaN(maxCount) || maxCount < 0) maxCount = 0;
                    var perCost = parseInt(hrCostInput.value, 10);
                    if (isNaN(perCost) || perCost < 0) perCost = 0;
                    hrMaxInput.value = maxCount;
                    hrCostInput.value = perCost;
                    saveHrConfig(config, { enabled: enabled, maxCount: maxCount, perCost: perCost });
                    if (hrFields) hrFields.style.display = enabled ? 'inline-flex' : 'none';
                    if (applyToReserve && enabled) {
                        var hrReserve = maxCount * perCost;
                        if (hrReserve > 0) {
                            reserveInput.value = hrReserve;
                            reserveInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                };
                hrEnableCheckbox.addEventListener('change', function () { saveHrFromUI(true); });
                hrMaxInput.addEventListener('change', function () { saveHrFromUI(true); });
                hrMaxInput.addEventListener('blur', function () { saveHrFromUI(true); });
                hrMaxInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { saveHrFromUI(true); this.blur(); } });
                hrCostInput.addEventListener('change', function () { saveHrFromUI(true); });
                hrCostInput.addEventListener('blur', function () { saveHrFromUI(true); });
                hrCostInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { saveHrFromUI(true); this.blur(); } });
            }
        }

        var uploadLimitInput = document.getElementById('kf-upload-limit');
        if (uploadLimitInput) {
            var saveLimit = function () {
                var v = parseFloat(uploadLimitInput.value);
                if (isNaN(v) || v <= 0) v = config.uploadLimitTB || 24;
                if (v < 1) v = 1;
                if (v > 10000) v = 10000;
                uploadLimitInput.value = v;
                saveUploadLimit(config, v);
            };
            uploadLimitInput.addEventListener('change', saveLimit);
            uploadLimitInput.addEventListener('blur', saveLimit);
            uploadLimitInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { saveLimit(); this.blur(); } });
            saveUploadLimit(config, uploadLimitInput.value);
        }
        panel.querySelectorAll('.kf-limit-quick').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var v = this.dataset.value;
                var input = document.getElementById('kf-upload-limit');
                if (input) { input.value = v; saveUploadLimit(config, v); }
            });
        });

        var toggle = document.getElementById('kf-history-toggle');
        var content = document.getElementById('kf-history-content');
        var arrow = document.getElementById('kf-history-arrow');
        if (toggle && content && arrow) toggle.addEventListener('click', function () { var isOpen = content.classList.toggle('open'); arrow.classList.toggle('open', isOpen); });

        // ---------- 历史记录渲染 ----------
        (function renderHistory() {
            var body = document.getElementById('kf-history-body'); if (!body) return;
            var PAGE_SIZE = 10; var page = 0;
            function render() {
                if (allHistory.length === 0) { body.innerHTML = '<div class="kf-history-empty">暂无兑换记录</div>'; return; }
                var totalPages = Math.ceil(allHistory.length / PAGE_SIZE);
                if (page >= totalPages) page = totalPages - 1;
                var items = allHistory.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map(function (h) {
                    return '<li class="kf-history-item"><span class="kf-h-time">' + formatTime(h.timestamp) + '</span><span class="kf-h-site">' + (h.site || '') + '</span><span class="kf-h-detail">' + fmtSize(config, h.sizeGB, 1) + '</span><span class="kf-h-increase">+' + fmtSize(config, h.increaseGB, 2) + '</span></li>';
                }).join('');
                var pager = '';
                if (totalPages > 1) {
                    var nums = [];
                    for (var i = 0; i < totalPages; i++) nums.push('<button data-page="' + i + '" class="' + (i === page ? 'active' : '') + '">' + (i + 1) + '</button>');
                    pager = '<div class="kf-history-pager"><button data-page="' + (page - 1) + '" ' + (page === 0 ? 'disabled' : '') + '>‹</button>' + nums.join('') + '<button data-page="' + (page + 1) + '" ' + (page === totalPages - 1 ? 'disabled' : '') + '>›</button></div>';
                }
                body.innerHTML = '<ul class="kf-history-list">' + items + '</ul>' + pager;
                body.querySelectorAll('.kf-history-pager button').forEach(function (btn) {
                    btn.addEventListener('click', function () { var p = parseInt(btn.dataset.page, 10); if (!isNaN(p) && p >= 0 && p < totalPages) { page = p; render(); } });
                });
            }
            render();
        })();

        // ---------- 兑换按钮（含 Bug 1 修复） ----------
        panel.querySelectorAll('.kf-best-card .kf-btn-primary[data-best-index]').forEach(function (btn) {
            var index = parseInt(btn.dataset.bestIndex, 10);
            var best = bestOptions[index];
            if (!best) return;
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                if (window._countdownInterval) { clearInterval(window._countdownInterval); window._countdownInterval = null; var ts = document.getElementById('kf-countdown-timer'); if (ts) ts.textContent = '--'; if (stopReason) stopReason.style.display = 'none'; }
                savePendingExchange({ site: config.name, uploadGB: userData.uploadGB, option: { sizeGB: best.sizeGB, price: best.price, efficiency: best.efficiency, desc: best.desc }, timestamp: Date.now() });

                // [Fix] 仅 index===0 的卡片带 kf-qty-input；其他索引走 default click
                if (config.qtyInput && index === 0) {
                    var qtyEl = document.getElementById('kf-qty-input');
                    var qty = qtyEl ? parseInt(qtyEl.value, 10) : 0;
                    if (!qty || qty <= 0 || qty % config.qtyInput.step !== 0) { alert('请输入 ' + config.qtyInput.step + ' 的整数倍'); return; }
                    var optInput = document.querySelector('form input[name="option"][value="' + config.qtyInput.optionValue + '"]');
                    var form = optInput ? (optInput.form || optInput.closest('form')) : null;
                    if (form) { var bc = form.querySelector('input[name="buy_count"]'); if (bc) bc.value = qty; if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit(); }
                } else if (typeof best.customSubmit === 'function') {
                    best.customSubmit();
                } else if (best.btn) {
                    best.btn.click();
                }
            });
        });

        // ---------- 非最佳选项列表 ----------
        var optionsList = document.getElementById('kf-options-list');
        var bestSizeSet = {};
        bestOptions.forEach(function (o) { bestSizeSet[o.sizeGB] = true; });
        var otherOptions = strategy.allOptions.filter(function (o) { return !bestSizeSet[o.sizeGB]; });
        otherOptions.forEach(function (opt, idx) {
            var card = document.createElement('div');
            card.className = 'kf-option-card';
            var btnClass = opt.disabled ? 'kf-option-btn-disabled' : 'kf-option-btn-active';
            var btnText = opt.disabled ? '🔒 已禁用' : '兑换';
            card.innerHTML = '<div class="kf-option-rank">#' + (idx + 1) + '</div>'
                + '<div class="kf-option-spec"><div class="kf-option-size">' + fmtSize(config, opt.sizeGB) + '</div><div class="kf-option-desc">上传量</div></div>'
                + '<div class="kf-option-price"><div><span class="kf-option-price-value">' + opt.price.toLocaleString() + '</span><span class="kf-option-price-unit">' + (config.currency || '货币') + '</span></div><div class="kf-option-efficiency">⚡ ' + opt.efficiency.toFixed(2) + ' MB/单位</div></div>'
                + '<div class="kf-option-spacer"></div>'
                + '<button class="kf-option-btn ' + btnClass + '" ' + (opt.disabled ? 'disabled' : '') + '>' + btnText + '</button>';
            optionsList.appendChild(card);
            var btn = card.querySelector('.kf-option-btn-active');
            if (btn && (opt.btn || typeof opt.customSubmit === 'function')) {
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    savePendingExchange({ site: config.name, uploadGB: userData.uploadGB, option: { sizeGB: opt.sizeGB, price: opt.price, efficiency: opt.efficiency, desc: opt.desc }, timestamp: Date.now() });
                    if (typeof opt.customSubmit === 'function') { try { opt.customSubmit(); } catch (err) { console.error(err); } }
                    else if (opt.btn) opt.btn.click();
                });
            }
        });

        // ---------- 进度条动画 ----------
        setTimeout(function () {
            panel.querySelectorAll('.kf-progress-fill').forEach(function (fill) {
                var targetWidth = fill.style.width;
                fill.style.width = '0%';
                requestAnimationFrame(function () { fill.style.width = targetWidth; });
            });
        }, 100);

        // ---------- 高亮原生行 ----------
        bestOptions.forEach(function (best) {
            if (best.row && best.row.tagName === 'TR') {
                best.row.style.cssText = 'background: linear-gradient(90deg, rgba(251,191,36,0.08) 0%, rgba(251,191,36,0.02) 100%) !important; border-left: 3px solid #fbbf24 !important; transition: all 0.3s;';
                best.row.querySelectorAll('td').forEach(function (td) { td.style.background = 'transparent'; td.style.transition = 'all 0.3s'; });
            } else if (best.row && best.row.classList) {
                best.row.style.border = '2px solid #fbbf24';
                best.row.style.boxShadow = '0 0 20px rgba(251,191,36,0.3)';
            }
        });

        // ---------- 效率小徽章 ----------
        strategy.allOptions.forEach(function (opt) {
            if (opt.price <= 0) return;
            var insertContainer = opt.priceCell || null;
            var insertBeforeNode2 = null;
            if (config.efficiencyBetweenSizeAndPrice && opt.descCell && opt.descCell.parentElement && opt.priceCell) {
                var container = opt.descCell.parentElement;
                if (container.contains(opt.priceCell)) { insertContainer = container; insertBeforeNode2 = opt.priceCell; }
            }
            if (!insertContainer && config.efficiencyInsertSelector && opt.row) {
                insertContainer = opt.row.querySelector(config.efficiencyInsertSelector);
                if (insertContainer && config.efficiencyInsertBeforeSelector) insertBeforeNode2 = insertContainer.querySelector(config.efficiencyInsertBeforeSelector);
            }
            if (!insertContainer) return;
            if (insertContainer.querySelector('.kufei-efficiency')) return;
            var effDiv = document.createElement('div');
            effDiv.className = 'kufei-efficiency';
            effDiv.style.cssText = 'font-size: 11px; color: #78350f; margin-top: 4px; font-weight: 800; padding: 2px 8px; border-radius: 6px; background: linear-gradient(135deg, #fef3c7, #fde68a); border: 1px solid #f59e0b; display: inline-block; box-shadow: 0 1px 3px rgba(0,0,0,0.15); white-space: nowrap; line-height: 1.35;';
            effDiv.textContent = '⚡ ' + opt.efficiency.toFixed(2) + ' MB/单位';
            if (insertBeforeNode2) { effDiv.style.marginTop = '0'; effDiv.style.marginLeft = 'auto'; effDiv.style.marginRight = 'auto'; insertContainer.insertBefore(effDiv, insertBeforeNode2); }
            else insertContainer.appendChild(effDiv);
        });

        if (config.injectRuleText && !document.getElementById('kf-injected-rule')) {
            var injectTarget = document.querySelector('.bonus-shop__note') || document.querySelector('.bonus-shop__hero') || document.querySelector('#outer') || document.body;
            if (injectTarget) {
                var ruleDiv = document.createElement('div');
                ruleDiv.id = 'kf-injected-rule';
                ruleDiv.className = 'kf-rule-highlight';
                ruleDiv.textContent = config.injectRuleText;
                if (injectTarget.classList.contains('bonus-shop__note')) injectTarget.parentNode.insertBefore(ruleDiv, injectTarget.nextSibling);
                else injectTarget.insertBefore(ruleDiv, injectTarget.firstChild);
            }
        }

        highlightNativeRules(config);
        setTimeout(function () { highlightNativeRules(config); }, 500);
        if (DEBUG) log('[' + config.name + '助手] UI注入完成');
    }

    // ============================================================
    // scheduleAutoExchange（完整）
    // ============================================================
    function scheduleAutoExchange(config, currentBonus, minPrice) {
        var cfg = getAutoConfig(config, config.defaultReserveBonus, config.defaultAutoInterval, config.lockAutoInterval);
        var area = document.getElementById('kf-countdown-area');
        var timerSpan = document.getElementById('kf-countdown-timer');
        var stopReason = document.getElementById('kf-stop-reason');

        var minAvailablePrice = 0;
        var bestBtnsNow = document.querySelectorAll('.kf-best-card .kf-btn-primary[data-best-index]');
        bestBtnsNow.forEach(function (b) {
            if (b.disabled) return;
            var p = parseFloat(b.dataset.price || '0');
            if (p > 0 && (minAvailablePrice === 0 || p < minAvailablePrice)) minAvailablePrice = p;
        });
        if (minAvailablePrice === 0 && typeof minPrice === 'number' && minPrice > 0) minAvailablePrice = minPrice;
        window._kf_min_price = minAvailablePrice;
        var effectiveMinPrice = minAvailablePrice;

        if (!cfg.enabled) { if (area) area.style.display = 'none'; if (timerSpan) timerSpan.textContent = '--'; if (stopReason) stopReason.style.display = 'none'; if (window._countdownInterval) { clearInterval(window._countdownInterval); window._countdownInterval = null; } return; }
        if (currentBonus <= cfg.reserveBonus) { if (area) area.style.display = 'block'; if (timerSpan) timerSpan.textContent = '--'; if (stopReason) { stopReason.style.display = 'block'; stopReason.textContent = '⛔ 已达到保留魔力值（' + cfg.reserveBonus + '），停止自动兑换'; } if (window._countdownInterval) { clearInterval(window._countdownInterval); window._countdownInterval = null; } return; }
        if (effectiveMinPrice > 0 && currentBonus < effectiveMinPrice) { if (area) area.style.display = 'block'; if (timerSpan) timerSpan.textContent = '--'; if (stopReason) { stopReason.style.display = 'block'; stopReason.textContent = '⛔ 魔力不足以兑换一次（需 ' + effectiveMinPrice.toLocaleString() + '），停止自动兑换'; } if (window._countdownInterval) { clearInterval(window._countdownInterval); window._countdownInterval = null; } return; }
        if (config.uploadLimitOptions && config.uploadLimitOptions.length) {
            var limitTB = getUploadLimit(config);
            if (limitTB > 0) {
                var cachedData = window._kf_last_user_data || {};
                var currentUploadGB = (typeof cachedData.uploadGB === 'number') ? cachedData.uploadGB : 0;
                if (currentUploadGB >= limitTB * 1024) { if (area) area.style.display = 'block'; if (timerSpan) timerSpan.textContent = '--'; if (stopReason) { stopReason.style.display = 'block'; stopReason.textContent = '⛔ 上传量已达上限（' + limitTB + ' TB），停止自动兑换'; } if (window._countdownInterval) { clearInterval(window._countdownInterval); window._countdownInterval = null; } return; }
            }
        }

        if (stopReason) stopReason.style.display = 'none';
        if (area) area.style.display = 'block';
        var remaining = cfg.interval / 1000;
        if (timerSpan) timerSpan.textContent = remaining.toFixed(1);
        if (window._countdownInterval) { clearInterval(window._countdownInterval); window._countdownInterval = null; }
        window._countdownInterval = setInterval(function () {
            remaining -= 0.1;
            if (remaining <= 0) {
                clearInterval(window._countdownInterval); window._countdownInterval = null;
                if (timerSpan) timerSpan.textContent = '0.0';
                var cached = window._kf_last_user_data || {};
                var currentBonusNow = typeof cached.currentBonus === 'number' ? cached.currentBonus : 0;
                if (currentBonusNow <= cfg.reserveBonus) { if (stopReason) { stopReason.style.display = 'block'; stopReason.textContent = '⛔ 已达到保留魔力值（' + cfg.reserveBonus + '），停止自动兑换'; } return; }
                var minPriceNow = window._kf_min_price || 0;
                if (minPriceNow > 0 && currentBonusNow < minPriceNow) { if (stopReason) { stopReason.style.display = 'block'; stopReason.textContent = '⛔ 魔力不足以兑换一次（需 ' + minPriceNow.toLocaleString() + '），停止自动兑换'; } return; }
                if (config.uploadLimitOptions && config.uploadLimitOptions.length) {
                    var limitTB2 = getUploadLimit(config);
                    if (limitTB2 > 0) {
                        var currentUploadGB2 = (typeof cached.uploadGB === 'number') ? cached.uploadGB : 0;
                        if (currentUploadGB2 >= limitTB2 * 1024) { if (stopReason) { stopReason.style.display = 'block'; stopReason.textContent = '⛔ 上传量已达上限（' + limitTB2 + ' TB），停止自动兑换'; } return; }
                    }
                }
                var bestBtns = document.querySelectorAll('.kf-best-card .kf-btn-primary[data-best-index]');
                var clicked = false;
                for (var i = 0; i < bestBtns.length; i++) {
                    var btn = bestBtns[i];
                    if (btn.disabled) continue;
                    var price = parseFloat(btn.dataset.price || '0');
                    if (price > 0 && currentBonusNow < price) continue;
                    if (cfg.reserveBonus > 0 && (currentBonusNow - price) < cfg.reserveBonus) continue;
                    btn.click();
                    clicked = true;
                    break;
                }
                if (!clicked && area) area.style.display = 'none';
            } else {
                if (timerSpan) timerSpan.textContent = remaining.toFixed(1);
            }
        }, 100);
    }

    // ============================================================
    // 兑换成功反馈
    // ============================================================
    function showSuccessBanner(config, increaseGB, optionSizeGB) {
        var container = document.getElementById('kf-banner-container'); if (!container) return;
        var sizeDisplay = fmtSize(config, optionSizeGB, 1);
        var increaseDisplay = fmtSize(config, increaseGB, 2);
        var banner = document.createElement('div');
        banner.className = 'kf-banner';
        banner.innerHTML = '<span class="kf-banner-message">✅ 兑换成功！上传量增加 ' + increaseDisplay + '（期望 ' + sizeDisplay + '）</span><button class="kf-banner-close" id="kf-banner-close">✕</button>';
        container.appendChild(banner);
        var timeout = setTimeout(function () { banner.style.animation = 'kf-fade-out 0.6s ease-out forwards'; setTimeout(function () { banner.remove(); }, 700); }, 5000);
        var closeBtn = banner.querySelector('#kf-banner-close');
        if (closeBtn) closeBtn.addEventListener('click', function () { clearTimeout(timeout); banner.style.animation = 'kf-fade-out 0.3s ease-out forwards'; setTimeout(function () { banner.remove(); }, 400); });
    }

    function showUploadIncrease(config, increaseGB) {
        var uploadCard = document.getElementById('kf-upload-value'); if (!uploadCard) return;
        var old = uploadCard.querySelector('.kf-upload-increase'); if (old) old.remove();
        var increaseDisplay = fmtSize(config, increaseGB, 2);
        var span = document.createElement('span');
        span.className = 'kf-upload-increase';
        span.textContent = '+' + increaseDisplay;
        uploadCard.appendChild(span);
        setTimeout(function () { span.classList.add('fade-out'); setTimeout(function () { span.remove(); }, 800); }, 2000);
    }

    // ============================================================
    // 版本校验工具（供主脚本调用）
    // ============================================================
    function assertVersion(minVersion) {
        if (!minVersion) return true;
        function toNum(v) {
            return String(v || '').split('.').reduce(function (acc, n, i) {
                return acc + (parseInt(n, 10) || 0) * Math.pow(1000, 2 - i);
            }, 0);
        }
        var cur = toNum('1.0.1');
        var need = toNum(minVersion);
        if (cur < need) {
            console.error('[PT Exchange Core] 版本不匹配：期望 ≥ ' + minVersion + '，实际 1.0.1。请升级 @require 中的 CDN 版本号。');
            return false;
        }
        return true;
    }

    // ============================================================
    // 对外暴露 API
    // ============================================================
    W.KFExchange = {
        version: '1.0.1',
        DEBUG: DEBUG,
        log: log,

        THEMES: THEMES,
        DEFAULT_AUTO_ENABLED: DEFAULT_AUTO_ENABLED,
        DEFAULT_AUTO_INTERVAL: DEFAULT_AUTO_INTERVAL,
        DEFAULT_RESERVE_BONUS: DEFAULT_RESERVE_BONUS,
        DEFAULT_THEME: DEFAULT_THEME,
        DEFAULT_PANEL_ID: DEFAULT_PANEL_ID,
        PANEL_CLASS: PANEL_CLASS,

        parseSizeToGB: parseSizeToGB,
        formatGB: formatGB,
        fmtSize: fmtSize,
        getCsrfToken: getCsrfToken,
        getSiteFavicon: getSiteFavicon,
        siteKey: siteKey,
        formatTime: formatTime,

        getTheme: getTheme,
        saveTheme: saveTheme,
        getAutoConfig: getAutoConfig,
        saveAutoConfig: saveAutoConfig,
        getUploadLimit: getUploadLimit,
        saveUploadLimit: saveUploadLimit,
        migrateHrConfigOnce: migrateHrConfigOnce,
        getHrConfig: getHrConfig,
        saveHrConfig: saveHrConfig,
        getHrReserveMin: getHrReserveMin,
        cleanupLegacyGlobalKeys: cleanupLegacyGlobalKeys,

        getPendingExchange: getPendingExchange,
        savePendingExchange: savePendingExchange,
        clearPendingExchange: clearPendingExchange,
        getHistory: getHistory,
        addHistoryRecord: addHistoryRecord,
        checkPendingExchange: checkPendingExchange,

        computeQtyRecommendation: computeQtyRecommendation,
        getKeepfrdsRequiredRatio: getKeepfrdsRequiredRatio,

        injectThemeStyles: injectThemeStyles,
        injectMTeamStyles: injectMTeamStyles,
        switchTheme: switchTheme,
        highlightNativeRules: highlightNativeRules,

        injectUI: injectUI,
        scheduleAutoExchange: scheduleAutoExchange,
        showSuccessBanner: showSuccessBanner,
        showUploadIncrease: showUploadIncrease,

        assertVersion: assertVersion
    };

    log('[PT Exchange Core] v1.0.1 已加载');

})();