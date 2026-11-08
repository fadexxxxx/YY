// #region js.js 依赖的旧钩子（空实现，保持兼容）
var detailImportActive = false;
var detailImportMonths = new Set();
var detailImportUpdatedMiniByMonth = {};
function applyDetailImportHighlights() {}
function bindDetailImportEditing() {}
// #endregion

//#region 账本与接口

const MANUAL_API_BASE = '';
const LEDGER_API_BASE = MANUAL_API_BASE
    ? MANUAL_API_BASE.replace(/\/+$/, '')
    : (window.location.protocol === 'file:'
        ? 'http://127.0.0.1:29999'
        : (window.location.origin || '').replace(/\/+$/, ''));
let apiAvailable = true;
let apiConnectLogged = false;

async function fetchJsonSafe(url, options) {
    try {
        options = Object.assign({ cache: 'no-store' }, options || {});
        const separator = url.includes('?') ? '&' : '?';
        const noCacheUrl = url + separator + '_t=' + new Date().getTime();

        const res = await fetch(noCacheUrl, options);
        if (!res.ok) {
            apiAvailable = false;
            return null;
        }
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.indexOf('application/json') === -1) {
            apiAvailable = false;
            return null;
        }
        const json = await res.json();
        apiAvailable = true;
        if (!apiConnectLogged && json && json.ok) {
            apiConnectLogged = true;
        }
        return json;
    } catch (_) {
        apiAvailable = false;
        return null;
    }
}
const monthLabels = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const defaultMonthData = (() => {
    const _defaultYear = new Date().getFullYear();
    return Array.from({ length: 12 }, (_, _mi) => {
        const _daysInMonth = new Date(_defaultYear, _mi + 1, 0).getDate();
        return {
            profit: 0,
            sales: 0,
            expense: 0,
            salesBreakdown: { Check: 0, cash: 0, cost: 0, uber: 0, riceball: 0, panda: 0, bm: 0 },
            totalOverrides: { Check: null, uber: null, riceball: null, panda: null, bm: null },
            salaryRows: Array.from({ length: 17 }, () => ["", "", ""]),
            salaryCheckRows: Array.from({ length: 17 }, () => ["", "", ""]),
            salaryTotal: 0,
            costExpenses: Array.from({ length: 8 }, () => ["", ""]),
            costTotal: 0,
            costOthersExpenses: Array.from({ length: 8 }, () => ["", ""]),
            othersExpenses: Array.from({ length: 8 }, () => ["", ""]),
            othersTotal: 0,
            cashDays: new Array(_daysInMonth).fill(''),
            checkDays: new Array(_daysInMonth).fill(''),
            deliveryDetails: { uber: [], riceball: [], panda: [], bm: [], dinein: [] },
            checks: [],
            checkTexts: []
        };
    });
})();

let monthData = JSON.parse(JSON.stringify(defaultMonthData));
let ledgerLoaded = false;
let pendingLedgerSave = false;
let suppressLedgerSave = false;
let ledgerYears = loadLedgerYears();
let currentYear = ledgerYears[0] || new Date().getFullYear();
let pendingDeleteYear = null;
let pendingDeleteQzIndex = -1;
let yearEditMode = false;
let yearInputActive = false;
let yearRemoveMode = false;
let yearRemoveSelected = null;
let yearPageStart = 0;

let currentMonth = new Date().getMonth();
const printPreviewYearCache = new Map();

const APP_PREF_KEYS = {
    TR_REPORT: 'tr_report',
    PRINT: 'print',
};
let appPrefSaveTimers = {};

async function loadAppPref(key) {
    const json = await fetchJsonSafe(`${LEDGER_API_BASE}/prefs/load?key=${encodeURIComponent(key)}`);
    if (json && json.ok && json.data && typeof json.data === 'object') return json.data;
    return null;
}

function queueAppPrefSave(key, data) {
    if (appPrefSaveTimers[key]) clearTimeout(appPrefSaveTimers[key]);
    appPrefSaveTimers[key] = setTimeout(() => {
        appPrefSaveTimers[key] = null;
        fetchJsonSafe(`${LEDGER_API_BASE}/prefs/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, data }),
        }).catch(() => { });
    }, 200);
}

function isReadonlyMode() {
    return document.body.classList.contains('readonly-mode');
}

function saveToStorage() {
    if (isReadonlyMode()) return;
    if (suppressLedgerSave) return;
    if (!ledgerLoaded) {
        pendingLedgerSave = true;
        return;
    }
    fetchJsonSafe(LEDGER_API_BASE + '/ledger/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: currentYear, data: monthData })
    }).then(function (json) {
        if (json && json.ok) {
        }
    });
}

function loadFromStorage() {
}

async function deleteLedgerYear(year) {
    if (isReadonlyMode()) return;
    suppressLedgerSave = true;
    pendingLedgerSave = false;
    try {
        const json = await fetchJsonSafe(LEDGER_API_BASE + '/ledger/delete-year', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year })
        });
        if (!(json && json.ok)) return;
        ledgerYears = ledgerYears.filter((item) => item !== year);
        saveLedgerYears();
        hideDeleteYearConfirm();
        closeCreateYearPanel();
        yearPageStart = 0;
        yearEditMode = false;
        yearInputActive = false;
        if (year === currentYear) {
            if (ledgerYears.length) {
                await loadLedgerYear(ledgerYears[0]);
            } else {
                currentYear = new Date().getFullYear();
                monthData = JSON.parse(JSON.stringify(defaultMonthData));
                renderYearPicker();
                renderMonthState();
            }
        } else {
            renderYearPicker();
        }
        await syncLedgerYearsFromDb();
    } finally {
        suppressLedgerSave = false;
    }
}

async function loadLedgerYear(year) {
    ledgerLoaded = false;
    const targetYear = Number(year) || currentYear;
    try {
        const json = await fetchJsonSafe(`${LEDGER_API_BASE}/ledger/load?year=${encodeURIComponent(targetYear)}`);
        if (json && json.ok && Array.isArray(json.data) && json.data.length === 12) {
            monthData = JSON.parse(JSON.stringify(defaultMonthData));
            for (let i = 0; i < 12; i++) if (json.data[i]) monthData[i] = json.data[i];
            currentYear = Number(json.year || targetYear);
            monthData.forEach((m, i) => {
                const list = (m && Array.isArray(m.checks)) ? m.checks : [];
                const tlist = (m && Array.isArray(m.checkTexts)) ? m.checkTexts : [];
                checksMonthStore.set(`${currentYear}-${i}`, list.slice());
                checksTextStore.set(`${currentYear}-${i}`, tlist.slice());
            });
            renderYearPicker();
            renderMonthState();
            if (qzLoaded && typeof qzLoadFromDb === 'function') qzLoadFromDb();
            return true;
        }
    } catch (_) {
        return false;
    } finally {
        ledgerLoaded = true;
        if (pendingLedgerSave && !suppressLedgerSave) {
            pendingLedgerSave = false;
            saveToStorage();
        }
    }
    return false;
}

async function switchLedgerYear(year, keepOpen) {
    const targetYear = Number(year);
    if (!Number.isInteger(targetYear) || targetYear === Number(currentYear)) return;
    if (!isKnownLedgerYear(targetYear)) return;
    if (ledgerLoaded) saveToStorage();
    if (!keepOpen) closeCreateYearPanel();
    yearPageStart = 0;
    yearEditMode = false;
    yearInputActive = false;
    // 目标年份只有点开才加载（不预取），保持原有省流量策略。
    // loadLedgerYear 内部会调 renderMonthState → refreshPanelMonthControls，
    // 所以成功后年份菜单会自动刷新高亮。
    await loadLedgerYear(targetYear);
}
// #endregion

//#region 账本规则
function loadLedgerYears() {
    return [];
}

function saveLedgerYears() { }

function getPrintableYears() {
    const values = Array.isArray(ledgerYears) ? ledgerYears.slice() : [];
    values.push(Number(currentYear) || new Date().getFullYear());
    return Array.from(new Set(values))
        .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100)
        .sort((a, b) => b - a);
}

function parseQzRecordMonth(value) {
    const match = String(value || '').trim().match(/^(\d{1,2})\s*\//);
    if (!match) return null;
    const month = parseInt(match[1], 10);
    return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

async function syncLedgerYearsFromDb() {
    const json = await fetchJsonSafe(LEDGER_API_BASE + '/ledger/years');
    if (!(json && json.ok && Array.isArray(json.years))) return;
    const dbYears = json.years
        .map(Number)
        .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100);
    const nextYears = Array.from(new Set(dbYears)).sort((a, b) => b - a);
    const changed = nextYears.length !== ledgerYears.length || nextYears.some((year, idx) => year !== ledgerYears[idx]);
    const currentExists = nextYears.includes(Number(currentYear));
    ledgerYears = nextYears;
    saveLedgerYears();
    if (!currentExists && ledgerYears.length) {
        await loadLedgerYear(ledgerYears[0]);
        renderYearPicker();
        populatePrintControls();
        return;
    }
    if (!changed) return;
    renderYearPicker();
    populatePrintControls();
}

//#endregion

//#region 数据规则

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatDisplayNumber(value) {
    if (value === null || value === undefined || value === '') return '';
    const raw = String(value).trim();
    const normalized = raw.replace(/,/g, '');
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return raw;
    const sign = normalized.startsWith('-') ? '-' : '';
    const unsigned = sign ? normalized.slice(1) : normalized;
    const [intPart, fracPart = ''] = unsigned.split('.');
    const trimmedFrac = fracPart.replace(/0+$/, '');
    return `${sign}${intPart}${trimmedFrac ? `.${trimmedFrac}` : ''}`;
}

function formatNonZeroDisplay(value) {
    return Number(value) === 0 ? '' : formatDisplayNumber(value);
}

function formatCategoryDisplay(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '';
    return String(Math.round(n));
}

function formatProfitDisplay(value) {
    const numeric = Number(value) || 0;
    const rounded = Math.round(numeric);
    return rounded ? String(rounded) : "";
}

function formatMonthAbbr(label) {
    const text = String(label || '').toLowerCase();
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1, 3)}` : '';
}

function isBlankLedgerValue(value) {
    return value === '' || value === null || value === undefined;
}

function normalizeOptionalLedgerNumber(value) {
    if (isBlankLedgerValue(value)) return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        return Object.is(value, -0) ? 0 : value;
    }
    const text = String(value).replace(/,/g, '').trim();
    if (!text) return '';
    const num = Number(text);
    if (!Number.isFinite(num)) return '';
    return Object.is(num, -0) ? 0 : num;
}

function normalizeLedgerDayValue(value) {
    if (isBlankLedgerValue(value)) return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        return Object.is(value, -0) ? 0 : value;
    }
    const text = String(value).replace(/,/g, '').trim();
    if (!text) return '';
    if (text.toLowerCase() === 'off') return 'off';
    const num = Number(text);
    if (!Number.isFinite(num)) return '';
    return Object.is(num, -0) ? 0 : num;
}

function normalizeLedgerDayArray(values, size) {
    return Array.from({ length: size }, (_, index) => normalizeLedgerDayValue(Array.isArray(values) ? values[index] : ''));
}

function formatLedgerCellDisplay(value) {
    const normalized = normalizeLedgerDayValue(value);
    return normalized === '' ? '' : formatDisplayNumber(normalized);
}

function sumLedgerDayArray(values) {
    return (Array.isArray(values) ? values : []).reduce((acc, curr) => {
        const normalized = normalizeLedgerDayValue(curr);
        return acc + (normalized === '' || normalized === 'off' ? 0 : Number(normalized));
    }, 0);
}

function parseMiniDetailEntry(value) {
    const text = value == null ? '' : String(value).trim();
    if (!text) return { date: '', amount: '', raw: '' };
    const dateMatch = text.match(/^(\d{2,4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\/\d{1,2})\s+(.+)$/);
    if (!dateMatch) return { date: '', amount: '', raw: text };
    const rawDate = dateMatch[1];
    const amount = dateMatch[2].trim();
    const parts = rawDate.split('/');
    let month = '';
    let day = '';
    if (parts.length === 3) {
        if (parts[0].length === 4) {
            month = parts[1];
            day = parts[2];
        } else {
            month = parts[0];
            day = parts[1];
        }
    } else if (parts.length === 2) {
        month = parts[0];
        day = parts[1];
    }
    if (!month || !day) return { date: '', amount: '', raw: text };
    return { date: `${month.padStart(2, '0')}/${day.padStart(2, '0')}`, amount, raw: text };
}

function formatNonCashTextDisplay(value) {
    const text = value == null ? '' : String(value).trim();
    return text ? formatNonZeroDisplay(text) : '';
}

function formatNonCashEntryDisplay(value) {
    const parsed = parseMiniDetailEntry(value);
    if (parsed.date || parsed.amount) {
        const amountText = formatNonCashTextDisplay(parsed.amount);
        return `${parsed.date}${amountText ? ` ${amountText}` : ''}`.trim();
    }
    return formatNonCashTextDisplay(parsed.raw || value);
}

function shortenSlashDateLabel(value) {
    const text = value == null ? '' : String(value).trim();
    if (!text) return '';
    const parts = text.split('/');
    if (parts.length === 3) {
        if (parts[0].length === 4) {
            return `${parts[1].padStart(2, '0')}/${parts[2].padStart(2, '0')}`;
        }
        return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
    }
    if (parts.length === 2) {
        return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}`;
    }
    return text;
}

function hideDateYear(text) {
    return String(text == null ? '' : text).replace(/^(\d{1,2}\/\d{1,2})\/\d{2,4}(?=\s)/, '$1');
}

function getDaysInMonth(monthIndex) {
    return new Date(currentYear, monthIndex + 1, 0).getDate();
}

function renderMiniGrid(containerId, items, highlightSet) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const list = Array.isArray(items) ? items : [];
    const pairCount = Math.max(1, Math.ceil(list.length / 2));
    const rows = [];
    const formatMiniCell = (value, extraClass) => {
        const parsed = parseMiniDetailEntry(value);
        if (!parsed.date && !parsed.amount) {
            const rawText = formatNonCashTextDisplay(parsed.raw || '');
            return `<span class="mini-cell${extraClass}">${escapeHtml(rawText)}</span>`;
        }
        const amountText = formatNonCashTextDisplay(parsed.amount);
        return `<span class="mini-cell${extraClass}"><span class="mini-date">${escapeHtml(parsed.date)}</span><span class="mini-amount">${escapeHtml(amountText)}</span></span>`;
    };
    for (let i = 0; i < pairCount; i++) {
        const leftIndex = i * 2;
        const rightIndex = leftIndex + 1;
        const leftText = list[leftIndex] ? String(list[leftIndex]) : '';
        const rightText = list[rightIndex] ? String(list[rightIndex]) : '';
        const leftHighlight = highlightSet instanceof Set && highlightSet.has(leftIndex) ? ' import-updated-mini' : '';
        const rightHighlight = highlightSet instanceof Set && highlightSet.has(rightIndex) ? ' import-updated-mini' : '';
        rows.push(
            `<div class="mini-row">${formatMiniCell(leftText, leftHighlight)}${formatMiniCell(rightText, rightHighlight)}</div>`
        );
    }
    container.innerHTML = rows.join('');
    const totalMap = { uberMini: 'stackUberTotalValue', riceballMini: 'stackRiceballTotalValue', pandaMini: 'stackPandaTotalValue', bmMini: 'stackBmTotalValue' };
    const totalId = totalMap[containerId];
    if (totalId) {
        const sum = Math.round(list.reduce((s, it) => s + parseNumberSafe(it), 0));
        const key = totalId.replace('stack', '').replace('TotalValue', '').toLowerCase();
        const ov = (monthData[currentMonth] || {}).totalOverrides || {};
        const manual = ov[key] || ov.Check;
        if (!(typeof manual === 'number' && manual !== 0 && Number.isFinite(manual))) {
            const el = document.getElementById(totalId);
            if (el) el.textContent = formatCategoryDisplay(sum);
        }
    }
}

function parseNumberSafe(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const m = String(value).match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g);
    if (!m || !m.length) return 0;
    const n = parseFloat(m[m.length - 1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

// 累加一组文本条目中的数值总和（四舍五入到分，避免浮点误差）。
function sumTextEntries(entries) {
    if (!Array.isArray(entries)) return 0;
    const sum = entries.reduce((acc, item) => acc + parseNumberSafe(item), 0);
    return Math.round(sum);
}

// 根据明细记录重算各销售渠道的汇总数据。
function recalcSalesBreakdownFromDetail(monthIndex) {
    const data = monthData[monthIndex];
    if (!data) return;
    data.salesBreakdown = data.salesBreakdown || { Check: 0, cash: 0, cost: 0, uber: 0, riceball: 0, panda: 0, bm: 0 };
    data.totalOverrides = data.totalOverrides || { Check: null, uber: null, riceball: null, panda: null, bm: null };
    data.deliveryDetails = data.deliveryDetails || { uber: [], riceball: [], panda: [], bm: [], dinein: [] };

    data.salesBreakdown.uber = sumTextEntries(data.deliveryDetails.uber);
    data.salesBreakdown.riceball = sumTextEntries(data.deliveryDetails.riceball);
    data.salesBreakdown.panda = sumTextEntries(data.deliveryDetails.panda);
    data.salesBreakdown.bm = sumTextEntries(data.deliveryDetails.bm);
    data.salesBreakdown.Check = sumTextEntries(data.deliveryDetails.dinein);
    data.salesBreakdown.cash = sumLedgerDayArray(data.cashDays);
    ['Check', 'uber', 'riceball', 'panda', 'bm'].forEach((key) => {
        const ov = data.totalOverrides[key];
        if (typeof ov === 'number' && ov !== 0 && Number.isFinite(ov)) {
            data.salesBreakdown[key] = ov;
        }
    });
}

//#endregion

//#region 面板共用

const panelMonthControls = [];

let quickToastTimer = null;

function placeInputCaretToEnd(input) {
    if (!input) return;
    setTimeout(function () {
        try {
            var len = input.value.length;
            input.setSelectionRange(len, len);
        } catch (_) { }
    }, 0);
}

// 显示全局保存提示，并允许传入层级和停留时长。
function showGlobalSaveToast(message, zIndex, duration) {
    if (quickToastTimer) {
        clearTimeout(quickToastTimer);
        const old = document.getElementById('globalSaveToast');
        if (old) old.remove();
    }

    const toast = document.createElement('div');
    toast.id = 'globalSaveToast';
    toast.textContent = message;
    toast.style.position = 'fixed';
    toast.style.left = '50%';
    toast.style.top = '50%';
    toast.style.transform = 'translate(-50%, -50%)';
    toast.style.padding = '10px 16px';
    toast.style.borderRadius = '999px';
    toast.style.background = 'rgba(18, 18, 18, 0.50)';
    toast.style.color = '#fff';
    toast.style.fontSize = '18px';
    toast.style.fontWeight = '800';
    toast.style.letterSpacing = '0.5px';
    toast.style.zIndex = String(zIndex);
    document.body.appendChild(toast);

    quickToastTimer = setTimeout(() => {
        toast.remove();
        quickToastTimer = null;
    }, duration);
}

// 关闭面板月份选择菜单。
function closePanelMonthMenus(exceptControl) {
    panelMonthControls.forEach((control) => {
        if (exceptControl && control === exceptControl) return;
        control.root.classList.remove('expanded');
        control.yearPicker.classList.remove('open');
        control.monthPicker.classList.remove('open');
        control.yearBtn.setAttribute('aria-expanded', 'false');
        control.monthBtn.setAttribute('aria-expanded', 'false');
    });
}

// 刷新各面板的年月选择器显示。
function refreshPanelMonthControls() {
    panelMonthControls.forEach((control) => {
        control.toggleBtn.textContent = String(currentYear) + ' ' + (monthLabels[currentMonth] || '---');
        control.yearBtn.textContent = String(currentYear);
        control.monthBtn.textContent = monthLabels[currentMonth] || '---';
        // 年份菜单：列出所有已存在的年份（当前年份也始终在内），点哪个才加载哪个
        const yearOptions = Array.from(new Set(
            (Array.isArray(ledgerYears) ? ledgerYears.slice() : []).concat(Number(currentYear) || [])
        )).map(Number).filter((year) => Number.isInteger(year)).sort((a, b) => b - a);
        // 年份多时菜单限高滚动，避免撑出面板
        control.yearMenu.classList.toggle('has-many', yearOptions.length > 6);
        control.yearMenu.innerHTML = yearOptions.map((year) => (
            `<button type="button" class="pz-picker-option${Number(year) === Number(currentYear) ? ' active' : ''}" data-panel-year="${year}">${year}</button>`
        )).join('');
        control.monthMenu.innerHTML = monthLabels.map((label, index) => (
            `<button type="button" class="pz-picker-option${index === currentMonth ? ' active' : ''}" data-panel-month="${index}">${label}</button>`
        )).join('');
    });
}

// 判断账本年份是否已存在（仅主面板 + 可新增年份）。
function isKnownLedgerYear(year) {
    const y = Number(year);
    return Number.isInteger(y) && (Array.isArray(ledgerYears) ? ledgerYears : []).map(Number).includes(y);
}

// 按偏移量切换面板当前月份。
function shiftPanelMonth(delta) {
    const baseMonth = Number(currentMonth) || 0;
    const total = baseMonth + Number(delta || 0);
    let targetMonth = ((total % 12) + 12) % 12;
    let yearDelta = Math.floor(total / 12);
    const targetYear = Number(currentYear) + yearDelta;
    if (targetYear === Number(currentYear)) {
        setMonthInPanel(targetMonth);
        return;
    }
    if (!isKnownLedgerYear(targetYear)) {
        return;
    }
    currentMonth = targetMonth;
    switchLedgerYear(targetYear, true);
}

// 在面板内切换月份并刷新视图。
function setMonthInPanel(index) {
    currentMonth = index;
    renderMonthState();
}

// 初始化面板年月选择控件与事件。
function initPanelMonthControls() {
    const roots = Array.from(document.querySelectorAll('[data-panel-month-controls]'));
    roots.forEach((root) => {
        const toggleBtn = root.querySelector('.pz-date-toggle');
        const yearPicker = root.querySelector('.panel-month-year-btn')?.closest('.pz-picker');
        const monthPicker = root.querySelector('.panel-month-month-btn')?.closest('.pz-picker');
        const prevBtn = root.querySelector('.panel-month-prev');
        const nextBtn = root.querySelector('.panel-month-next');
        const yearBtn = root.querySelector('.panel-month-year-btn');
        const monthBtn = root.querySelector('.panel-month-month-btn');
        const yearMenu = root.querySelector('.panel-month-year-menu');
        const monthMenu = root.querySelector('.panel-month-month-menu');
        if (!toggleBtn || !yearPicker || !monthPicker || !prevBtn || !nextBtn || !yearBtn || !monthBtn || !yearMenu || !monthMenu) return;
        const control = { root, toggleBtn, yearPicker, monthPicker, prevBtn, nextBtn, yearBtn, monthBtn, yearMenu, monthMenu };
        panelMonthControls.push(control);

        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closePanelMonthMenus();
            shiftPanelMonth(-1);
        });

        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closePanelMonthMenus();
            shiftPanelMonth(1);
        });

        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = !root.classList.contains('expanded');
            closePanelMonthMenus();
            root.classList.toggle('expanded', willOpen);
        });

        yearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = !yearPicker.classList.contains('open');
            yearPicker.classList.toggle('open', willOpen);
            monthPicker.classList.remove('open');
            yearBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            monthBtn.setAttribute('aria-expanded', 'false');
        });

        monthBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = !monthPicker.classList.contains('open');
            monthPicker.classList.toggle('open', willOpen);
            yearPicker.classList.remove('open');
            monthBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            yearBtn.setAttribute('aria-expanded', 'false');
        });

        yearMenu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-panel-year]');
            if (!btn) return;
            e.stopPropagation();
            const year = Number(btn.getAttribute('data-panel-year'));
            if (!Number.isInteger(year)) {
                closePanelMonthMenus();
                return;
            }
            if (year === Number(currentYear)) {
                closePanelMonthMenus();
                return;
            }
            // 切到别的年份：保持菜单打开，等年份数据加载完再刷新选项
            switchLedgerYear(year, true);
        });

        monthMenu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-panel-month]');
            if (!btn) return;
            e.stopPropagation();
            const monthIndex = Number(btn.getAttribute('data-panel-month'));
            if (Number.isInteger(monthIndex) && monthIndex >= 0 && monthIndex < 12) {
                setMonthInPanel(monthIndex);
            }
            closePanelMonthMenus();
        });
    });

    document.addEventListener('click', () => closePanelMonthMenus());
    refreshPanelMonthControls();
}

const quickLayer = document.getElementById('quickLayer');
var quickZLayer = document.getElementById('quickZLayer');
var qzSaveLayer = document.getElementById('qzSaveLayer');
var panelZLayer = document.getElementById('panelZLayer');
var cashLayer = document.getElementById('cashLayer');
var logLayer = document.getElementById('logLayer');
const mainPanelEl = document.querySelector('.main-panel');

const navStack = [];
// 验证口令入口：藏验证 + 主壳 verify-entry-hidden + 层挂 body（class verify-entry-layer）；关完回验证
let reopenVerifyOnClose = false;
const overlayHomeParent = new WeakMap();

function rememberOverlayHome(el) {
    if (el && !overlayHomeParent.has(el)) overlayHomeParent.set(el, el.parentElement);
}

function placeOnBody(el) {
    if (!el) return;
    rememberOverlayHome(el);
    if (el.parentElement !== document.body) document.body.appendChild(el);
}

function placeHome(el) {
    if (!el) return;
    const home = overlayHomeParent.get(el);
    if (home && el.parentElement !== home) home.appendChild(el);
}

function mountOverlayOnBody(el) {
    if (!el) return;
    placeOnBody(el);
    el.classList.add('verify-entry-layer');
}

function restoreOverlayHome(el) {
    if (!el) return;
    el.classList.remove('verify-entry-layer');
    placeHome(el);
}

// 确认弹窗：挂 body + fixed，不被主壳/验证入口藏掉
function showConfirmLayer(el) {
    if (!el) return;
    placeOnBody(el);
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
}

function hideConfirmLayer(el) {
    if (!el) return;
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    placeHome(el);
}

function enterVerifyEntryMode() {
    reopenVerifyOnClose = true;
    if (mainPanelEl) mainPanelEl.classList.add('verify-entry-hidden');
}

function exitVerifyEntryMode() {
    reopenVerifyOnClose = false;
    if (mainPanelEl) mainPanelEl.classList.remove('verify-entry-hidden');
}

function showVerifyLayerAgain() {
    if (mainPanelEl) mainPanelEl.classList.add('verify-entry-hidden');
    const ov = document.getElementById('verifyOverlay');
    const inp = document.getElementById('verifyInput');
    if (ov) ov.classList.remove('hidden');
    if (inp) {
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
            if (!document.activeElement || document.activeElement === document.body) inp.focus();
        }, 80);
    }
}

// 打开指定弹层并维护导航栈。
function openOverlay(id) {
    const verifyOverlay = document.getElementById('verifyOverlay');
        if (verifyOverlay && !verifyOverlay.classList.contains('hidden')) {
            verifyOverlay.classList.add('hidden');
            enterVerifyEntryMode();
        }

    const currentActive = document.querySelector('.modal-layer.active');
    if (currentActive && currentActive.id !== id) {
        navStack.push(currentActive.id);
        currentActive.classList.remove('active');
        currentActive.setAttribute('aria-hidden', 'true');
        if (reopenVerifyOnClose) restoreOverlayHome(currentActive);
        if (document.activeElement) document.activeElement.blur();
    } else if (!currentActive) {
        navStack.push('home');
    }

    if (id === 'quickLayer') {
        updateQuickDate();
        showQuickDate();
        if (quickValInput) quickValInput.value = '';
    }
    if (id === 'detailLayer' || id === 'dineinLayer') {
        // 打开平台明细 / 刷卡面板时强制重算并写入 5 个 Total
        try {
            recalcSalesBreakdownFromDetail(currentMonth);
            const data = monthData[currentMonth] || {};
            const keys = { stackUberTotalValue: 'uber', stackRiceballTotalValue: 'riceball', stackPandaTotalValue: 'panda', stackBmTotalValue: 'bm', stackDineTotalValue: 'Check' };
            Object.keys(keys).forEach((id2) => {
                const el = document.getElementById(id2);
                if (el) el.textContent = id2 === 'stackDineTotalValue'
                    ? formatCategoryDisplay(data.salesBreakdown[keys[id2]])
                    : formatCategoryDisplay(data.salesBreakdown[keys[id2]]);
            });
        } catch (_) { }
    }

    const overlay = document.getElementById(id);
    if (overlay) {
        if (reopenVerifyOnClose) mountOverlayOnBody(overlay);
        else restoreOverlayHome(overlay);
        overlay.classList.add('active');
        overlay.setAttribute('aria-hidden', 'false');
        if (id === 'expenseLayer') {
            hideOweView();
            resetOweNoteArea();
            resetSalaryPayModeBtn();
            requestAnimationFrame(alignSalaryCellsWithHeaders);
        }
        if (id === 'checksLayer') {
            panelRefreshChecks(currentMonth);
        }
        if (id === 'costLayer') {
            resetCostPanelState();
            panelRefreshCost(monthData[currentMonth] || {});
        }

        }

        scheduleAdaptivePanelRender(id);
    }

// 从验证口令打开：清栈后走 openOverlay
function openOverlayFromVerify(runOpen) {
    navStack.length = 0;
    if (typeof runOpen === 'function') runOpen();
}

// 在收支/成本/收支面板尺寸变化后重新渲染月份状态。
function scheduleAdaptivePanelRender(id) {
    if (window.matchMedia('(max-width: 768px)').matches) {
        return;
    }
    if (id === 'expenseLayer') {
        scheduleSalaryRowHeightSync();
        return;
    }
    if (!['costLayer', 'othersLayer'].includes(id)) return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const overlay = document.getElementById(id);
            if (overlay && overlay.classList.contains('active')) {
                renderMonthState();
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const activeOverlay = document.getElementById(id);
                        if (activeOverlay && activeOverlay.classList.contains('active')) {
                            renderMonthState();
                        }
                    });
                });
            }
        });
    });
}

window.addEventListener('resize', () => {
    const activeAdaptiveLayer = document.querySelector('#expenseLayer.active, #costLayer.active, #othersLayer.active');
    if (activeAdaptiveLayer) {
        scheduleAdaptivePanelRender(activeAdaptiveLayer.id);
    }
    alignSalaryCellsWithHeaders();
    scheduleSalaryDualPosition();
}, { passive: true });




// 关闭指定弹层。
function closeOverlay(id) {
    const overlay = document.getElementById(id);
    if (overlay) {
        if (document.activeElement && overlay.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden', 'true');
        restoreOverlayHome(overlay);
    }
    if (id === 'cashLayer') setCashReadonlyMode(false);
    if (reopenVerifyOnClose && !document.querySelector('.modal-layer.active')) {
        navStack.length = 0;
        showVerifyLayerAgain();
    }
}

// 返回验证码入口并清理会话状态。
function returnToVerifyPanel() {
    reopenVerifyOnClose = false;
    overlayIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('active');
        el.setAttribute('aria-hidden', 'true');
        restoreOverlayHome(el);
    });
    navStack.length = 0;
    if (typeof setCashReadonlyMode === 'function') setCashReadonlyMode(false);

    document.body.classList.remove('readonly-mode');
    accessLogMasked = false;
    hasFullAccess = false;

    const verifyError = document.getElementById('verifyError');
    if (verifyError) verifyError.style.display = 'none';
    showVerifyLayerAgain();
    if (window.scrollTo) window.scrollTo(0, 0);
}

const overviewCloseBtn = document.getElementById('overviewCloseBtn');
if (overviewCloseBtn) {
    overviewCloseBtn.addEventListener('click', returnToVerifyPanel);
}

// 关闭当前弹层并返回导航栈上一页。
function goBack() {
    const currentActive = document.querySelector('.modal-layer.active');
    if (!currentActive) return;

    if (document.activeElement && currentActive.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    // 工资面板备注页打开时，右上角关闭按钮先退出备注页返回工资页，而不是关闭整个工资面板。
    if (currentActive.id === 'expenseLayer' && oweView && !oweView.hidden) {
        hideOweView();
        return;
    }

    const previousId = navStack.pop();
    const shouldReopenVerify = reopenVerifyOnClose;

    currentActive.classList.remove('active');
    currentActive.setAttribute('aria-hidden', 'true');
    restoreOverlayHome(currentActive);

    // 从验证入口进来的：关到首页则恢复验证层（主壳仍藏在验证下面）
    if (shouldReopenVerify && (!previousId || previousId === 'home')) {
        showVerifyLayerAgain();
        return;
    }

    if (previousId && previousId !== 'home') {
        const prev = document.getElementById(previousId);
        if (prev) {
            if (reopenVerifyOnClose) mountOverlayOnBody(prev);
            prev.classList.add('active');
            prev.setAttribute('aria-hidden', 'false');
        }
    }
}

document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
        goBack();
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const preview = document.getElementById('checksPreviewOverlay');
        if (preview && !preview.classList.contains('hidden')) {
            closeCheckPreview();
            return;
        }
        const currentActive = document.querySelector('.modal-layer.active');
        if (!currentActive) return;
        const subLayers = currentActive.querySelectorAll('.import-check-layer, .import-confirm-layer, .import-del-layer');
        for (let i = subLayers.length - 1; i >= 0; i--) {
            const sl = subLayers[i];
            if (sl.classList.contains('open')) {
                sl.classList.remove('open');
                sl.setAttribute('aria-hidden', 'true');
                return;
            }
        }
        goBack();
    }
});

//#endregion

//#region 滑动手势

// 手机左右滑动：带月份的面板切上一月/下一月；多页面板（打印/总报表）切页。
// 只触发既有按钮，不产生任何变形/缩放/动画。
function initMobileSwipeNavigation() {
    if (!window.matchMedia || !('ontouchstart' in window)) return;

    const MOBILE_QUERY = window.matchMedia('(max-width: 480px)');
    const SWIPE_DIST = 60;

    let startX = 0;
    let startY = 0;
    let startTarget = null;
    let tracking = false;

    document.addEventListener('touchstart', (e) => {
        if (!MOBILE_QUERY.matches) return;
        const t = e.touches[0];
        if (!t) return;
        startX = t.clientX;
        startY = t.clientY;
        startTarget = e.target;
        tracking = true;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        if (!MOBILE_QUERY.matches) return;
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) < SWIPE_DIST) return;         // 距离不足
        if (Math.abs(dy) > Math.abs(dx) * 1.2) return; // 纵向滚动优先

        if (startTarget && startTarget.closest) {
            const skip = startTarget.closest('input, textarea, select, .editable-cell, [contenteditable], .pz-picker, .panel-month-nav, .red-dot, .quick-date-picker, .pz-native-select');
            if (skip) return;
        }

        handlePanelSwipe(dx > 0 ? 'right' : 'left');
    }, { passive: true });
}

// 在当前激活面板范围内执行一次滑动切换。
function handlePanelSwipe(dir) {
    const forward = dir === 'left';

    const layer = document.querySelector('.modal-layer.active');
    let root = null;
    if (layer) {
        root = layer;
    } else {
        const mp = document.querySelector('.main-panel');
        if (mp && !mp.classList.contains('verify-entry-hidden')) root = mp;
    }
    if (!root) return;

    // 1) 带月份的面板：上一月/下一月
    const prevBtn = root.querySelector('.panel-month-prev');
    const nextBtn = root.querySelector('.panel-month-next');
    if (prevBtn && nextBtn) {
        (forward ? nextBtn : prevBtn).click();
        return;
    }

    // 2) Panel Z：上一月/下一月
    const pzPrev = root.querySelector('#pzMonthPrevBtn');
    const pzNext = root.querySelector('#pzMonthNextBtn');
    if (pzPrev && pzNext) {
        (forward ? pzNext : pzPrev).click();
        return;
    }

    // 3) 打印面板：月报/年报/表格 三模式循环
    const printBtns = ['#printModeMonthBtn', '#printModeYearBtn', '#printModeTotalBtn']
        .map((id) => root.querySelector(id))
        .filter(Boolean);
    if (printBtns.length === 3) {
        const activeIdx = printBtns.findIndex((b) => b.classList.contains('active'));
        const target = printBtns[(activeIdx + (forward ? 1 : -1) + 3) % 3];
        if (target) target.click();
        return;
    }

    // 4) 总报表面板：总结/详细/创建 三模式循环
    const trBtns = Array.from(root.querySelectorAll('#trInlineModeRow .month-btn'));
    if (trBtns.length >= 2) {
        const activeIdx = trBtns.findIndex((b) => b.classList.contains('active'));
        const target = trBtns[(activeIdx + (forward ? 1 : -1) + trBtns.length) % trBtns.length];
        if (target) target.click();
    }
}

initMobileSwipeNavigation();

//#endregion

//#region 验证页

// 在验证层前方显示保存提示。
function showVerifyFrontToast(message) {
    showGlobalSaveToast(message, 100002, 2000);
}

(function () {
    const ov = document.getElementById('verifyOverlay');
    const inp = document.getElementById('verifyInput');
    const err = document.getElementById('verifyError');
    const form = document.getElementById('verifyForm');

    if (!inp) return;

    setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) inp.focus(); }, 100);

    // 同步验证按钮就绪状态。
    function syncBtn() {
        const wrap = inp.closest('.verify-input-wrap');
        if (wrap) wrap.classList.toggle('ready', !!inp.value.trim());
    }

    inp.addEventListener('input', () => {
        err.style.display = 'none';
        syncBtn();
    });

    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleVerify();
        }
    });

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            handleVerify();
        });
    }

    // 处理验证口令并执行对应快捷指令。
    function handleVerify() {
        const vRaw = inp.value.trim();
        const v = vRaw.toLowerCase();

        err.style.display = 'none';

        const actions = {
            // 均为正常开面板；验证层由 openOverlay 先藏，关面板后 goBack 再恢复
            'c': () => openOverlay('quickLayer'),
            '2': () => { hasFullAccess = true; ov.classList.add('hidden'); exitVerifyEntryMode(); },
            'z': () => openOverlay('quickZLayer'),
            '0': () => openOverlayFromVerify(() => openEditablePanelZ()),
            'cash': () => openOverlayFromVerify(() => openReadonlyCash()),
            'l': () => openOverlay('logLayer'),
            'y': () => {
                hasFullAccess = false;
                document.body.classList.add('readonly-mode');
                ov.classList.add('hidden');
                exitVerifyEntryMode();
                renderAccessLogs();
            }
        };

        if (actions[v]) {
            addAccessRecordByCode(vRaw);
            actions[v]();
            stabilizeAfterVerify();
        } else {
            err.style.display = 'block';
            inp.value = '';
            if (!document.activeElement || document.activeElement === document.body) inp.focus();
        }

        syncBtn();
    }

    // 验证完成后收起焦点并复位滚动位置。
    function stabilizeAfterVerify() {
        if (inp) inp.blur();
        window.scrollTo(0, 0);
    }

    // 热区按钮 = 快捷输入对应 code 并验证
    const hotspotCodeMap = {
        verifyHotspot1: 'z',
        verifyHotspot2: 'cash',
        verifyHotspot3: 'c',
        verifyHotspot4: '2',
        verifyHotspot5: 'k',
    };
    Object.keys(hotspotCodeMap).forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', () => {
            inp.value = hotspotCodeMap[id];
            if (id === 'verifyHotspot5') {
                form.dispatchEvent(new Event('submit', { cancelable: true }));
                return;
            }
            handleVerify();
        });
    });

    syncBtn();
})();

//#endregion

//#region 首页 

//#region 首页 · DOM
const createYear = document.getElementById('createYear');
const openCreateYearBtn = document.getElementById('openCreateYearBtn');
const yearAddBtn = document.getElementById('yearAddBtn');
const yearRemoveModeBtn = document.getElementById('yearRemoveModeBtn');
const yearNewInput = document.getElementById('yearNewInput');
const yearConfirmBtn = document.getElementById('yearConfirmBtn');
const yearPickRemoveBtn = document.getElementById('yearPickRemoveBtn');
const yearOptions = document.getElementById('yearOptions');
const deleteConfirmLayer = document.getElementById('deleteConfirmLayer');
const deleteConfirmText = document.getElementById('deleteConfirmText');
const DeleteConfirmBtn = document.getElementById('DeleteConfirmBtn');
const deleteCancelBtn = document.getElementById('deleteCancelBtn');
const overlayIds = ['expenseLayer', 'costLayer', 'othersLayer', 'cashLayer', 'logLayer', 'detailLayer', 'detailImportPreviewLayer', 'dineinLayer', 'quickLayer', 'quickZLayer', 'qzSaveLayer', 'panelZLayer', 'printLayer', 'totalReportLayer'];
const chartBars = Array.from(document.querySelectorAll('.chart-card .bar'));
const chartBarSlots = Array.from(document.querySelectorAll('.chart-card .bar-slot'));
const chartCard = document.querySelector('.chart-card');
const chartValueToggleBtn = document.getElementById('chartValueToggleBtn');
const chartHoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
let chartShowAllValues = false;
//#endregion

//#region 图表
// 确保图表柱条包含数值元素。
function ensureChartBarValues() {
    chartBars.forEach((bar) => {
        if (!bar.querySelector('.bar-value')) {
            const valueEl = document.createElement('span');
            valueEl.className = 'bar-value hidden';
            bar.appendChild(valueEl);
        }
    });
}

// 高亮指定月份的图表柱条。
function setActiveChartBar(index) {
    chartBarSlots.forEach((slot, slotIndex) => {
        slot.classList.toggle('show-value', slotIndex === index);
    });
}

// 切换图表是否显示全部月份数值。
function setChartShowAllValues(on) {
    chartShowAllValues = !!on;
    if (chartCard) chartCard.classList.toggle('show-all-values', chartShowAllValues);
    if (chartValueToggleBtn) {
        chartValueToggleBtn.classList.toggle('active', chartShowAllValues);
        chartValueToggleBtn.textContent = chartShowAllValues ? 'Hide' : 'show';
        chartValueToggleBtn.setAttribute('aria-pressed', chartShowAllValues ? 'true' : 'false');
    }
    if (chartShowAllValues) {
        setActiveChartBar(-1);
    }
}

ensureChartBarValues();
setChartShowAllValues(false);
if (chartValueToggleBtn) {
    chartValueToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setChartShowAllValues(!chartShowAllValues);
    });
}
chartBarSlots.forEach((slot, index) => {
    if (chartHoverCapable) {
        slot.addEventListener('mouseenter', () => {
            if (!chartShowAllValues) setActiveChartBar(index);
        });
        slot.addEventListener('mouseleave', () => {
            if (!chartShowAllValues) setActiveChartBar(-1);
        });
    }
    slot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!chartShowAllValues) setActiveChartBar(index);
    });
});
document.addEventListener('click', (e) => {
    if (!chartShowAllValues && (!chartCard || !chartCard.contains(e.target))) {
        setActiveChartBar(-1);
    }
});
//#endregion

//#region 年月切换

// 渲染年份弹窗：行1 添加/移除 + 右侧控件；行2 标题「当前」+ 横向年份。
function renderYearPicker() {
    if (!yearOptions) return;

    yearOptions.innerHTML = '';
    createYear?.classList.toggle('adding', yearInputActive);
    createYear?.classList.toggle('removing', yearRemoveMode);
    createYear?.classList.toggle('editing', yearEditMode);

    if (yearNewInput) {
        if (yearInputActive) {
            yearNewInput.hidden = false;
            yearNewInput.removeAttribute('hidden');
            yearNewInput.style.display = '';
            queueMicrotask(() => {
                try { yearNewInput.focus({ preventScroll: true }); } catch (_) { yearNewInput.focus(); }
            });
        } else {
            yearNewInput.hidden = true;
            yearNewInput.style.display = 'none';
            yearNewInput.value = '';
        }
    }
    if (yearConfirmBtn) {
        yearConfirmBtn.hidden = !yearInputActive;
        yearConfirmBtn.style.display = yearInputActive ? '' : 'none';
    }
    if (yearPickRemoveBtn) {
        yearPickRemoveBtn.hidden = !yearRemoveMode;
        yearPickRemoveBtn.style.display = yearRemoveMode ? '' : 'none';
        if (yearRemoveMode) {
            if (yearRemoveSelected != null) {
                yearPickRemoveBtn.textContent = '移除';
                yearPickRemoveBtn.classList.add('ready');
                yearPickRemoveBtn.disabled = false;
            } else {
                yearPickRemoveBtn.textContent = '请选择';
                yearPickRemoveBtn.classList.remove('ready');
                yearPickRemoveBtn.disabled = true;
            }
        } else {
            yearPickRemoveBtn.classList.remove('ready');
            yearPickRemoveBtn.disabled = true;
        }
    }
    if (yearAddBtn) yearAddBtn.classList.toggle('active-mode', yearInputActive);
    if (yearRemoveModeBtn) yearRemoveModeBtn.classList.toggle('active-mode', yearRemoveMode);

    const years = (Array.isArray(ledgerYears) ? ledgerYears.slice() : []).map(Number)
        .filter((y) => Number.isInteger(y))
        .sort((a, b) => b - a);

    years.forEach((year, idx) => {
        const item = document.createElement('span');
        item.className = 'year-option';
        const button = document.createElement('button');
        button.type = 'button';
        const tone = ((idx + 1) % 9) + 1;
        const isCurrent = Number(year) === Number(currentYear);
        const isSelected = yearRemoveMode && Number(year) === Number(yearRemoveSelected);
        button.className = `year-btn year-tone-${tone}${isCurrent ? ' active' : ''}${isSelected ? ' remove-selected' : ''}`;
        button.textContent = String(year);
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (yearRemoveMode) {
                if (Number(year) === Number(currentYear)) return;
                yearRemoveSelected = Number(yearRemoveSelected) === Number(year) ? null : year;
                renderYearPicker();
                return;
            }
            switchLedgerYear(year);
            renderYearPicker();
        });
        item.appendChild(button);
        yearOptions.appendChild(item);
    });
}

function openCreateYearPanel() {
    if (!createYear) return;
    yearEditMode = true;
    yearInputActive = false;
    yearRemoveMode = false;
    yearRemoveSelected = null;
    createYear.classList.add('open');
    createYear.setAttribute('aria-hidden', 'false');
    renderYearPicker();
}

function closeCreateYearPanel() {
    if (!createYear) return;
    yearEditMode = false;
    yearInputActive = false;
    yearRemoveMode = false;
    yearRemoveSelected = null;
    createYear.classList.remove('open', 'adding', 'removing', 'editing');
    createYear.setAttribute('aria-hidden', 'true');
    if (yearNewInput) {
        yearNewInput.hidden = true;
        yearNewInput.style.display = 'none';
        yearNewInput.value = '';
    }
    if (yearConfirmBtn) {
        yearConfirmBtn.hidden = true;
        yearConfirmBtn.style.display = 'none';
    }
    if (yearPickRemoveBtn) {
        yearPickRemoveBtn.hidden = true;
        yearPickRemoveBtn.style.display = 'none';
        yearPickRemoveBtn.textContent = '请选择';
        yearPickRemoveBtn.classList.remove('ready');
    }
}

// 进入添加模式：右侧输入框 + 确定。
function showNewYearInput() {
    if (isReadonlyMode()) return;
    yearEditMode = true;
    yearInputActive = true;
    yearRemoveMode = false;
    yearRemoveSelected = null;
    createYear?.classList.add('open', 'adding');
    createYear?.classList.remove('removing');
    createYear?.setAttribute('aria-hidden', 'false');
    renderYearPicker();
}

// 进入移除模式：右侧「请选择」，点年份变红后按钮变为「移除」。
function showRemoveYearMode() {
    if (isReadonlyMode()) return;
    yearEditMode = true;
    yearInputActive = false;
    yearRemoveMode = true;
    yearRemoveSelected = null;
    createYear?.classList.add('open', 'removing');
    createYear?.classList.remove('adding');
    createYear?.setAttribute('aria-hidden', 'false');
    renderYearPicker();
}

// 校验并保存新输入的年份，然后切换到账本。
function commitNewYear(input) {
    if (isReadonlyMode()) return;
    const el = input || yearNewInput;
    const year = parseInt(String((el && el.value) || '').replace(/[^0-9]/g, ''), 10);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        yearInputActive = false;
        renderYearPicker();
        return;
    }
    if (!ledgerYears.includes(year)) {
        ledgerYears.push(year);
        ledgerYears = Array.from(new Set(ledgerYears)).sort((a, b) => b - a);
        saveLedgerYears();
    }
    yearInputActive = false;
    switchLedgerYear(year, true);
    renderYearPicker();
}

function confirmRemoveSelectedYear() {
    if (isReadonlyMode()) return;
    if (yearRemoveSelected == null) return;
    if (Number(yearRemoveSelected) === Number(currentYear)) return;
    showDeleteYearConfirm(yearRemoveSelected);
}

// 显示删除年份前的确认弹层。
function showDeleteYearConfirm(year) {
    pendingDeleteYear = year;
    yearInputActive = false;
    renderYearPicker();
    if (deleteConfirmText) {
        deleteConfirmText.textContent = `${year} 的当前数据会全部删除，是否确定？`;
    }
    showConfirmLayer(deleteConfirmLayer);
    requestAnimationFrame(() => {
        DeleteConfirmBtn?.focus({ preventScroll: true });
    });
}

// 关闭删除年份确认弹层并清空待删状态。
function hideDeleteYearConfirm() {
    pendingDeleteYear = null;
    if (deleteConfirmLayer) {
        const active = document.activeElement;
        if (active && deleteConfirmLayer.contains(active)) {
            active.blur();
        }
        hideConfirmLayer(deleteConfirmLayer);
    }
}
//#endregion

//#region 首页总览

function panelRefreshHomeOverview(data, label, dayCount) {
    // 重算指定月份的销售额、收支与利润汇总。
    const recomputeMonthSummary = (monthIndex) => {
        const md = monthData[monthIndex];
        if (!md) return;
        md.salesBreakdown = md.salesBreakdown || { Check: 0, cash: 0, cost: 0, uber: 0, riceball: 0, panda: 0, bm: 0 };
        md.costTotal = normalizeOptionalLedgerNumber(md.costTotal);
        md.othersTotal = normalizeOptionalLedgerNumber(md.othersTotal);
        md.expense = normalizeOptionalLedgerNumber(md.expense);
        recalcSalesBreakdownFromDetail(monthIndex);
        md.sales = (md.salesBreakdown.Check || 0) + (md.salesBreakdown.cash || 0)
            + (md.salesBreakdown.uber || 0) + (md.salesBreakdown.riceball || 0) + (md.salesBreakdown.panda || 0)
            + (md.salesBreakdown.bm || 0);
        md.profit = md.sales - md.expense - md.costTotal + (Number(md.othersTotal) || 0);
    };

    for (let i = 0; i < monthData.length; i++) {
        recomputeMonthSummary(i);
    }
    printPreviewYearCache.set(Number(currentYear), JSON.parse(JSON.stringify(normalizePrintPreviewYearData(monthData, currentYear))));
    const chartStyle = getComputedStyle(document.querySelector('.chart-card'));
    const zeroLine = parseFloat(chartStyle.getPropertyValue('--chart-zero-line')) || 80;
    const slotHeight = chartBarSlots[0]?.clientHeight || 250;
    const maxRise = Math.max(0, slotHeight - zeroLine);
    const maxFall = Math.max(0, zeroLine);
    const overviewMonthEl = document.getElementById('overviewMonth');
    if (overviewMonthEl) {
        overviewMonthEl.textContent = formatMonthAbbr(label);
    }

    const profitSeries = monthData.map((item) => Math.round(Number((item || {}).profit) || 0));

    chartBars.forEach((bar, index) => {
        const value = profitSeries[index];
        const hasValue = value !== 0;
        const height = Math.max(0, Math.round(Math.abs(value) / 250));
        const clampedHeight = value >= 0 ? Math.min(height, maxRise) : Math.min(height, maxFall);
        const barValue = bar.querySelector('.bar-value');
        const barMonth = chartBarSlots[index]?.querySelector('.bar-month');
        chartBarSlots[index]?.classList.toggle('active', index === currentMonth);
        bar.classList.remove('positive', 'negative', 'active');
        bar.classList.toggle('hidden', !hasValue);
        bar.style.height = clampedHeight > 0 ? `${clampedHeight}px` : '0px';
        bar.style.bottom = value >= 0 ? `${zeroLine}px` : `${Math.max(0, zeroLine - clampedHeight)}px`;
        bar.style.opacity = index === currentMonth ? '1' : '0.82';
        bar.classList.add(value < 0 ? 'negative' : 'positive');
        if (index === currentMonth) {
            bar.classList.add('active');
        }
        if (barValue) {
            barValue.textContent = value ? `${Math.round(value)}` : '';
            barValue.classList.toggle('hidden', !hasValue);
        }
        if (barMonth) {
            barMonth.textContent = formatMonthAbbr(monthLabels[index]);
            barMonth.classList.toggle('hidden', !hasValue);
        }
    });


    const profitEl = document.getElementById('profitValue');
    profitEl.textContent = formatProfitDisplay(data.profit);
    profitEl.classList.toggle('profit-positive', Number(data.profit) > 0);
    profitEl.classList.toggle('profit-negative', Number(data.profit) < 0);
    const setTextById = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setTextById('expenseValue', formatCategoryDisplay(data.expense));
    setTextById('expenseMonthTitle', '工资');
    setTextById('costMonthTitle', '收支');
    setTextById('othersMonthTitle', '其他');
    setTextById('cashMonthTitle', '现金');
    setTextById('detailMonthTitle', '平台报表');
    setTextById('dineinMonthTitle', '刷卡');
    refreshPanelMonthControls();

    const dailyCashTotal = sumLedgerDayArray(data.cashDays);
    const leftTotal = (data.salesBreakdown.Check || 0) + (data.salesBreakdown.cash || 0);
    const rightTotal = (data.salesBreakdown.uber || 0) + (data.salesBreakdown.riceball || 0) + (data.salesBreakdown.panda || 0) + (data.salesBreakdown.bm || 0);
    setTextById('overviewDineinTotalValue', formatCategoryDisplay(leftTotal));
    setTextById('overviewDeliveryTotalValue', formatCategoryDisplay(rightTotal));
    setTextById('overviewDineInValue', formatCategoryDisplay(data.salesBreakdown.Check));
    setTextById('overviewDineCashValue', formatCategoryDisplay(dailyCashTotal));
    setTextById('overviewUberValue', formatCategoryDisplay(data.salesBreakdown.uber));
    setTextById('overviewRiceballValue', formatCategoryDisplay(data.salesBreakdown.riceball));
    setTextById('overviewPandaValue', formatCategoryDisplay(data.salesBreakdown.panda));
    setTextById('overviewBmValue', formatCategoryDisplay(data.salesBreakdown.bm));

    setTextById('overviewIncomeTotalValue', formatCategoryDisplay(data.sales || (leftTotal + rightTotal)));

    const expenseTopTotal = (Number(data.expense) || 0) + (Number(data.costTotal) || 0);
    setTextById('overviewExpenseTotalValue', formatCategoryDisplay(expenseTopTotal));
    setTextById('overviewExpenseGroupTotalValue', formatCategoryDisplay(expenseTopTotal));
    setTextById('overviewcostValue', formatCategoryDisplay(data.costTotal));
    setTextById('overviewothersValue', formatCategoryDisplay(data.othersTotal));
    setTextById('overviewOtherGroupTotalValue', formatCategoryDisplay(data.othersTotal));

    const balanceTotal = (Number(data.costTotal) || 0) + (Number(data.othersTotal) || 0);
    setTextById('overviewBalanceTotalValue', formatCategoryDisplay(balanceTotal));

    const deliveryDetails = data.deliveryDetails || {};
    const monthMiniMap = (typeof detailImportUpdatedMiniByMonth === 'object' && detailImportUpdatedMiniByMonth)
        ? detailImportUpdatedMiniByMonth
        : null;
    const monthMiniUpdates = monthMiniMap ? (monthMiniMap[currentMonth] || null) : null;
    const shouldHighlightImport = detailImportActive && !!monthMiniUpdates;
    renderMiniGrid('uberMini', deliveryDetails.uber || [], shouldHighlightImport ? monthMiniUpdates.uber : null);
    renderMiniGrid('riceballMini', deliveryDetails.riceball || [], shouldHighlightImport ? monthMiniUpdates.riceball : null);
    renderMiniGrid('pandaMini', deliveryDetails.panda || [], shouldHighlightImport ? monthMiniUpdates.panda : null);
    renderMiniGrid('bmMini', deliveryDetails.bm || [], shouldHighlightImport ? monthMiniUpdates.bm : null);

    const setStackTotalText = (id, value) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = formatCategoryDisplay(value);
    };
    setStackTotalText('stackUberTotalValue', data.salesBreakdown.uber);
    setStackTotalText('stackRiceballTotalValue', data.salesBreakdown.riceball);
    setStackTotalText('stackPandaTotalValue', data.salesBreakdown.panda);
    setStackTotalText('stackBmTotalValue', data.salesBreakdown.bm);
    setStackTotalText('stackDineTotalValue', data.salesBreakdown.Check);
}


//逻辑 · 换月刷新
// 把当前月份的所有账本数据同步到页面各区域。
function renderMonthState() {
    if (Number(currentYear) === 2023 && currentMonth < 4) {
        currentMonth = 4;
    }
    const data = monthData[currentMonth];
    const label = monthLabels[currentMonth];
    const dayCount = getDaysInMonth(currentMonth);
    // 平台/刷卡 Total：每次渲染都按当月明细重算（有内容显示合计，没内容留空，不显示 0）
    recalcSalesBreakdownFromDetail(currentMonth);
    {   
        const keys = { stackUberTotalValue: 'uber', stackRiceballTotalValue: 'riceball', stackPandaTotalValue: 'panda', stackBmTotalValue: 'bm', stackDineTotalValue: 'Check' };
        Object.keys(keys).forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = id === 'stackDineTotalValue'
                ? formatCategoryDisplay(data.salesBreakdown[keys[id]])
                : formatCategoryDisplay(data.salesBreakdown[keys[id]]);
        });
    }
    data.cashDays = normalizeLedgerDayArray(data.cashDays, dayCount);
    data.checkDays = normalizeLedgerDayArray(data.checkDays, dayCount);
    data.costExpenses = Array.isArray(data.costExpenses) ? data.costExpenses : Array.from({ length: 13 }, () => ["", ""]);
    data.costExpenses = data.costExpenses.map((row) => normalizeExpenseEntryRow(row));
    data.costTotal = normalizeOptionalLedgerNumber(data.costTotal);
    data.costOthersExpenses = Array.isArray(data.costOthersExpenses) ? data.costOthersExpenses : Array.from({ length: 8 }, () => ["", ""]);
    data.costOthersExpenses = data.costOthersExpenses.map((row) => normalizeExpenseEntryRow(row));
    data.othersExpenses = Array.isArray(data.othersExpenses) ? data.othersExpenses : Array.from({ length: 8 }, () => ["", ""]);
    data.othersTotal = normalizeOptionalLedgerNumber(data.othersTotal);
    data.salesBreakdown = data.salesBreakdown || { Check: 0, cash: 0, cost: 0, uber: 0, riceball: 0, panda: 0, bm: 0 };
    panelRefreshHomeOverview(data, label, dayCount);
    panelRefreshSalary(data);
    panelRefreshSalaryCheck(data);
    panelRefreshCost(data);
    panelRefreshOthers(data);
    panelRefreshCash(data, dayCount);
    panelRefreshDinein(data);
    panelRefreshChecks(currentMonth);
}

// 切换当前月份并关闭已打开的弹层。
function setMonth(index) {
    currentMonth = index;
    renderMonthState();
    overlayIds.forEach((id) => closeOverlay(id));
}
//#endregion

//#region 平台汇总点击编辑

function beginTotalInlineEdit(key, valueEl) {
    if (isReadonlyMode()) return;
    if (!valueEl || valueEl.querySelector('input')) return;
    const oldVal = valueEl.textContent;
    let done = false;

    valueEl.classList.add('stack-edit-active');
    const input = document.createElement('input');
    input.className = 'stack-edit-input';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = oldVal;
    valueEl.appendChild(input);

    const finish = () => {
        if (done) return;
        done = true;
        valueEl.classList.remove('stack-edit-active');
        if (input.parentNode === valueEl) valueEl.removeChild(input);
    };

    const cancel = () => {
        if (done) return;
        finish();
        valueEl.textContent = oldVal;
    };

    const commit = () => {
        if (done) return;
        const raw = String(input.value || '').trim();
        const next = raw ? parseNumberSafe(raw) : null;
        const prev = oldVal ? parseNumberSafe(oldVal) : null;
        finish();
        // 数值未改动时视为取消：不生成手动覆盖，保持“所有记录之和”的默认值。
        if ((next === null && prev === null) || (next !== null && prev !== null && next === prev)) return;
        monthData[currentMonth].totalOverrides = monthData[currentMonth].totalOverrides || { Check: null, uber: null, riceball: null, panda: null, bm: null };
        if (next === null) {
            monthData[currentMonth].totalOverrides[key] = null;
        } else {
            monthData[currentMonth].salesBreakdown[key] = next;
            monthData[currentMonth].totalOverrides[key] = next;
        }
        renderMonthState();
        saveToStorage();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    input.addEventListener('blur', commit);

    input.focus();
    input.select();
}

// 初始化平台汇总值的点击编辑能力。
function initStackTotalEditing() {
    const maps = [
        { id: 'stackUberTotalValue', key: 'uber' },
        { id: 'stackRiceballTotalValue', key: 'riceball' },
        { id: 'stackPandaTotalValue', key: 'panda' },
        { id: 'stackBmTotalValue', key: 'bm' },
        { id: 'stackDineTotalValue', key: 'Check' }
    ];
    maps.forEach(({ id, key }) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.onclick = () => beginTotalInlineEdit(key, el);
    });
}

//#endregion

//#region 首页 · 手机排版

(function ensureOverviewThreeLayerOrder() {
    var overviewRoot = document.querySelector('.overview');
    var chartCard = document.querySelector('.overview-chart, .chart-card');
    var createYearEl = document.getElementById('createYear');
    var panel = overviewRoot && overviewRoot.parentElement;
    if (!panel || !overviewRoot || !chartCard) return;
    // 上：overview（含总计+操作）；中：统计表
    if (chartCard.previousElementSibling !== overviewRoot) {
        panel.insertBefore(chartCard, overviewRoot.nextSibling);
    }
    // 年份弹窗挂到 main-panel，与 #quickLayer 同层居中（避免 overview 内容过高导致视觉偏下）
    var mainPanel = panel.closest('.main-panel') || panel.parentElement;
    if (createYearEl && mainPanel && createYearEl.parentElement !== mainPanel) {
        mainPanel.appendChild(createYearEl);
    }
})();

//#endregion

//#region 首页 · 文本提取

let extractFileName = "";
let extractFileText = "";

// 把普通关键字转换成可搜索的正则表达式。
function buildRegexFromPlain(keyword, caseSensitive) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, caseSensitive ? "g" : "gi");
}

// 找出一行文本里所有匹配片段的起止位置。
function findMatchSpansRegex(line, regex) {
    const spans = [];
    const r = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : (regex.flags + "g"));
    r.lastIndex = 0;
    let m;
    while ((m = r.exec(line)) !== null) {
        const start = m.index;
        const matchText = m[0] ?? "";
        const end = start + matchText.length;
        if (end > start) {
            spans.push([start, end]);
        }
        if (m[0] === "") {
            r.lastIndex++;
            if (r.lastIndex > line.length) break;
        }
    }
    return spans;
}

// 按匹配区间为文本生成高亮后的 HTML。
function highlightLine(line, spans) {
    if (!spans || spans.length === 0) return escapeHtml(line);
    let html = "";
    let last = 0;
    for (const [s, e] of spans) {
        html += escapeHtml(line.slice(last, s));
        html += `<mark>${escapeHtml(line.slice(s, e))}</mark>`;
        last = e;
    }
    html += escapeHtml(line.slice(last));
    return html;
}

// 合并相邻或重叠的行号范围。
function mergeRanges(ranges) {
    if (!ranges.length) return [];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0].slice()];
    for (let i = 1; i < ranges.length; i++) {
        const prev = merged[merged.length - 1];
        const cur = ranges[i];
        if (cur[0] <= prev[1] + 1) {
            prev[1] = Math.max(prev[1], cur[1]);
        } else {
            merged.push(cur.slice());
        }
    }
    return merged;
}

// 执行文本提取和关键字搜索，并渲染结果。
function runExtractor() {
    const metaEl = document.getElementById("extractMeta");
    const errEl = document.getElementById("extractError");
    const outEl = document.getElementById("extractResults");
    const keywordEl = document.getElementById("extractKeywordInput");
    const regexEl = document.getElementById("extractRegexToggle");
    const caseEl = document.getElementById("extractCaseToggle");
    const contextEl = document.getElementById("extractContextInput");

    errEl.style.display = "none";
    errEl.textContent = "";

    const keyword = (keywordEl.value || "").trim();
    const context = Math.max(0, Math.min(20, parseInt(contextEl.value, 10) || 0));
    const useRegex = !!regexEl.checked;
    const caseSensitive = !!caseEl.checked;

    if (!extractFileText) {
        errEl.textContent = "Please choose a text file first.";
        errEl.style.display = "block";
        return;
    }
    if (!keyword) {
        errEl.textContent = "Keyword is empty.";
        errEl.style.display = "block";
        return;
    }

    let regex;
    try {
        if (useRegex) {
            const flags = caseSensitive ? "g" : "gi";
            regex = new RegExp(keyword, flags);
        } else {
            regex = buildRegexFromPlain(keyword, caseSensitive);
        }
    } catch (e) {
        errEl.textContent = `Regex error: ${e && e.message ? e.message : e}`;
        errEl.style.display = "block";
        return;
    }

    const lines = extractFileText.split(/\r?\n/);
    const hitLines = [];
    for (let i = 0; i < lines.length; i++) {
        const spans = findMatchSpansRegex(lines[i], regex);
        if (spans.length) hitLines.push({ idx: i, spans });
    }

    const ranges = mergeRanges(hitLines.map(h => [Math.max(0, h.idx - context), Math.min(lines.length - 1, h.idx + context)]));
    const maxRanges = 200;
    const maxLinesOut = 3000;
    const limitedRanges = ranges.slice(0, maxRanges);

    let outLinesCount = 0;
    const hitMap = new Map(hitLines.map(h => [h.idx, h.spans]));
    let html = "";
    for (let r = 0; r < limitedRanges.length; r++) {
        const [from, to] = limitedRanges[r];
        if (r > 0) html += "\n\n-----\n\n";
        for (let i = from; i <= to; i++) {
            outLinesCount++;
            if (outLinesCount > maxLinesOut) {
                html += "\n... (output truncated)";
                r = limitedRanges.length;
                break;
            }
            const spans = hitMap.get(i) || [];
            const content = spans.length ? highlightLine(lines[i], spans) : escapeHtml(lines[i]);
            html += `<span class=\"ln\">${String(i + 1).padStart(5, " ")}</span> ${content}\n`;
        }
    }

    const rangeTrunc = ranges.length > limitedRanges.length ? `, ranges truncated to ${limitedRanges.length}/${ranges.length}` : "";
    metaEl.textContent = `${extractFileName || "(file)"} | lines=${lines.length} | hits=${hitLines.length}${rangeTrunc}`;
    outEl.innerHTML = html || "(no output)";
}

// 清空提取器的文件、提示和输出内容。
function clearExtractor() {
    extractFileName = "";
    extractFileText = "";
    const metaEl = document.getElementById("extractMeta");
    const errEl = document.getElementById("extractError");
    const outEl = document.getElementById("extractResults");
    const fileEl = document.getElementById("extractFileInput");
    if (fileEl) fileEl.value = "";
    metaEl.textContent = "";
    errEl.style.display = "none";
    errEl.textContent = "";
    outEl.textContent = "";
}

// 初始化提取器的文件选择、搜索和清空事件。
function initExtractor() {
    const fileEl = document.getElementById("extractFileInput");
    const runBtn = document.getElementById("extractRunBtn");
    const clearBtn = document.getElementById("extractClearBtn");
    const keywordEl = document.getElementById("extractKeywordInput");
    const metaEl = document.getElementById("extractMeta");
    const errEl = document.getElementById("extractError");

    if (!fileEl || !runBtn || !clearBtn || !keywordEl) return;

    fileEl.addEventListener("change", async () => {
        errEl.style.display = "none";
        errEl.textContent = "";
        const file = fileEl.files && fileEl.files[0];
        if (!file) return;
        if (file.size > 15 * 1024 * 1024) {
            errEl.textContent = "File is large; extraction may be slow in browser.";
            errEl.style.display = "block";
        }
        extractFileName = file.name;
        try {
            extractFileText = await file.text();
            metaEl.textContent = `${extractFileName} | size=${file.size} bytes`;
        } catch (e) {
            extractFileText = "";
            errEl.textContent = `Read file failed: ${e && e.message ? e.message : e}`;
            errEl.style.display = "block";
        }
    });

    runBtn.addEventListener("click", () => runExtractor());
    clearBtn.addEventListener("click", () => clearExtractor());
    keywordEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") runExtractor();
    });
}

//#endregion

//#region 首页 · 启动

initPanelMonthControls();
renderYearPicker();
if (openCreateYearBtn) {
    openCreateYearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (createYear?.classList.contains('open')) closeCreateYearPanel();
        else openCreateYearPanel();
    });
}
if (yearAddBtn) {
    yearAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isReadonlyMode()) return;
        showNewYearInput();
    });
}
if (yearRemoveModeBtn) {
    yearRemoveModeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isReadonlyMode()) return;
        showRemoveYearMode();
    });
}
if (yearConfirmBtn) {
    yearConfirmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        commitNewYear(yearNewInput);
    });
}
if (yearPickRemoveBtn) {
    yearPickRemoveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (yearPickRemoveBtn.textContent === '移除') confirmRemoveSelectedYear();
    });
}
if (yearNewInput) {
    yearNewInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitNewYear(yearNewInput);
        if (e.key === 'Escape') {
            yearInputActive = false;
            renderYearPicker();
        }
    });
    yearNewInput.addEventListener('click', (e) => e.stopPropagation());
}
if (createYear) {
    createYear.addEventListener('click', (e) => {
        if (e.target === createYear) closeCreateYearPanel();
    });
    const box = createYear.querySelector('.create-year-box');
    if (box) box.addEventListener('click', (e) => e.stopPropagation());
}
if (deleteCancelBtn) {
    deleteCancelBtn.addEventListener('click', hideDeleteYearConfirm);
}
if (DeleteConfirmBtn) {
    DeleteConfirmBtn.addEventListener('click', () => {
        if (isReadonlyMode()) return;
        if (pendingDeleteYear != null) deleteLedgerYear(pendingDeleteYear);
    });
}
if (deleteConfirmLayer) {
    deleteConfirmLayer.addEventListener('click', (e) => {
        if (e.target === deleteConfirmLayer) hideDeleteYearConfirm();
    });
}
initStackTotalEditing();
initExtractor();
loadLedgerYear(currentYear);
syncLedgerYearsFromDb();
//#endregion

//#endregion

//#region 主页收支入口

const overviewToggleIncomeBtn = document.getElementById('overviewToggleIncome');
const overviewToggleExpenseBtn = document.getElementById('overviewToggleExpense');
const overviewIncomeBranch = document.getElementById('overviewIncomeBranch');
const overviewExpenseBranch = document.getElementById('overviewExpenseBranch');

function setOverviewBlock(el, on, display) {
    if (!el) return;
    el.style.display = on ? (display || 'grid') : 'none';
}

function isOverviewBlockOpen(el) {
    return !!(el && el.style.display !== 'none' && el.style.display !== '');
}

function setOverviewExpanded(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
}

function toggleOverviewRoot(kind) {
    const isIncome = kind === 'income';
    const branch = isIncome ? overviewIncomeBranch : overviewExpenseBranch;
    const btn = isIncome ? overviewToggleIncomeBtn : overviewToggleExpenseBtn;
    if (!branch || !btn) return;
    const willOpen = !isOverviewBlockOpen(branch);
    setOverviewBlock(branch, willOpen, 'flex');
    setOverviewExpanded(btn, willOpen);
}

if (overviewToggleIncomeBtn) overviewToggleIncomeBtn.addEventListener('click', () => toggleOverviewRoot('income'));
if (overviewToggleExpenseBtn) overviewToggleExpenseBtn.addEventListener('click', () => toggleOverviewRoot('expense'));

const overviewOpenDineinBtn = document.getElementById('overviewOpenDineinBtn');
if (overviewOpenDineinBtn) overviewOpenDineinBtn.addEventListener('click', () => openOverlay('dineinLayer'));
const overviewOpenCashBtn = document.getElementById('overviewOpenCashBtn');
if (overviewOpenCashBtn) overviewOpenCashBtn.addEventListener('click', () => openEditableCash());
const overviewOpenExpenseBtnHome = document.getElementById('overviewOpenExpenseBtn');
if (overviewOpenExpenseBtnHome) overviewOpenExpenseBtnHome.addEventListener('click', () => openOverlay('expenseLayer'));
const overviewOpenCostBtn = document.getElementById('overviewOpencostBtn');
if (overviewOpenCostBtn) overviewOpenCostBtn.addEventListener('click', () => openOverlay('costLayer'));
const overviewOpenOthersBtn = document.getElementById('overviewOpenothersBtn');
if (overviewOpenOthersBtn) overviewOpenOthersBtn.addEventListener('click', () => openOverlay('othersLayer'));
const checksBtn = document.getElementById('checksBtn');
if (checksBtn) checksBtn.addEventListener('click', () => openOverlay('checksLayer'));
['overviewOpenDeliveryBtn1', 'overviewOpenDeliveryBtn2', 'overviewOpenDeliveryBtn3', 'overviewOpenDeliveryBtn4'].forEach((id) => {
const btn = document.getElementById(id);
if (btn) btn.addEventListener('click', () => openOverlay('detailLayer'));
});

//#endregion

//#region 现金面板

let cashReadonlyMode = false;

// 切换 Cash 面板的只读状态。
function setCashReadonlyMode(on) {
    cashReadonlyMode = !!on;
    if (!cashLayer) return;
    const panel = cashLayer.querySelector('.cash-panel');
    if (panel) panel.classList.toggle('readonly', cashReadonlyMode);
    cashLayer.querySelectorAll('.cash-val').forEach((el) => {
        el.contentEditable = false;
        el.classList.remove('editing');
    });
}

// 以只读模式打开 Cash 面板。
function openReadonlyCash() {
    setCashReadonlyMode(true);
    openOverlay('cashLayer');
}

// 以可编辑模式打开 Cash 面板。
function openEditableCash() {
    setCashReadonlyMode(false);
    openOverlay('cashLayer');
}

function panelRefreshCash(data, dayCount) {
    const cashColumnA = document.getElementById('cashColumnA');
    const cashColumnB = document.getElementById('cashColumnB');
    cashColumnA.innerHTML = '';
    cashColumnB.innerHTML = '';
    const midpoint = Math.min(15, Math.ceil(dayCount / 2));
    const firstHalf = data.cashDays.slice(0, midpoint);
    const secondHalf = data.cashDays.slice(midpoint);

    // 渲染单个现金日条目到列表列。
    const renderCashItem = (value, dayIndex, col) => {
        const li = document.createElement('li');
        li.className = 'cash-item';
        li.dataset.dayIndex = dayIndex;
        const dateStr = `${currentMonth + 1}/${dayIndex + 1}`;
        li.innerHTML = `<span class="cash-date">${dateStr} :</span> <span class="cash-val">${formatLedgerCellDisplay(value)}</span>`;
        col.appendChild(li);
    };

    firstHalf.forEach((value, i) => {
        renderCashItem(value, i, cashColumnA);
    });
    secondHalf.forEach((value, i) => {
        renderCashItem(value, midpoint + i, cashColumnB);
    });

    // 更新现金面板上下半区与合计。
    const updateCashTotals = () => {
        const dCount = data.cashDays.length;
        const fhTotal = sumLedgerDayArray(data.cashDays.slice(0, midpoint));
        const shTotal = sumLedgerDayArray(data.cashDays.slice(midpoint));

        document.getElementById('cashFirstHalf').innerHTML = `<span class="cash-date">Total :</span> <span>${formatCategoryDisplay(fhTotal)}</span>`;
        document.getElementById('cashSecondHalf').innerHTML = `<span class="cash-date">Total :</span> <span>${formatCategoryDisplay(shTotal)}</span>`;
        document.getElementById('cashGrandTotal').innerHTML = `<span class="cash-date">Total :</span> <span style="font-weight:normal;">${formatCategoryDisplay(fhTotal + shTotal)}</span>`;
    };
    updateCashTotals();

    document.querySelectorAll('.cash-item').forEach(li => {
        const valElem = li.querySelector('.cash-val');
        const dayIndex = parseInt(li.dataset.dayIndex, 10);

        li.addEventListener('click', (e) => {
            if (cashReadonlyMode || isReadonlyMode()) return;
            if (document.activeElement !== valElem) {
                valElem.contentEditable = true;
                valElem.focus({ preventScroll: true });
            }
        });

        valElem.addEventListener('focus', function () {
            if (cashReadonlyMode || isReadonlyMode()) {
                this.blur();
                return;
            }
            this.classList.add('editing');
            this._oldVal = this.textContent;
            const range = document.createRange();
            range.selectNodeContents(this);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        valElem.addEventListener('keydown', function (e) {
            if (cashReadonlyMode || isReadonlyMode()) {
                e.preventDefault();
                this.blur();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                this.blur();
            } else if (e.key === 'Escape') {
                this.textContent = this._oldVal;
                this.blur();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                this.blur();
                const allVals = Array.from(document.querySelectorAll('.cash-val'));
                const currentIndex = allVals.indexOf(this);
                if (currentIndex > -1 && currentIndex < allVals.length - 1) {
                    const nextVal = allVals[currentIndex + 1];
                    nextVal.contentEditable = true;
                    nextVal.focus({ preventScroll: true });
                }
            }
        });

        valElem.addEventListener('blur', function () {
            this.contentEditable = false;
            this.classList.remove('editing');
            if (cashReadonlyMode || isReadonlyMode()) return;
            window.getSelection().removeAllRanges();

            const rawText = (this.textContent || '').trim();
            if (rawText === '') {
                data.cashDays[dayIndex] = '';
                this.textContent = '';
                updateCashTotals();
                renderMonthState();
                saveToStorage();
                return;
            }

            if (rawText.toLowerCase() === 'off') {
                data.cashDays[dayIndex] = 'off';
                updateCashTotals();
                this.textContent = 'off';
                renderMonthState();
                saveToStorage();
                return;
            }

            const newValue = parseFloat(rawText.replace(/[^0-9.]/g, ''));
            if (!isNaN(newValue)) {
                data.cashDays[dayIndex] = newValue;
                updateCashTotals();
                this.textContent = formatLedgerCellDisplay(newValue);
                renderMonthState();
                saveToStorage();
            } else {
                this.textContent = this._oldVal;
            }
        });
    });

}



//#region Quick C

// 在页面中央显示 quick 保存提示。
function showQuickToast(message) {
    showGlobalSaveToast(message, 9999, 1500);
}

const quickDateText = document.getElementById('quickDateText');
const quickDateInput = document.getElementById('quickDateInput');
const quickDateInputWrap = document.getElementById('quickDateInputWrap');
const quickMonthBtn = document.getElementById('quickMonthBtn');
const quickDayBtn = document.getElementById('quickDayBtn');
const quickMonthMenu = document.getElementById('quickMonthMenu');
const quickDayMenu = document.getElementById('quickDayMenu');
const quickWrenchBtn = document.getElementById('quickWrenchBtn');
const quickValInput = document.getElementById('quickValInput');
const quickSaveBtn = document.getElementById('quickSaveBtn');
const quickDateRow = document.getElementById('quickDateRow');

let quickDefaultDate = '';

// 同步 quick 面板显示日期和默认日期值。

function setQuickDate(dateStr) {
    var parts = (dateStr || '').split('/');
    var m = parseInt(parts[0]);
    var d = parseInt(parts[1]);
    if (m && d) {
        quickDateText.textContent = MONTH_ABBR[m - 1] + ' ' + d;
    } else {
        quickDateText.textContent = dateStr;
    }
    quickDateInput.value = dateStr;
    quickDefaultDate = dateStr;
}

// 切回 quick 面板的日期文本展示模式。
function showQuickDate() {
    quickDateText.style.display = '';
    quickDateInputWrap.style.display = 'none';
    quickWrenchBtn.style.display = '';
}

// 切到 quick 面板的日期编辑模式并弹出下拉选择。
function showQuickDateInput() {
    quickDateText.style.display = 'none';
    quickDateInputWrap.style.display = '';
    quickWrenchBtn.style.display = '';
    populateQuickDateSelects(quickDefaultDate);
}

var quickCurMonth = null;
var quickCurDay = null;

// 初始化月份按钮（一次性生成选项菜单）。
function buildQuickMonthPicker() {
    if (quickMonthMenu._built) return;
    for (var m = 1; m <= 12; m++) {
        (function (monthVal) {
            var btn = document.createElement('button');
            btn.className = 'quick-date-picker-option';
            btn.type = 'button';
            btn.textContent = MONTH_ABBR[monthVal - 1];
            btn.addEventListener('click', function () {
                quickCurMonth = monthVal;
                quickMonthBtn.textContent = MONTH_ABBR[monthVal - 1];
                syncQuickDayPicker(monthVal, null);
                syncQuickDateFromPickers();
                closeQuickPicker(quickMonthMenu.parentElement);
            });
            quickMonthMenu.appendChild(btn);
        })(m);
    }
    quickMonthMenu._built = true;
}

// 根据月份刷新日按钮菜单。
function syncQuickDayPicker(month, keepDay) {
    quickCurMonth = month;
    var year = Number(currentYear) || new Date().getFullYear();
    var daysInMonth = new Date(year, month, 0).getDate();
    var curDay = keepDay || quickCurDay || 1;
    if (curDay > daysInMonth) curDay = daysInMonth;
    quickCurDay = curDay;
    quickMonthBtn.textContent = MONTH_ABBR[month - 1];
    quickDayBtn.textContent = curDay;

    quickDayMenu.innerHTML = '';
    for (var d = 1; d <= daysInMonth; d++) {
        (function (dayVal) {
            var btn = document.createElement('button');
            btn.className = 'quick-date-picker-option';
            btn.type = 'button';
            btn.textContent = dayVal;
            if (dayVal === curDay) btn.classList.add('active');
            btn.addEventListener('click', function () {
                quickCurDay = dayVal;
                quickDayBtn.textContent = dayVal;
                syncQuickDateFromPickers();
                closeQuickPicker(quickDayMenu.parentElement);
            });
            quickDayMenu.appendChild(btn);
        })(d);
    }

    setTimeout(function () {
        var sel = quickDayMenu.querySelector('.active');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }, 0);
}

// 把按钮选择回写到标签。
function syncQuickDateFromPickers() {
    if (!quickCurMonth || !quickCurDay) return;
    var dateStr = quickCurMonth + '/' + quickCurDay;
    quickDateText.textContent = MONTH_ABBR[quickCurMonth - 1] + ' ' + quickCurDay;
    quickDefaultDate = dateStr;
    quickDateInput.value = dateStr;
}

// 打开一个 picker 菜单，关闭收支，并高亮当前月份。
function openQuickPicker(pickerEl) {
    closeAllQuickPickers();
    if (!pickerEl) return;

    if (pickerEl === quickMonthMenu.parentElement && quickCurMonth) {
        var btns = quickMonthMenu.querySelectorAll('.quick-date-picker-option');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', MONTH_ABBR.indexOf(btns[i].textContent) + 1 === quickCurMonth);
        }
    }

    pickerEl.classList.add('open');
    setTimeout(function () {
        var sel = pickerEl.querySelector('.quick-date-picker-option.active');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }, 0);
}

function closeQuickPicker(pickerEl) {
    if (pickerEl) pickerEl.classList.remove('open');
}

function closeAllQuickPickers() {
    closeQuickPicker(quickMonthMenu.parentElement);
    closeQuickPicker(quickDayMenu.parentElement);
}

// 按钮点击：切换菜单。
quickMonthBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var picker = quickMonthMenu.parentElement;
    if (picker.classList.contains('open')) { closeQuickPicker(picker); }
    else { openQuickPicker(picker); }
});

quickDayBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var picker = quickDayMenu.parentElement;
    if (picker.classList.contains('open')) { closeQuickPicker(picker); }
    else { openQuickPicker(picker); }
});

// 初始化月份选择器。
function populateQuickDateSelects(dateStr) {
    var parts = (dateStr || '').split('/');
    quickCurMonth = parseInt(parts[0]) || (new Date().getMonth() + 1);
    quickCurDay = parseInt(parts[1]) || new Date().getDate();
    buildQuickMonthPicker();
    syncQuickDayPicker(quickCurMonth, quickCurDay);
}

// 按营业日规则计算 quick 面板的默认日期。
function getQuickBusinessDate() {
    const now = new Date();
    const businessDate = new Date(now);
    if (now.getHours() < 15) {
        businessDate.setDate(businessDate.getDate() - 1);
    }
    return `${businessDate.getMonth() + 1}/${businessDate.getDate()}`;
}

// 用当前营业日刷新 quick 面板日期。
function updateQuickDate() {
    setQuickDate(getQuickBusinessDate());
}

// 把日期输入草稿自动整理成月/日格式。
function formatSmartDateDraft(raw) {
    var value = String(raw || '');
    var slashIndex = value.indexOf('/');
    if (slashIndex >= 0) {
        var leftPart = value.slice(0, slashIndex).replace(/\D/g, '').slice(0, 2);
        var rightPart = value.slice(slashIndex + 1).replace(/\D/g, '').slice(0, 2);
        return leftPart + '/' + rightPart;
    }
    var digits = value.replace(/\D/g, '').slice(0, 4);
    if (!digits) return '';
    if (digits.charAt(0) !== '1') {
        return digits.charAt(0) + '/' + digits.slice(1, 3);
    }
    if (digits.length === 1) return '1';
    if (digits.length === 2) {
        if (digits === '10' || digits === '11' || digits === '12') return digits + '/';
        return '1/' + digits.charAt(1);
    }
    if (digits.startsWith('10') || digits.startsWith('11') || digits.startsWith('12')) {
        return digits.slice(0, 2) + '/' + digits.slice(2, 4);
    }
    return '1/' + digits.slice(1, 3);
}

// 提取日期里的纯数字并限制长度。
function formatPlainDateDigits(raw) {
    return String(raw || '').replace(/\D/g, '').slice(0, 4);
}

// 为日期输入框绑定自动补全和提交逻辑。
function bindSmartDateInput(input, getCommittedValue, commitValue) {
    if (!input) return;
    function clearTimer() {
        if (input._slashTimer) {
            clearTimeout(input._slashTimer);
            input._slashTimer = null;
        }
    }
    input.addEventListener('focus', function () {
        clearTimer();
        input._oldVal = typeof getCommittedValue === 'function' ? getCommittedValue() : (input.value || '');
        input._prevDisplayValue = input.value || '';
        input._suppressAutoSlash = false;
    });
    input.addEventListener('input', function () {
        clearTimer();
        var raw = String(input.value || '');
        var prev = String(input._prevDisplayValue || '');
        var prevHadSlash = prev.indexOf('/') >= 0;
        var hasSlashNow = raw.indexOf('/') >= 0;
        if (!raw) {
            input._suppressAutoSlash = false;
        } else if (prevHadSlash && !hasSlashNow) {
            input._suppressAutoSlash = true;
        } else if (hasSlashNow) {
            input._suppressAutoSlash = false;
        }
        var formatted = input._suppressAutoSlash ? formatPlainDateDigits(raw) : formatSmartDateDraft(raw);
        input.value = formatted;
        input._prevDisplayValue = formatted;
        if (!input._suppressAutoSlash && formatted === '1') {
            input._slashTimer = setTimeout(function () {
                if (document.activeElement !== input) return;
                if (input.value === '1') {
                    input.value = '1/';
                    input._prevDisplayValue = input.value;
                    placeInputCaretToEnd(input);
                }
            }, 1000);
        }
        placeInputCaretToEnd(input);
    });
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            clearTimer();
            var val = input.value.trim();
            if (val) commitValue(val);
            else if (input._oldVal) commitValue(input._oldVal);
            input.blur();
        }
    });
    input.addEventListener('blur', function () {
        clearTimer();
        var val = input.value.trim();
        if (val) commitValue(val);
        else if (input._oldVal) commitValue(input._oldVal);
    });
}

// 点击任意位置关闭 picker 菜单。
document.addEventListener('click', function (e) {
    var pickers = [quickMonthMenu.parentElement, quickDayMenu.parentElement];
    for (var i = 0; i < pickers.length; i++) {
        if (pickers[i] && pickers[i].classList.contains('open') && !pickers[i].contains(e.target)) {
            pickers[i].classList.remove('open');
        }
    }
});

document.getElementById('openQuickBtn').addEventListener('click', () => {
    if (isReadonlyMode()) return;
    openOverlay('quickLayer');
});

quickWrenchBtn.addEventListener('click', (e) => {
    if (isReadonlyMode()) return;
    e.stopPropagation();
    showQuickDateInput();
});

bindSmartDateInput(quickDateInput, function () {
    return quickDefaultDate;
}, function (val) {
    setQuickDate(val);
    showQuickDate();
});

quickDateRow.addEventListener('click', (e) => {
    if (e.target !== quickWrenchBtn && !quickDateInputWrap.contains(e.target)) {
        setQuickDate(quickDefaultDate);
        showQuickDate();
    }
});

quickValInput.addEventListener('input', function () {
    var digits = this.value.replace(/[^0-9.]/g, '');
    var parts = digits.split('.');
    if (parts.length > 2) digits = parts[0] + '.' + parts.slice(1).join('');
    this.value = digits;
});

quickSaveBtn.addEventListener('click', () => {
    if (isReadonlyMode()) return;
    const date = quickDefaultDate;
    const val = quickValInput.value.trim();
    if (!val) return;
    let didSave = false;
    let opText = '';

    const parts = date.split('/');
    if (parts.length === 2) {
        const month = parseInt(parts[0], 10) - 1;
        const day = parseInt(parts[1], 10) - 1;

        const _targetDays = getDaysInMonth(month);
        if (month >= 0 && month < 12 && day >= 0 && day < _targetDays) {
            if (!monthData[month].cashDays || monthData[month].cashDays.length !== _targetDays) {
                monthData[month].cashDays = new Array(_targetDays).fill('');
            }
            const oldValRaw = monthData[month].cashDays[day];
            if (val.toLowerCase() === 'off') {
                monthData[month].cashDays[day] = 'off';
                const oldEmpty = normalizeLedgerDayValue(oldValRaw) === '';
                const oldDisplay = oldEmpty ? '' : formatLedgerCellDisplay(oldValRaw);
                const newDisplay = 'off';
                if (oldEmpty) {
                    opText = `保存数据 ${date}: ${formatBracketValue(newDisplay)}`;
                } else if (String(oldDisplay) === newDisplay) {
                    opText = `无变更保存 ${date}: ${formatBracketValue(newDisplay)}`;
                } else {
                    opText = `修改数据 ${date}: ${formatBracketValue(oldDisplay)} → ${date}: ${formatBracketValue(newDisplay)}`;
                }
                saveToStorage();
                didSave = true;
                if (month === currentMonth) renderMonthState();
            } else {
                const numVal = parseFloat(val.replace(/[^0-9.]/g, ''));
                if (!isNaN(numVal)) {
                    monthData[month].cashDays[day] = numVal;
                    const oldEmpty = normalizeLedgerDayValue(oldValRaw) === '';
                    const oldDisplay = oldEmpty ? '' : formatLedgerCellDisplay(oldValRaw);
                    const newDisplay = String(numVal);
                    if (oldEmpty) {
                        opText = `保存数据 ${date}: ${formatBracketValue(newDisplay)}`;
                    } else if (String(oldDisplay) === newDisplay) {
                        opText = `无变更保存 ${date}: ${formatBracketValue(newDisplay)}`;
                    } else {
                        opText = `修改数据 ${date}: ${formatBracketValue(oldDisplay)} → ${date}: ${formatBracketValue(newDisplay)}`;
                    }
                    saveToStorage();
                    didSave = true;
                    if (month === currentMonth) renderMonthState();
                }
            }
        }
    }

    if (didSave) {
        if (opText) addOperationRecord(opText);
        quickValInput.value = '';
        const fromVerify = reopenVerifyOnClose;
        goBack();
        if (fromVerify) showVerifyFrontToast('保存成功');
        else showQuickToast('保存成功');
    }
});

quickValInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        quickSaveBtn.click();
    }
});

if (quickLayer) {
    quickLayer.addEventListener('click', function (e) {
        if (e.target === quickLayer) goBack();
    });
}

//#endregion


//#endregion

//#region 刷卡面板

function panelRefreshDinein(data) {
    const detailListEl = document.getElementById('detailList');
    if (detailListEl) {
        detailListEl.innerHTML = '';
        const dineinRows = Array.isArray((data.deliveryDetails || {}).dinein) ? data.deliveryDetails.dinein : [];
        for (let slot = 1; slot <= 32; slot += 1) {
            const rowIndex = slot - 1;
            const row = document.createElement('li');
            row.className = 'detail-row';

            if (rowIndex < dineinRows.length) {
                const entry = String(dineinRows[rowIndex] || '');
                const m = entry.match(/^(\d{2}\/\d{2}\/\d{2})\s+(.+)$/);
                const dateLabel = m ? shortenSlashDateLabel(m[1]) : '';
                const val = m ? formatNonCashTextDisplay(m[2]) : '';
                row.dataset.rowIndex = String(rowIndex);
                row.innerHTML = `<span>${dateLabel}</span><span class="detail-value">${val}</span>`;
            } else {
                row.removeAttribute('data-row-index');
                row.innerHTML = `<span></span><span class="detail-value"></span>`;
            }

            detailListEl.appendChild(row);
        }
        applyDetailImportHighlights();
        bindDetailImportEditing();
        // Total = 刷卡明细各行数字之和（四舍五入到整数）
        const sum = Math.round(dineinRows.reduce((s, it) => s + parseNumberSafe(it), 0));
        const ov = data.totalOverrides || {};
        if (!(typeof ov.Check === 'number' && ov.Check !== 0 && Number.isFinite(ov.Check))) {
            const el = document.getElementById('stackDineTotalValue');
            if (el) el.textContent = formatCategoryDisplay(sum);
        }
    }


}

//#endregion

//#region 工资面板

    //#region 创建表格
// 清洗工资行数据并过滤历史备注行。
const sanitizeSalaryRow = (row) => {
    const source = Array.isArray(row) ? row : ['', '', ''];
    const normalized = [
        source[0] ?? '',
        String(source[1] ?? '').replace(/\u00a0/g, '').trim(),
        String(source[2] ?? '').replace(/\u00a0/g, '').trim(),
    ];
    const nameText = String(normalized[0]).replace(/\u00a0/g, ' ').trim();
    if (nameText.includes('每月固定')) {
        return ['', '', ''];
    }
    return normalized;
};

// 判断工资行是否包含有效数据。
const rowHasSalaryData = (row) => {
    if (!Array.isArray(row)) return false;
    return row.some((cell) => String(cell || '').replace(/\u00a0/g, '').trim() !== '');
};

const SALARY_MAX_ROWS = 12;
const SALARY_DEFAULT_FIRST_ROWS = 5;
const SALARY_DEFAULT_SECOND_ROWS = 3;

// 计算工资表应显示的行数。
const getSalaryVisibleRowCount = (rows, firstRows, secondRows) => {
    const baseRows = Array.isArray(rows) ? rows.map((r) => sanitizeSalaryRow(r)).slice(0, SALARY_MAX_ROWS) : [];
    while (baseRows.length < SALARY_MAX_ROWS) baseRows.push(['', '', '']);
    let lastDataIndex = -1;
    for (let i = 0; i < baseRows.length; i++) {
        if (rowHasSalaryData(baseRows[i])) lastDataIndex = i;
    }
    return Math.max(firstRows + secondRows, Math.min(SALARY_MAX_ROWS, lastDataIndex + 2));
};

// 规范化收支行二元组结构。
const normalizeExpenseEntryRow = (row) => {
    const source = Array.isArray(row) ? row : ['', ''];
    return [source[0] ?? '', source[1] ?? ''];
};

// 规范化可编辑单元格文本。
const normalizeEditableCellText = (value) => String(value || '').replace(/\u00a0/g, ' ').trim();

const rowHasExpenseEntryData = (row) => {
    if (!Array.isArray(row)) return false;
    return row.some((cell) => {
        const text = String(cell || '').replace(/\u00a0/g, '').trim();
        return text !== '' && text !== '-';
    });
};

const trimTrailingEmptyRows = (rows, normalizeRow, hasRowData) => {
    const normalized = Array.isArray(rows) ? rows.map((row) => normalizeRow(row)) : [];
    while (normalized.length && !hasRowData(normalized[normalized.length - 1])) {
        normalized.pop();
    }
    return normalized;
};

const ensureSalaryLayout = (data) => {
    if (!Array.isArray(data.salaryRows)) data.salaryRows = [];
    data.salaryRows = trimTrailingEmptyRows(data.salaryRows, sanitizeSalaryRow, rowHasSalaryData).slice(0, SALARY_MAX_ROWS);

    const computeLayoutFromRows = (inputRows, startFirstRows, startSecondRows) => {
        const baseRows = inputRows.map((r) => sanitizeSalaryRow(r));
        while (baseRows.length < SALARY_MAX_ROWS) baseRows.push(['', '', '']);
        const countDataInRange = (start, len) => {
            let cnt = 0;
            for (let i = start; i < start + len; i++) {
                if (rowHasSalaryData(baseRows[i])) cnt += 1;
            }
            return cnt;
        };

        let firstRows = Math.max(1, Math.min(SALARY_MAX_ROWS - 1, Number(startFirstRows) || SALARY_DEFAULT_FIRST_ROWS));
        let secondRows = Math.max(1, Math.min(SALARY_MAX_ROWS - firstRows, Number(startSecondRows) || SALARY_DEFAULT_SECOND_ROWS));
        const firstDataCount = countDataInRange(0, firstRows);
        const secondDataCount = countDataInRange(firstRows, secondRows);
        const desiredFirst = Math.max(SALARY_DEFAULT_FIRST_ROWS, firstDataCount + 1);
        const desiredSecond = Math.max(SALARY_DEFAULT_SECOND_ROWS, secondDataCount + 1);
        let thirdEmptyCount = 0;
        for (let i = firstRows + secondRows; i < SALARY_MAX_ROWS; i++) {
            if (!rowHasSalaryData(baseRows[i])) thirdEmptyCount += 1;
        }
        firstRows = Math.max(SALARY_DEFAULT_FIRST_ROWS, Math.min(firstRows, desiredFirst));
        secondRows = Math.max(SALARY_DEFAULT_SECOND_ROWS, Math.min(secondRows, desiredSecond));
        let needFirstGrow = Math.max(0, desiredFirst - firstRows);
        let needSecondGrow = Math.max(0, desiredSecond - secondRows);
        while (needFirstGrow > 0 && thirdEmptyCount > 0) {
            firstRows += 1;
            needFirstGrow -= 1;
            thirdEmptyCount -= 1;
        }
        while (needSecondGrow > 0 && thirdEmptyCount > 0) {
            secondRows += 1;
            needSecondGrow -= 1;
            thirdEmptyCount -= 1;
        }
        return { firstRows, secondRows };
    };

    const layout = computeLayoutFromRows(
        data.salaryRows,
        data.salarySectionFirstRows,
        data.salarySectionSecondRows
    );

    data.salarySectionFirstRows = layout.firstRows;
    data.salarySectionSecondRows = layout.secondRows;
    return { firstRows: layout.firstRows, secondRows: layout.secondRows, totalRows: SALARY_MAX_ROWS };
};

const computeSalaryLayoutFromRows = (rows, startFirstRows, startSecondRows) => {
    const baseRows = rows.map((r) => sanitizeSalaryRow(r));
    while (baseRows.length < SALARY_MAX_ROWS) baseRows.push(['', '', '']);
    if (baseRows.length > SALARY_MAX_ROWS) baseRows.length = SALARY_MAX_ROWS;

    const countDataInRange = (start, len) => {
        let cnt = 0;
        for (let i = start; i < start + len; i++) {
            if (rowHasSalaryData(baseRows[i])) cnt += 1;
        }
        return cnt;
    };

    let firstRows = Math.max(1, Math.min(SALARY_MAX_ROWS - 1, Number(startFirstRows) || SALARY_DEFAULT_FIRST_ROWS));
    let secondRows = Math.max(1, Math.min(SALARY_MAX_ROWS - firstRows, Number(startSecondRows) || SALARY_DEFAULT_SECOND_ROWS));
    const firstDataCount = countDataInRange(0, firstRows);
    const secondDataCount = countDataInRange(firstRows, secondRows);
    const desiredFirst = Math.max(SALARY_DEFAULT_FIRST_ROWS, firstDataCount + 1);
    const desiredSecond = Math.max(SALARY_DEFAULT_SECOND_ROWS, secondDataCount + 1);
    let thirdEmptyCount = 0;
    for (let i = firstRows + secondRows; i < SALARY_MAX_ROWS; i++) {
        if (!rowHasSalaryData(baseRows[i])) thirdEmptyCount += 1;
    }
    firstRows = Math.max(SALARY_DEFAULT_FIRST_ROWS, Math.min(firstRows, desiredFirst));
    secondRows = Math.max(SALARY_DEFAULT_SECOND_ROWS, Math.min(secondRows, desiredSecond));
    let needFirstGrow = Math.max(0, desiredFirst - firstRows);
    let needSecondGrow = Math.max(0, desiredSecond - secondRows);
    while (needFirstGrow > 0 && thirdEmptyCount > 0) {
        firstRows += 1;
        needFirstGrow -= 1;
        thirdEmptyCount -= 1;
    }
    while (needSecondGrow > 0 && thirdEmptyCount > 0) {
        secondRows += 1;
        needSecondGrow -= 1;
        thirdEmptyCount -= 1;
    }
    return { firstRows, secondRows, totalRows: SALARY_MAX_ROWS };
};

const normalizeSalaryRowsBySections = (rows, sourceFirstRows, sourceSecondRows, targetFirstRows, targetSecondRows, totalRows) => {
    const normalized = Array.isArray(rows) ? rows.slice(0, totalRows) : [];
    while (normalized.length < totalRows) normalized.push(['', '', '']);
    const cleaned = normalized.map((r) => sanitizeSalaryRow(r));

    const sourceFirst = Math.max(1, Math.min(totalRows - 1, Number(sourceFirstRows) || 5));
    const sourceSecond = Math.max(1, Math.min(totalRows - sourceFirst, Number(sourceSecondRows) || 3));
    const firstRows = Math.max(1, Math.min(totalRows - 1, Number(targetFirstRows) || 5));
    const secondRows = Math.max(1, Math.min(totalRows - firstRows, Number(targetSecondRows) || 3));
    const sec1 = cleaned.slice(0, sourceFirst);
    const sec2 = cleaned.slice(sourceFirst, sourceFirst + sourceSecond);
    const sec3 = cleaned.slice(sourceFirst + sourceSecond, totalRows);

    const pullBlankFromThird = () => {
        for (let i = sec3.length - 1; i >= 0; i--) {
            if (!rowHasSalaryData(sec3[i])) {
                sec3.splice(i, 1);
                return true;
            }
        }
        return false;
    };
    const resizeSection = (section, targetLen, nextSection) => {
        if (section.length > targetLen) {
            const overflow = section.splice(targetLen);
            nextSection.unshift(...overflow);
        } else if (section.length < targetLen) {
            const grow = targetLen - section.length;
            for (let i = 0; i < grow; i++) {
                if (!pullBlankFromThird()) break;
                section.push(['', '', '']);
            }
        }
    };
    const compactSection = (section) => {
        const filled = section.filter((row) => rowHasSalaryData(row));
        const blanks = section.filter((row) => !rowHasSalaryData(row));
        return [...filled, ...blanks];
    };
    resizeSection(sec1, firstRows, sec2);
    resizeSection(sec2, secondRows, sec3);
    const sec1Packed = compactSection(sec1);
    const sec2Packed = compactSection(sec2);
    const sec3Packed = compactSection(sec3);

    const out = [...sec1Packed, ...sec2Packed, ...sec3Packed];
    while (out.length < totalRows) out.push(['', '', '']);
    return out.slice(0, totalRows);
};

const parseVal = (str) => {
    if (!str || str.replace(/&nbsp;/g, '').trim() === '' || str === '-') return 0;
    // 正则匹配所有数字（包含小数点）
    const matches = str.match(/-?\d+(\.\d+)?/g);
    if (!matches) return 0;
    // 将匹配到的所有数字求和
    return matches.reduce((acc, curr) => acc + parseFloat(curr), 0);
};

const tryResolveCellExpression = (cell) => {
    if (!cell || cell.dataset.col === '0') return;
    const raw = String(cell.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (!raw || !/[+\-*/()]/.test(raw)) return;
    if (!/^[\d+\-*/().\s]+$/.test(raw)) return;
    try {
        const result = Function(`"use strict"; return (${raw});`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) return;
        cell.textContent = formatNonCashTextDisplay(result);
    } catch (_) { }
};

    //#endregion

    //#region 汇总工资/收支并回写 monthData。

function ensureSalaryCheckRows(data) {
    const layout = ensureSalaryLayout(data);
    if (!Array.isArray(data.salaryCheckRows)) data.salaryCheckRows = [];
    while (data.salaryCheckRows.length < layout.totalRows) data.salaryCheckRows.push(['', '', '']);
    data.salaryCheckRows = data.salaryCheckRows.slice(0, layout.totalRows).map((row) => {
        const cleaned = sanitizeSalaryRow(row);
        return ['', cleaned[1], cleaned[2]];
    });
    return layout;
}

function readSalaryCheckSupplementFromDom(rowIndex) {
    const readCol = (col) => {
        const el = document.querySelector(`#salaryTableBodyFull .editable-cell[data-type="salary-check"][data-row="${rowIndex}"][data-col="${col}"]`);
        return normalizeEditableCellText(el ? el.textContent : '');
    };
    return ['', readCol(1), readCol(2)];
}

function salaryCombinedAmount(cashRow, checkRow, col) {
    return parseVal(cashRow[col]) + parseVal(checkRow[col]);
}

// 现金页 / 支票页共用：本页数字固定在原位，另一页的数字灰色只读、贴在它右侧。
// 原位上的元素（anchor）与普通格子完全一致；右侧元素绝对定位，不占位、不推动 anchor。
function buildSalaryDualCellHtml(type, rowIndex, colIndex, cashVal, checkVal) {
    const ownIsCash = type === 'salary';
    const ownVal = ownIsCash ? cashVal : checkVal;
    const otherVal = ownIsCash ? checkVal : cashVal;
    const attrs = `data-type="${type}" data-row="${rowIndex}" data-col="${colIndex}"`;
    if (isBlankLedgerValue(otherVal)) {
        const ownDisplay = isBlankLedgerValue(ownVal) ? '&nbsp;' : formatNonCashTextDisplay(ownVal);
        return { html: `<span class="editable-cell" ${attrs}>${ownDisplay}</span>`, tdClass: '' };
    }
    const otherText = formatNonCashTextDisplay(otherVal);
    if (isBlankLedgerValue(ownVal)) {
        return {
            html: `<span class="static-cell salary-other-val salary-dual-anchor">${otherText}</span>`
                + `<span class="editable-cell salary-dual-overlay" ${attrs}>&nbsp;</span>`,
            tdClass: 'salary-dual-cell',
        };
    }
    const ownText = formatNonCashTextDisplay(ownVal);
    return {
        html: `<span class="editable-cell salary-dual-anchor" ${attrs}>${ownText}</span>`
            + `<span class="salary-other-val salary-dual-right">${otherText}</span>`,
        tdClass: 'salary-dual-cell',
    };
}

function buildCashPageAmountCellHtml(rowIndex, colIndex, cashVal, checkVal) {
    return buildSalaryDualCellHtml('salary', rowIndex, colIndex, cashVal, checkVal);
}

function buildCheckPageAmountCellHtml(rowIndex, colIndex, cashVal, checkVal) {
    return buildSalaryDualCellHtml('salary-check', rowIndex, colIndex, cashVal, checkVal);
}

function isSalaryMobileView() {
    return window.matchMedia('(max-width: 480px)').matches;
}

function positionSalaryDualRight() {
    document.querySelectorAll('#expenseLayer td.salary-dual-cell').forEach((td) => {
        const anchor = td.querySelector('.salary-dual-anchor');
        const right = td.querySelector('.salary-dual-right');
        if (!anchor || !right || right.classList.contains('editing')) return;
        if (!td.offsetWidth) return;
        const range = document.createRange();
        range.selectNodeContents(anchor);
        const textRect = range.getBoundingClientRect();
        const tdRect = td.getBoundingClientRect();
        const scale = tdRect.width / td.offsetWidth || 1;
        const anchorStyle = getComputedStyle(anchor);
        right.style.fontSize = anchorStyle.fontSize;
        right.style.lineHeight = anchorStyle.lineHeight;
        right.style.left = isSalaryMobileView()
            ? `${Math.round((textRect.right - tdRect.left) / scale + 4)}px`
            : '240px';
        const baseBottom = (tdRect.bottom - textRect.bottom) / scale;
        right.style.bottom = `${baseBottom}px`;
        const rightRange = document.createRange();
        rightRange.selectNodeContents(right);
        const rightRect = rightRange.getBoundingClientRect();
        const delta = (textRect.bottom - rightRect.bottom) / scale;
        right.style.bottom = `${Math.round(baseBottom - delta)}px`;
    });
}

// 现金页表头 Cash 右侧的灰色 Total，以及每行对齐在它下面的「现金 + 支票」合计。
function positionSalaryCombined() {
    const head = document.getElementById('salaryCombinedHead');
    if (!head || head.hidden) return;
    const th = head.parentElement;
    const label = th ? th.querySelector('.salary-hd-shift-left') : null;
    if (!th || !label || !th.offsetWidth) return;
    const thRect = th.getBoundingClientRect();
    const scale = thRect.width / th.offsetWidth || 1;
    head.style.left = '250px';
    head.style.bottom = '9px';
    const mobile = isSalaryMobileView();
    document.querySelectorAll('#salaryTableBody .salary-row-combined').forEach((span) => {
        const td = span.parentElement;
        const anchor = td ? td.querySelector('.static-cell') : null;
        if (!td || !anchor) return;
        const anchorStyle = getComputedStyle(anchor);
        span.style.fontSize = anchorStyle.fontSize;
        span.style.lineHeight = anchorStyle.lineHeight;
        const anchorRange = document.createRange();
        anchorRange.selectNodeContents(anchor);
        const anchorRect = anchorRange.getBoundingClientRect();
        const tdRect = td.getBoundingClientRect();
        if (mobile) {
            span.style.left = `${Math.round((anchorRect.left - tdRect.left) / scale)}px`;
            span.style.top = `${Math.round((anchorRect.bottom - tdRect.top) / scale)}px`;
            span.style.bottom = 'auto';
            return;
        }
        span.style.top = '';
        span.style.left = '255px';
        const baseBottom = (tdRect.bottom - anchorRect.bottom) / scale;
        span.style.bottom = `${baseBottom}px`;
        const spanRange = document.createRange();
        spanRange.selectNodeContents(span);
        const delta = (anchorRect.bottom - spanRange.getBoundingClientRect().bottom) / scale;
        span.style.bottom = `${Math.round(baseBottom - delta)}px`;
    });
}

function scheduleSalaryDualPosition() {
    requestAnimationFrame(() => {
        positionSalaryDualRight();
        positionSalaryCombined();
    });
}

function applySalaryAmountTdClasses(td, tdClass) {
    if (!tdClass) return;
    String(tdClass).trim().split(/\s+/).forEach((cls) => {
        if (cls) td.classList.add(cls);
    });
}

const updateSalaryCheckTotals = (shouldPersist = true) => {
    const data = monthData[currentMonth];
    let col1Sum = 0;
    let col2Sum = 0;
    const layoutInfo = ensureSalaryCheckRows(data);
    const packedSalaryRows = [];
    let hasAnySalaryAmount = false;
    for (let i = 0; i < layoutInfo.totalRows; i++) {
        const cashRow = sanitizeSalaryRow(data.salaryRows[i] || ['', '', '']);
        const checkRow = sanitizeSalaryRow(readSalaryCheckSupplementFromDom(i));
        packedSalaryRows.push(['', checkRow[1], checkRow[2]]);
        const a = salaryCombinedAmount(cashRow, checkRow, 1);
        const b = salaryCombinedAmount(cashRow, checkRow, 2);
        col1Sum += a;
        col2Sum += b;
        if (a !== 0 || b !== 0) hasAnySalaryAmount = true;
    }

    document.querySelectorAll('#salaryTableBodyFull tr').forEach((tr, i) => {
        const cashRow = sanitizeSalaryRow(data.salaryRows[i] || ['', '', '']);
        const checkRow = packedSalaryRows[i] || ['', '', ''];
        const rowTotal = salaryCombinedAmount(cashRow, checkRow, 1) + salaryCombinedAmount(cashRow, checkRow, 2);
        const totalCell = tr.querySelector('td:last-child .static-cell');
        if (totalCell) totalCell.textContent = rowTotal !== 0 ? formatCategoryDisplay(rowTotal) : '\u00a0';
    });

    const salaryTotal = document.getElementById('salaryTotalValueFull');
    const salaryFirstTotal = document.getElementById('salaryFirstTotalValueFull');
    const salarySecondTotal = document.getElementById('salarySecondTotalValueFull');
    if (salaryTotal) salaryTotal.textContent = hasAnySalaryAmount ? formatCategoryDisplay(col1Sum + col2Sum) : '';
    if (salaryFirstTotal) salaryFirstTotal.textContent = hasAnySalaryAmount ? formatCategoryDisplay(col1Sum) : '';
    if (salarySecondTotal) salarySecondTotal.textContent = hasAnySalaryAmount ? formatCategoryDisplay(col2Sum) : '';

    const salaryGroupSummary = document.getElementById('salaryGroupSummaryFull');
    if (salaryGroupSummary) {
        const firstRows = Math.max(1, Number(data.salarySectionFirstRows) || 5);
        const secondRows = Math.max(1, Number(data.salarySectionSecondRows) || 3);
        const groups = [
            { label: '后厨', start: 0, end: firstRows - 1 },
            { label: '起台', start: firstRows, end: firstRows + secondRows - 1 }
        ];
        const buildGroupRow = (group) => {
            let firstHalf = 0;
            let secondHalf = 0;
            let hasAmount = false;
            for (let i = group.start; i <= group.end; i++) {
                const cashRow = sanitizeSalaryRow(data.salaryRows[i] || ['', '', '']);
                const checkRow = packedSalaryRows[i] || ['', '', ''];
                firstHalf += salaryCombinedAmount(cashRow, checkRow, 1);
                secondHalf += salaryCombinedAmount(cashRow, checkRow, 2);
                const c1 = salaryCombinedAmount(cashRow, checkRow, 1);
                const c2 = salaryCombinedAmount(cashRow, checkRow, 2);
                if (c1 !== 0 || c2 !== 0) hasAmount = true;
            }
            return hasAmount
                ? `<tr class="footer-row sub-totals"><td class="f-col-1">${group.label} :</td><td class="f-col-2">${formatCategoryDisplay(firstHalf) || '&nbsp;'}</td><td class="f-col-3">${formatCategoryDisplay(secondHalf) || '&nbsp;'}</td><td class="f-col-4">${formatCategoryDisplay(firstHalf + secondHalf) || '&nbsp;'}</td></tr>`
                : '';
        };
        const groupRows = [buildGroupRow(groups[1]), buildGroupRow(groups[0])].filter(Boolean);
        salaryGroupSummary.innerHTML = groupRows.join('');
        const summaryTable = salaryGroupSummary.closest('.salary-group-summary-table');
        if (summaryTable) summaryTable.classList.toggle('has-rows', groupRows.length > 0);
        requestAnimationFrame(alignSalaryCellsWithHeaders);
    }

    data.salaryCheckRows = packedSalaryRows;
    if (shouldPersist) saveToStorage();
};

const updateExpenseTotals = (shouldPersist = true) => {
    const data = monthData[currentMonth];
    let col1Sum = 0;
    let col2Sum = 0;
    const salaryRowsSnapshot = [];
    const layoutInfo = ensureSalaryLayout(data);
    let sourceFirstRows = Math.max(1, Number(data.salarySectionFirstRows) || 5);
    let sourceSecondRows = Math.max(1, Number(data.salarySectionSecondRows) || 3);
    const renderedRows = Array.from(document.querySelectorAll('#salaryTableBody tr'));
    if (renderedRows.length === layoutInfo.totalRows) {
        const breaks = [];
        for (let i = 0; i < renderedRows.length; i++) {
            if (renderedRows[i].classList.contains('salary-group-break')) breaks.push(i);
        }
        if (breaks.length >= 2) {
            sourceFirstRows = breaks[0] + 1;
            sourceSecondRows = breaks[1] - breaks[0];
        }
    }
    for (let i = 0; i < layoutInfo.totalRows; i++) {
        const row = [];
        document.querySelectorAll(`#salaryTableBody .editable-cell[data-type="salary"][data-row="${i}"]`).forEach(el => {
            row.push(el.textContent);
        });
        const normalizedRow = sanitizeSalaryRow(row);
        salaryRowsSnapshot.push(normalizedRow);
    }

    const liveLayout = computeSalaryLayoutFromRows(salaryRowsSnapshot, sourceFirstRows, sourceSecondRows);

    const packedSalaryRows = normalizeSalaryRowsBySections(
        salaryRowsSnapshot,
        sourceFirstRows,
        sourceSecondRows,
        liveLayout.firstRows,
        liveLayout.secondRows,
        liveLayout.totalRows
    );
    data.salarySectionFirstRows = liveLayout.firstRows;
    data.salarySectionSecondRows = liveLayout.secondRows;
    for (let i = 0; i < packedSalaryRows.length; i++) {
        col1Sum += parseVal(packedSalaryRows[i][1]);
        col2Sum += parseVal(packedSalaryRows[i][2]);
    }

    const salaryTotal = document.getElementById('salaryTotalValue');
    const salaryFirstTotal = document.getElementById('salaryFirstTotalValue');
    const salarySecondTotal = document.getElementById('salarySecondTotalValue');
    const hasAnySalaryAmount = packedSalaryRows.some((row) => !isBlankLedgerValue(row[1]) || !isBlankLedgerValue(row[2]));
    if (salaryTotal) salaryTotal.textContent = hasAnySalaryAmount ? formatCategoryDisplay(col1Sum + col2Sum) : '';
    if (salaryFirstTotal) salaryFirstTotal.textContent = hasAnySalaryAmount ? formatCategoryDisplay(col1Sum) : '';
    if (salarySecondTotal) salarySecondTotal.textContent = hasAnySalaryAmount ? formatCategoryDisplay(col2Sum) : '';

    const salaryGroupSummary = document.getElementById('salaryGroupSummary');
    if (salaryGroupSummary) {
        const firstRows = Math.max(1, Number(data.salarySectionFirstRows) || 5);
        const secondRows = Math.max(1, Number(data.salarySectionSecondRows) || 3);
        const groups = [
            { label: '后厨', start: 0, end: firstRows - 1 },
            { label: '起台', start: firstRows, end: firstRows + secondRows - 1 }
        ];
        const buildGroupRow = (group) => {
            let firstHalf = 0;
            let secondHalf = 0;
            let hasAmount = false;
            for (let i = group.start; i <= group.end; i++) {
                const row = salaryRowsSnapshot[i] || ['', '', ''];
                const rowPacked = packedSalaryRows[i] || row;
                firstHalf += parseVal(rowPacked[1]);
                secondHalf += parseVal(rowPacked[2]);
                const v1 = String(rowPacked[1] || '').replace(/\u00a0/g, '').trim();
                const v2 = String(rowPacked[2] || '').replace(/\u00a0/g, '').trim();
                if (v1 !== '' || v2 !== '') hasAmount = true;
            }
            return hasAmount
                ? `<tr class="footer-row sub-totals"><td class="f-col-1">${group.label} :</td><td class="f-col-2">${formatCategoryDisplay(firstHalf) || '&nbsp;'}</td><td class="f-col-3">${formatCategoryDisplay(secondHalf) || '&nbsp;'}</td><td class="f-col-4">${formatCategoryDisplay(firstHalf + secondHalf) || '&nbsp;'}</td></tr>`
                : '';
        };
        // owe 行：欠款 = 应发 − 实发（仅统计记录了实发的行），位于后厨和起台两行上面
        let oweSum1 = 0;
        let oweSum2 = 0;
        const oweData = Array.isArray(data.salaryOwe) ? data.salaryOwe : [];
        for (let i = 0; i < Math.min(salaryRowsSnapshot.length, oweData.length); i++) {
            const ow = oweData[i] || [];
            [1, 2].forEach((col) => {
                const paidText = normalizeEditableCellText(ow[col - 1]);
                if (paidText === '') return;
                const owe = parseVal((salaryRowsSnapshot[i] || [])[col]) - parseVal(paidText);
                if (owe > 0) {
                    if (col === 1) oweSum1 += owe;
                    else oweSum2 += owe;
                }
            });
        }
        const hasOwe = oweSum1 !== 0 || oweSum2 !== 0;
        const oweRow = hasOwe
            ? `<tr class="footer-row sub-totals owe-sub-total"><td class="f-col-1">owe :</td><td class="f-col-2">${formatCategoryDisplay(oweSum1) || '&nbsp;'}</td><td class="f-col-3">${formatCategoryDisplay(oweSum2) || '&nbsp;'}</td></tr>`
            : '';
        const groupRows = [oweRow, buildGroupRow(groups[1]), buildGroupRow(groups[0])].filter(Boolean);
        salaryGroupSummary.innerHTML = groupRows.join('');
        const summaryTable = salaryGroupSummary.closest('.salary-group-summary-table');
        if (summaryTable) summaryTable.classList.toggle('has-rows', groupRows.length > 0);
        requestAnimationFrame(alignSalaryCellsWithHeaders);
    }

    let costInSum = 0;
    let costOutSum = 0;
    let costSum = 0;
    const hasCostInAmount = Array.from(document.querySelectorAll('#costListIn .editable-cell[data-type="costVal"]')).some((el) => {
        const text = normalizeEditableCellText(el.textContent);
        return text !== '' && text !== '-';
    });
    const hasCostOutAmount = Array.from(document.querySelectorAll('#costListOut .editable-cell[data-type="costVal"]')).some((el) => {
        const text = normalizeEditableCellText(el.textContent);
        return text !== '' && text !== '-';
    });
    document.querySelectorAll('.editable-cell[data-type="costVal"]').forEach(el => {
        const value = parseVal(el.textContent);
        costSum += value;
        if (value < 0) costOutSum += value;
        else costInSum += value;
    });
    const hasAnyCostOthersAmount = Array.from(document.querySelectorAll('#costListOthers .editable-cell[data-type="othersVal"]')).some((el) => {
        const text = normalizeEditableCellText(el.textContent);
        return text !== '' && text !== '-';
    });
    let costOthersOutSum = 0;
    document.querySelectorAll('#costListOthers .editable-cell[data-type="othersVal"]').forEach(el => {
        const raw = normalizeEditableCellText(el.textContent);
        if (raw === '' || raw === '-') return;
        const value = parseVal(raw);
        costOthersOutSum -= Math.abs(value);
    });
    costOutSum += costOthersOutSum;
    costSum += costOthersOutSum;
    const costInEl = document.getElementById('costInValue');
    if (costInEl) costInEl.textContent = hasCostInAmount ? formatCategoryDisplay(costInSum) : '';
    const costOutEl = document.getElementById('costOutValue');
    if (costOutEl) costOutEl.textContent = (hasCostOutAmount || hasAnyCostOthersAmount) ? formatCategoryDisplay(costOutSum) : '';
    const costTotalEl = document.getElementById('costTotalValue');
    if (costTotalEl) costTotalEl.textContent = (hasCostInAmount || hasCostOutAmount || hasAnyCostOthersAmount) ? formatCategoryDisplay(costSum) : '';

    let othersSum = 0;
    document.querySelectorAll('#othersLayer .expense-list .editable-cell[data-type="othersVal"]').forEach(el => {
        othersSum += parseVal(el.textContent);
    });
    const othersTotalEl = document.getElementById('othersTotalValue');
    if (othersTotalEl) othersTotalEl.textContent = formatCategoryDisplay(othersSum);

    // 更新数据源 (数据回填的核心逻辑)
    data.salaryRows = packedSalaryRows;

    data.costExpenses = [];
    document.querySelectorAll('#costListIn li, #costListOut li').forEach((li) => {
        const nameEl = li.querySelector('.editable-cell[data-type="costName"]');
        const valEl = li.querySelector('.editable-cell[data-type="costVal"]');
        const name = nameEl ? nameEl.textContent : '';
        const raw = normalizeEditableCellText(valEl ? valEl.textContent : '');
        const negative = li.closest('#costListOut') !== null;
        const rawTrim = raw.replace(/,/g, '').trim();
        let parsed = raw;
        if (rawTrim !== '' && /^-?\d+(?:\.\d+)?$/.test(rawTrim)) {
            parsed = formatDisplayNumber(negative ? -Math.abs(parseFloat(rawTrim)) : Math.abs(parseFloat(rawTrim)));
        } else if (negative) {
            parsed = rawTrim === '' ? '-' : (rawTrim.startsWith('-') ? rawTrim : '-' + rawTrim);
        }
        data.costExpenses.push([name, parsed]);
    });
    data.costExpenses = data.costExpenses.map((row) => normalizeExpenseEntryRow(row)).filter((row) => rowHasExpenseEntryData(row));
    const hasAnyCostAmount = data.costExpenses.some(([, val]) => {
        const text = String(val == null ? '' : val).replace(/\u00a0/g, ' ').trim();
        return text !== '' && text !== '-';
    });
    data.costTotal = (hasAnyCostAmount || hasAnyCostOthersAmount) ? costSum : '';
    data.salesBreakdown = data.salesBreakdown || { Check: 0, cash: 0, cost: 0, uber: 0, riceball: 0, panda: 0, bm: 0 };
    data.salesBreakdown.cost = (hasAnyCostAmount || hasAnyCostOthersAmount) ? costSum : '';

    const collectExpenseRows = (selector) => {
        const rows = [];
        document.querySelectorAll(selector).forEach((li) => {
            const nameEl = li.querySelector('.editable-cell[data-type="othersName"]');
            const valEl = li.querySelector('.editable-cell[data-type="othersVal"]');
            const name = nameEl ? nameEl.textContent : '';
            const raw = normalizeEditableCellText(valEl ? valEl.textContent : '');
            const rawTrim = raw.replace(/,/g, '').trim();
            let parsed = raw;
            if (rawTrim !== '' && /^-?\d+(?:\.\d+)?$/.test(rawTrim)) {
                parsed = formatDisplayNumber(parseFloat(rawTrim));
            }
            rows.push([name, parsed]);
        });
        return rows;
    };

    data.othersExpenses = collectExpenseRows('#othersLayer .expense-list li')
        .map((row) => normalizeExpenseEntryRow(row))
        .filter((row) => rowHasExpenseEntryData(row));
    const hasAnyOthersAmount = data.othersExpenses.some(([, val]) => {
        const text = String(val == null ? '' : val).replace(/\u00a0/g, ' ').trim();
        return text !== '' && text !== '-';
    });
    data.othersTotal = hasAnyOthersAmount ? othersSum : '';

    data.costOthersExpenses = collectExpenseRows('#costListOthers li')
        .map((row) => normalizeExpenseEntryRow(row))
        .filter((row) => rowHasExpenseEntryData(row));

    refreshCostGroupHeaders(data);

    // 更新首页总数
    data.expense = hasAnySalaryAmount ? (col1Sum + col2Sum) : '';
    // 利润 = 销售额 - 总收支 - 总成本 + 其他
    data.profit = data.sales - data.expense - data.costTotal + (Number(data.othersTotal) || 0);

    const setHomeText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setHomeText('overviewcostValue', formatCategoryDisplay(data.costTotal));
    setHomeText('overviewothersValue', formatCategoryDisplay(data.othersTotal));
    setHomeText('overviewOtherGroupTotalValue', formatCategoryDisplay(data.othersTotal));
    const balanceTotal = (Number(data.costTotal) || 0) + (Number(data.othersTotal) || 0);
    setHomeText('overviewBalanceTotalValue', formatCategoryDisplay(balanceTotal));
    setHomeText('overviewExpenseTotalValue', formatCategoryDisplay((Number(data.expense) || 0) + (Number(data.costTotal) || 0)));
    setHomeText('expenseValue', formatCategoryDisplay(data.expense));
    const profitEl = document.getElementById('profitValue');
    profitEl.textContent = formatProfitDisplay(data.profit);
    profitEl.classList.toggle('profit-positive', Number(data.profit) > 0);
    profitEl.classList.toggle('profit-negative', Number(data.profit) < 0);
    if (shouldPersist) {
        saveToStorage();     // 持久化保存
    }
};

function panelSyncCostRowIndexes() {
        let displayIndex = 0;
    document.querySelectorAll('#costLayer .expense-list li').forEach((li) => {
            const idxEl = li.querySelector('.others-idx');
            const nameEl = li.querySelector('.others-name');
            const valEl = li.querySelector('.others-val');
            if (!idxEl) return;
            const nameText = (nameEl?.textContent || '').replace(/\u00a0/g, '').trim();
            const valText = (valEl?.textContent || '').replace(/\u00a0/g, '').trim();
            if (nameText || valText) {
                displayIndex += 1;
                idxEl.textContent = `${displayIndex}.`;
            } else {
                idxEl.textContent = '';
            }
        });
};

const setupExcelInteraction = (containerSelector) => {
    const handleSave = (cell) => {
        tryResolveCellExpression(cell);
        cell.contentEditable = 'false';
        cell.classList.remove('editing');
        window.getSelection().removeAllRanges();
        if (isReadonlyMode()) return;
        if (cell.dataset.type === 'salary-check') {
            updateSalaryCheckTotals(true);
            panelRefreshSalaryCheck(monthData[currentMonth] || {});
            setupExcelInteraction('#expenseLayer');
            return;
        }
        updateExpenseTotals();
        if (cell.dataset.type === 'salary') {
            renderMonthState();
            return;
        }
        if (containerSelector === '#costLayer') {
            const li = cell.closest('li');
            if (li && li.dataset.editWasEmpty === 'true') {
                const nameEl = li.querySelector('.editable-cell.others-name');
                const valEl = li.querySelector('.editable-cell.others-val');
                const hasContent = normalizeEditableCellText(nameEl ? nameEl.textContent : '') !== '' || normalizeEditableCellText(valEl ? valEl.textContent : '') !== '';
                if (hasContent) {
                    renderMonthState();
                } else {
                    panelSyncCostRowIndexes();
                }
            } else {
                panelSyncCostRowIndexes();
            }
            return;
        }
        if (containerSelector === '#othersLayer') {
            panelRefreshOthers(monthData[currentMonth]);
            return;
        }
    };

    if (containerSelector === '#costLayer') {
        document.querySelectorAll('#costLayer .expense-list').forEach((costList) => {
            if (costList.dataset.rowClickBound) return;
            costList.dataset.rowClickBound = '1';
            costList.addEventListener('click', (e) => {
                if (isReadonlyMode()) return;
                if (e.target.closest('.editable-cell')) return;
                const li = e.target.closest('li');
                if (!li) return;
                const cell = li.querySelector('.editable-cell.others-name');
                if (cell && !cell.classList.contains('editing')) cell.click();
            });
        });
    }

    if (containerSelector === '#othersLayer') {
        document.querySelectorAll('#othersLayer .expense-list').forEach((list) => {
            if (list.dataset.rowClickBound) return;
            list.dataset.rowClickBound = '1';
            list.addEventListener('click', (e) => {
                if (isReadonlyMode()) return;
                if (e.target.closest('.editable-cell')) return;
                const li = e.target.closest('li');
                if (!li) return;
                const cell = li.querySelector('.editable-cell.others-name');
                if (cell && !cell.classList.contains('editing')) cell.click();
            });
        });
    }

    document.querySelectorAll(`${containerSelector} .editable-cell`).forEach(cell => {
        if (cell.dataset.excelBound) return;
        cell.dataset.excelBound = '1';
        cell.addEventListener('click', function () {
            if (isReadonlyMode()) return;
            if (this.classList.contains('editing')) return;
            if (containerSelector === '#costLayer') {
                const li = this.closest('li');
                if (li) {
                    const siblingType = this.dataset.type === 'costName' ? 'costVal' : 'costName';
                    const sibling = li.querySelector(`.editable-cell[data-type="${siblingType}"]`);
                    const myText = normalizeEditableCellText(this.textContent);
                    const sibText = normalizeEditableCellText(sibling ? sibling.textContent : '');
                    li.dataset.editWasEmpty = (!myText && !sibText) ? 'true' : 'false';
                }
            }
            this.contentEditable = 'true';
            this.classList.add('editing');
            this.focus();

            const range = document.createRange();
            range.selectNodeContents(this);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        cell.addEventListener('blur', function () {
            if (this.classList.contains('editing')) handleSave(this);
        });

        cell.addEventListener('input', function () {
            if (isReadonlyMode()) return;
            if (this.classList.contains('editing')) {
                if (this.dataset.type === 'salary-check') {
                    updateSalaryCheckTotals(false);
                } else {
                    updateExpenseTotals(false);
                }
                if (containerSelector === '#costLayer') panelSyncCostRowIndexes();
                if (containerSelector === '#othersLayer') panelSyncOthersRowIndexes();
            }
        });

        cell.addEventListener('keydown', function (e) {
            if (isReadonlyMode()) {
                e.preventDefault();
                this.blur();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSave(this);
            } else if (e.key === 'Tab') {
                e.preventDefault();
                handleSave(this);

                const col = this.dataset.col;
                const row = parseInt(this.dataset.row, 10);
                const type = this.dataset.type;
                const list = this.closest('.expense-list');
                const siblingRoot = list || document.querySelector(containerSelector) || document;
                const sibling = siblingRoot.querySelector(`.editable-cell[data-type="${type}"][data-col="${col}"][data-row="${row + 1}"]`);
                if (sibling) sibling.click();
            }
        });
    });
};


function syncSalaryRowHeights() {
    if (window.matchMedia('(max-width: 768px)').matches) return;
    const tbody = document.getElementById('salaryTableBody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach((tr) => {
        tr.style.height = '';
    });
}

function scheduleSalaryRowHeightSync() {
    if (window.matchMedia('(max-width: 768px)').matches) return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            syncSalaryRowHeights();
        });
    });
}

function panelRefreshSalary(data) {
    ensureSalaryCheckRows(data);
    const salaryLayout = ensureSalaryLayout(data);
    const salaryBody = document.getElementById('salaryTableBody');
    if (!salaryBody) return;
    salaryBody.innerHTML = '';
    const hasAnyCheck = (data.salaryCheckRows || []).some((r) => {
        const c = sanitizeSalaryRow(r || ['', '', '']);
        return !isBlankLedgerValue(c[1]) || !isBlankLedgerValue(c[2]);
    });
    const combinedHead = document.getElementById('salaryCombinedHead');
    if (combinedHead) combinedHead.hidden = !hasAnyCheck;
    for (let i = 0; i < salaryLayout.totalRows; i++) {
        const rawRow = data.salaryRows[i] || ['', '', ''];
        const row = sanitizeSalaryRow(rawRow);
        data.salaryRows[i] = row;
        const checkRow = sanitizeSalaryRow((data.salaryCheckRows || [])[i] || ['', '', '']);
        const tr = document.createElement('tr');
        if (i === salaryLayout.firstRows - 1 || i === salaryLayout.firstRows + salaryLayout.secondRows - 1) {
            tr.classList.add('salary-group-break');
        }
        row.forEach((cell, colIdx) => {
            const td = document.createElement('td');
            if (colIdx === 1 || colIdx === 2) {
                const built = buildCashPageAmountCellHtml(i, colIdx, cell, checkRow[colIdx]);
                applySalaryAmountTdClasses(td, built.tdClass);
                td.innerHTML = built.html;
            } else {
                const displayCell = isBlankLedgerValue(cell) ? '&nbsp;' : cell;
                td.innerHTML = `<span class="editable-cell" data-type="salary" data-row="${i}" data-col="${colIdx}">${displayCell}</span>`;
            }
            tr.appendChild(td);
        });
        const rowTotalTd = document.createElement('td');
        const rowTotal = parseVal(row[1]) + parseVal(row[2]);
        const rowHasExplicitAmount = !isBlankLedgerValue(row[1]) || !isBlankLedgerValue(row[2]);
        rowTotalTd.innerHTML = `<span class="static-cell">${rowHasExplicitAmount ? (formatCategoryDisplay(rowTotal) || '&nbsp;') : '&nbsp;'}</span>`;
        if (hasAnyCheck) {
            const combined = salaryCombinedAmount(row, checkRow, 1) + salaryCombinedAmount(row, checkRow, 2);
            if (combined !== 0) {
                rowTotalTd.insertAdjacentHTML('beforeend', `<span class="salary-row-combined">${formatCategoryDisplay(combined)}</span>`);
            }
        }
        tr.appendChild(rowTotalTd);
        // 实发欠款：工资页=应发，备注页=实发，欠款 = 应发 − 实发（未记录实发 → 不欠款）
        const oweRow = Array.isArray(data.salaryOwe) ? (data.salaryOwe[i] || null) : null;
        if (oweRow) {
            [1, 2].forEach((col) => {
                const paidText = normalizeEditableCellText(oweRow[col - 1]);
                if (paidText === '') return; // 未记录实发 → 默认不欠款
                const owe = parseVal(row[col]) - parseVal(paidText);
                if (owe > 0) {
                    const td = tr.children[col];
                    if (td) {
                        const badge = document.createElement('span');
                        badge.className = 'owe-badge';
                        badge.textContent = 'owe ' + formatCategoryDisplay(owe);
                        td.appendChild(badge);
                    }
                }
            });
        }
        salaryBody.appendChild(tr);
    }

    scheduleSalaryRowHeightSync();
    alignSalaryCellsWithHeaders();
    scheduleSalaryDualPosition();
}

function panelRefreshSalaryCheck(data) {
    const salaryLayout = ensureSalaryCheckRows(data);
    const salaryBody = document.getElementById('salaryTableBodyFull');
    if (!salaryBody) return;
    salaryBody.innerHTML = '';
    for (let i = 0; i < salaryLayout.totalRows; i++) {
        const cashRow = sanitizeSalaryRow(data.salaryRows[i] || ['', '', '']);
        const checkRow = sanitizeSalaryRow(data.salaryCheckRows[i] || ['', '', '']);
        data.salaryCheckRows[i] = ['', checkRow[1], checkRow[2]];
        const tr = document.createElement('tr');
        if (i === salaryLayout.firstRows - 1 || i === salaryLayout.firstRows + salaryLayout.secondRows - 1) {
            tr.classList.add('salary-group-break');
        }
        const nameTd = document.createElement('td');
        const nameText = String(cashRow[0] || '').trim();
        nameTd.innerHTML = `<span class="static-cell">${nameText ? escapeHtml(nameText) : '&nbsp;'}</span>`;
        tr.appendChild(nameTd);

        [1, 2].forEach((colIdx) => {
            const td = document.createElement('td');
            const built = buildCheckPageAmountCellHtml(i, colIdx, cashRow[colIdx], checkRow[colIdx]);
            applySalaryAmountTdClasses(td, built.tdClass);
            td.innerHTML = built.html;
            tr.appendChild(td);
        });

        const rowTotalTd = document.createElement('td');
        const rowTotal = salaryCombinedAmount(cashRow, checkRow, 1) + salaryCombinedAmount(cashRow, checkRow, 2);
        const rowHasAmount = rowTotal !== 0;
        rowTotalTd.innerHTML = `<span class="static-cell">${rowHasAmount ? (formatCategoryDisplay(rowTotal) || '&nbsp;') : '&nbsp;'}</span>`;
        tr.appendChild(rowTotalTd);
        salaryBody.appendChild(tr);
    }
    updateSalaryCheckTotals(false);
    scheduleSalaryRowHeightSync();
    alignSalaryCellsWithHeaders();
    scheduleSalaryDualPosition();
}


    //#endregion 

    //#region 工资 · 备注页

const oweModeBtn = document.getElementById('oweModeBtn');
const salaryPayModeBtn = document.getElementById('salaryPayModeBtn');
const oweView = document.getElementById('oweView');

function applySalaryPayPanelView(isCashView) {
    const wrap = document.querySelector('#expenseLayer .expense-wrap');
    const cashCard = wrap ? wrap.querySelector('.salary-page-cash') : null;
    const fullCard = wrap ? wrap.querySelector('.salary-page-full') : null;
    if (wrap) {
        wrap.classList.toggle('salary-pay-view-cash', isCashView);
        wrap.classList.toggle('salary-pay-view-full', !isCashView);
    }
    if (cashCard) cashCard.hidden = !isCashView;
    if (fullCard) fullCard.hidden = isCashView;
    scheduleSalaryDualPosition();
}

function resetSalaryPayModeBtn() {
    if (!salaryPayModeBtn) return;
    salaryPayModeBtn.textContent = 'cash';
    salaryPayModeBtn.classList.remove('is-check');
    salaryPayModeBtn.classList.add('is-cash');
    salaryPayModeBtn.setAttribute('aria-pressed', 'false');
    applySalaryPayPanelView(true);
}

const expenseLayerEl = document.getElementById('expenseLayer');
if (expenseLayerEl) {
    expenseLayerEl.addEventListener('click', (e) => {
        if (e.target.closest('.editable-cell')) return;
        const td = e.target.closest('td.salary-dual-cell');
        if (!td) return;
        const cell = td.querySelector('.editable-cell');
        if (cell && !cell.classList.contains('editing')) cell.click();
    });
}

if (salaryPayModeBtn) {
    salaryPayModeBtn.addEventListener('click', () => {
        const isCash = salaryPayModeBtn.classList.contains('is-cash');
        if (isCash) {
            updateExpenseTotals(true);
            salaryPayModeBtn.textContent = '支票';
            salaryPayModeBtn.classList.remove('is-cash');
            salaryPayModeBtn.classList.add('is-check');
            salaryPayModeBtn.setAttribute('aria-pressed', 'true');
            applySalaryPayPanelView(false);
            panelRefreshSalaryCheck(monthData[currentMonth] || {});
            setupExcelInteraction('#expenseLayer');
        } else {
            updateSalaryCheckTotals(true);
            salaryPayModeBtn.textContent = 'cash';
            salaryPayModeBtn.classList.remove('is-check');
            salaryPayModeBtn.classList.add('is-cash');
            salaryPayModeBtn.setAttribute('aria-pressed', 'false');
            applySalaryPayPanelView(true);
            panelRefreshSalary(monthData[currentMonth] || {});
            setupExcelInteraction('#expenseLayer');
        }
    });
}

// 进入欠款页：隐藏工资表，显示同款模板，仅列已有员工名。
function showOweView() {
    if (!oweView) return;
    renderOweTable();
    resetOweTotals();
    const data = monthData[currentMonth] || {};
    if (oweNoteInput) oweNoteInput.value = data.salaryOweNote || '';
    requestAnimationFrame(alignSalaryCellsWithHeaders);
    const wrap = oweView.closest('.expense-wrap');
    if (wrap) wrap.classList.add('owe-mode');
    oweView.hidden = false;
}

// 备注页 Total = 备注页自己填的数字合计（ΣFirst + ΣSecond），随输入实时更新。
function resetOweTotals() {
    const f = document.getElementById('oweFirstTotalValue');
    const s = document.getElementById('oweSecondTotalValue');
    const t = document.getElementById('oweTotalValue');
    if (f) f.textContent = '';
    if (s) s.textContent = '';
    if (t) t.textContent = '';
}

function recomputeOweTotals() {
    const f = document.getElementById('oweFirstTotalValue');
    const s = document.getElementById('oweSecondTotalValue');
    const t = document.getElementById('oweTotalValue');
    if (!f || !s || !t) return;
    let sum1 = 0;
    let sum2 = 0;
    document.querySelectorAll('#oweTableBody [data-owe="1"]').forEach((c) => { sum1 += parseVal(c.textContent); });
    document.querySelectorAll('#oweTableBody [data-owe="2"]').forEach((c) => { sum2 += parseVal(c.textContent); });
    const has = sum1 !== 0 || sum2 !== 0;
    f.textContent = has ? formatCategoryDisplay(sum1) : '';
    s.textContent = has ? formatCategoryDisplay(sum2) : '';
    t.textContent = has ? formatCategoryDisplay(sum1 + sum2) : '';
}

function hideOweView() {
    if (!oweView) return;
    oweView.hidden = true;
    const wrap = oweView.closest('.expense-wrap');
    if (wrap) wrap.classList.remove('owe-mode');
    renderMonthState();
}

// 渲染欠款模板行：只取已保存员工名字，金额格可点编辑（预览）。
function renderOweTable() {
    const body = document.getElementById('oweTableBody');
    if (!body) return;
    const data = monthData[currentMonth] || {};
    const oweData = Array.isArray(data.salaryOwe) ? data.salaryOwe : [];
    const rows = (Array.isArray(data.salaryRows) ? data.salaryRows : [])
        .map((r, i) => ({ idx: i, name: String(sanitizeSalaryRow(r)[0] || '').replace(/\u00a0/g, ' ').trim() }))
        .filter((o) => o.name !== '')
        .map((o) => ({ idx: o.idx, name: escapeHtml(o.name) }));
    body.innerHTML = rows.map((o, idx) => {
        const saved = oweData[o.idx] || [];
        const v1 = normalizeEditableCellText(saved[0]);
        const v2 = normalizeEditableCellText(saved[1]);
        const status = normalizeEditableCellText(saved[2]);
        const cell4 = status
            ? `<span class="owe-status" data-owe="note">${escapeHtml(status)}</span>`
            : `<button type="button" class="owe-status-clean" data-owe="clean">Clean</button>`;
        return `
        <tr data-salary-idx="${o.idx}">
            <td><span class="owe-name">${o.name}</span></td>
            <td><span class="editable-cell" data-owe="1">${v1 || '&nbsp;'}</span></td>
            <td><span class="editable-cell" data-owe="2">${v2 || '&nbsp;'}</span></td>
            <td>${cell4}</td>
        </tr>`;
    }).join('');
    // Clean 按钮：弹出确认框；移除 = 删除此行记录；已结 = 删除记录并在备注上方写入已结记录
    body.querySelectorAll('[data-owe="clean"]').forEach((btn) => {
        if (btn.dataset.oweBound) return;
        btn.dataset.oweBound = '1';
        btn.addEventListener('click', function () {
            oweCleanTargetRow = this.closest('tr');
            showOweCleanConfirm();
        });
    });
    body.querySelectorAll('.editable-cell').forEach((cell) => {
        if (cell.dataset.oweBound) return;
        cell.dataset.oweBound = '1';
        cell.addEventListener('click', function () {
            if (this.classList.contains('editing')) return;
            this.contentEditable = 'true';
            this.classList.add('editing');
            this.focus();
            const range = document.createRange();
            range.selectNodeContents(this);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        cell.addEventListener('blur', function () {
            this.contentEditable = 'false';
            this.classList.remove('editing');
            if (this.textContent.trim() === '') this.innerHTML = '&nbsp;';
            recomputeOweTotals();
            saveOweData();
        });
        cell.addEventListener('input', function () {
            if (this.classList.contains('editing')) recomputeOweTotals();
        });
        cell.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.blur();
            }
        });
    });
}

// Clean 确认框：移除 / 已结
const oweCleanConfirmLayer = document.getElementById('oweCleanConfirmLayer');
const oweCleanRemoveBtn = document.getElementById('oweCleanRemoveBtn');
const oweCleanSettleBtn = document.getElementById('oweCleanSettleBtn');
let oweCleanTargetRow = null;

function showOweCleanConfirm() {
    if (oweCleanConfirmLayer) oweCleanConfirmLayer.classList.add('active');
}

function hideOweCleanConfirm() {
    if (oweCleanConfirmLayer) oweCleanConfirmLayer.classList.remove('active');
    oweCleanTargetRow = null;
}

// 清空一行的欠款数字（记录删除后工资页不再显示 owe）
function clearOweRow(tr) {
    if (!tr) return;
    tr.querySelectorAll('[data-owe="1"], [data-owe="2"]').forEach((cell) => {
        cell.textContent = '';
        cell.innerHTML = '&nbsp;';
    });
}

if (oweCleanRemoveBtn) {
    oweCleanRemoveBtn.addEventListener('click', () => {
        if (oweCleanTargetRow) {
            clearOweRow(oweCleanTargetRow);
            recomputeOweTotals();
            saveOweData();
        }
        hideOweCleanConfirm();
        showGlobalSaveToast('已完成', 100002, 2000);
    });
}

if (oweCleanSettleBtn) {
    oweCleanSettleBtn.addEventListener('click', () => {
        const tr = oweCleanTargetRow;
        if (tr) {
            const now = new Date();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const mi = String(now.getMinutes()).padStart(2, '0');
            const time = `${mm}/${dd} ${hh}:${mi}`;
            const nameEl = tr.querySelector('.owe-name');
            const name = nameEl ? nameEl.textContent : '';
            const lines = [];
            const data = monthData[currentMonth] || {};
            const salaryIdx = Number(tr.dataset.salaryIdx);
            const salaryRow = (Number.isInteger(salaryIdx) && Array.isArray(data.salaryRows) && data.salaryRows[salaryIdx]) || ['', '', ''];
            [['前半月', 1], ['下半月', 2]].forEach((pair) => {
                const cell = tr.querySelector(`[data-owe="${pair[1]}"]`);
                const paidText = normalizeEditableCellText(cell ? cell.textContent : '');
                if (paidText === '') return;
                const owe = parseVal(salaryRow[pair[1]]) - parseVal(paidText);
                if (owe > 0) lines.push(`${name} ${pair[0]} owe${formatCategoryDisplay(owe)} 已结 ${time}`);
            });
            if (oweNoteInput && lines.length) {
                const prefix = lines.join('\n');
                oweNoteInput.value = oweNoteInput.value ? prefix + '\n' + oweNoteInput.value : prefix;
            }
            clearOweRow(tr);
            recomputeOweTotals();
            saveOweData();
        }
        hideOweCleanConfirm();
        showGlobalSaveToast('已完成', 100002, 2000);
    });
}

// 保存欠款数据（数字 + 状态 + 备注输入框），与收支输入一致：失焦/回车自动保存。
function saveOweData() {
    const data = monthData[currentMonth] || {};
    const list = document.getElementById('oweTableBody');
    const count = Array.isArray(data.salaryRows) ? data.salaryRows.length : 0;
    const owe = [];
    for (let i = 0; i < count; i++) owe.push(['', '', '']);
    if (list) {
        list.querySelectorAll('tr').forEach((tr) => {
            const idx = Number(tr.dataset.salaryIdx);
            if (!Number.isInteger(idx) || idx < 0 || idx >= count) return;
            const c1 = tr.querySelector('[data-owe="1"]');
            const c2 = tr.querySelector('[data-owe="2"]');
            const note = tr.querySelector('[data-owe="note"]');
            owe[idx] = [
                normalizeEditableCellText(c1 ? c1.textContent : ''),
                normalizeEditableCellText(c2 ? c2.textContent : ''),
                normalizeEditableCellText(note ? note.textContent : ''),
            ];
        });
    }
    data.salaryOwe = owe;
    if (oweNoteInput) data.salaryOweNote = oweNoteInput.value;
    saveToStorage();
}

if (oweModeBtn) oweModeBtn.addEventListener('click', () => {
    if (oweView && !oweView.hidden) hideOweView();
    else showOweView();
});

// 备注区：点击聚焦大输入框；打开面板时清空残留
const oweNoteArea = document.getElementById('oweNoteArea');
const oweNoteInput = document.getElementById('oweNoteInput');
if (oweNoteArea && oweNoteInput) {
    oweNoteArea.addEventListener('click', () => {
        oweNoteInput.focus();
    });
    // 回车 = 保存（与其余输入一致）；Shift+回车 = 换行
    oweNoteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            saveOweData();
        }
    });
    oweNoteInput.addEventListener('blur', () => {
        saveOweData();
    });
}
function resetOweNoteArea() {
    if (oweNoteInput) oweNoteInput.value = '';
}

    //#endregion


// 移动端：让工资表每一列的数值与顶部表头文字左对齐。
function alignSalaryCellsWithHeaders() {
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    const tables = document.querySelectorAll('#expenseLayer .salary-table');
    if (!tables.length) return;
    tables.forEach((table) => {
        const headRow = table.querySelector('thead tr');
        if (!headRow) return;
        for (let col = 1; col <= 3; col++) {
            const th = headRow.children[col];
            if (!th) continue;
            const thLeft = th.getBoundingClientRect().left;
            if (!th.offsetWidth) continue;
            const range = document.createRange();
            range.selectNodeContents(th);
            let padLeft = Math.round(Math.max(0, range.getBoundingClientRect().left - thLeft));
            if (col === 1) padLeft = 25;
            if (col === 2) padLeft = 33;
            if (col === 3) padLeft = 33;
            table.querySelectorAll(`tbody tr td:nth-child(${col + 1}) .editable-cell, tbody tr td:nth-child(${col + 1}) .static-cell`).forEach((cell) => {
                const td = cell.closest('td');
                if (cell.classList.contains('salary-dual-right')) {
                    return;
                }
                cell.style.paddingLeft = padLeft ? `${padLeft}px` : '';
            });
            table.querySelectorAll(`tbody tr td:nth-child(${col + 1}) .owe-badge`).forEach((badge) => {
                badge.style.paddingLeft = padLeft ? `${padLeft}px` : '';
                badge.style.textAlign = padLeft ? 'left' : 'center';
            });
        }
    });
}

//#endregion

//#region 收支面板

function resolveCostBlockState(headerId, blockId) {
    const header = document.getElementById(headerId);
    const block = document.getElementById(blockId);
    if (!block) return;
    const hidden = block.dataset.forceHidden === '1' || block.dataset.collapsed === '1';
    block.hidden = hidden;
    if (header) header.setAttribute('aria-expanded', String(!hidden));
}

function resetCostPanelState() {
    ['costWdBlock', 'costDepBlock', 'costOthersBlock'].forEach((blockId) => {
        const block = document.getElementById(blockId);
        if (block) block.dataset.collapsed = '1';
    });
}

function refreshCostGroupHeaders(data) {
    const wdRows = trimTrailingEmptyRows(data.costExpenses, normalizeExpenseEntryRow, rowHasExpenseEntryData).filter((r) => isOthersOutRow(r));
    const depRows = trimTrailingEmptyRows(data.costExpenses, normalizeExpenseEntryRow, rowHasExpenseEntryData).filter((r) => !isOthersOutRow(r));
    const othersRows = trimTrailingEmptyRows(data.costOthersExpenses, normalizeExpenseEntryRow, rowHasExpenseEntryData);
    const fmtCount = (n) => `(${n})`;
    const fmtTotal = (n) => '$' + (formatCategoryDisplay(n) || '0');
    const setCostHeader = (countId, totalId, rows, isNeg) => {
        const countEl = document.getElementById(countId);
        const totalEl = document.getElementById(totalId);
        const populated = rows.filter((r) => rowHasExpenseEntryData(r));
        if (countEl) countEl.textContent = fmtCount(populated.length);
        if (totalEl) {
            const sum = populated.reduce((s, r) => { const n = parseFloat(String(r[1]).replace(/[$,\s]/g, '')); return s + (isFinite(n) ? (isNeg ? -Math.abs(n) : Math.abs(n)) : 0); }, 0);
            totalEl.textContent = populated.length > 0 ? fmtTotal(sum) : '';
        }
    };
    setCostHeader('costWdCount', 'costWdTotal', wdRows, true);
    setCostHeader('costDepCount', 'costDepTotal', depRows, false);
    setCostHeader('costOthersCount', 'costOthersTotal', othersRows, false);
}

function panelRefreshCost(data) {
    const listIn = document.getElementById('costListIn');
    const listOut = document.getElementById('costListOut');
    if (listIn && listOut) {
        const usedRows = trimTrailingEmptyRows(data.costExpenses, normalizeExpenseEntryRow, rowHasExpenseEntryData);
        const inRows = usedRows.filter((row) => !isOthersOutRow(row));
        const outRows = usedRows.filter((row) => isOthersOutRow(row));
        const renderRows = (list, rows, negative) => {
            const total = rows.length + 2;
            while (list.children.length < total) {
                const li = document.createElement('li');
                if (negative) li.classList.add('expense-entry-negative');
                li.innerHTML = `<span class="others-idx"></span>
                                <span class="editable-cell others-name" data-type="costName" data-col="0">&nbsp;</span>
                                <span class="editable-cell others-val" data-type="costVal" data-col="1">&nbsp;</span>`;
                list.appendChild(li);
            }
            while (list.children.length > total) list.removeChild(list.lastChild);
            for (let i = 0; i < total; i++) {
                const row = normalizeExpenseEntryRow(rows[i]);
                const li = list.children[i];
                const nameCell = li.querySelector('.editable-cell[data-type="costName"]');
                const valCell = li.querySelector('.editable-cell[data-type="costVal"]');
                nameCell.dataset.row = String(i);
                valCell.dataset.row = String(i);
                nameCell.textContent = hideDateYear(row[0]) || '\u00a0';
                const rawVal = row[1];
                const blankVal = isBlankLedgerValue(rawVal) || String(rawVal).replace(/\u00a0/g, ' ').trim() === '-';
                valCell.textContent = blankVal ? '\u00a0' : (formatNonCashTextDisplay(rawVal) || '\u00a0');
            }
        };
        renderRows(listIn, inRows, false);
        renderRows(listOut, outRows, true);
    }

    const costOthersList = document.getElementById('costListOthers');
    if (costOthersList) {
        const usedCostOthers = trimTrailingEmptyRows(data.costOthersExpenses, normalizeExpenseEntryRow, rowHasExpenseEntryData);
        const total = usedCostOthers.length + 2;
        while (costOthersList.children.length < total) {
            const li = document.createElement('li');
            li.innerHTML = `<span class="others-idx"></span>
                                <span class="editable-cell others-name" data-type="othersName" data-col="0">&nbsp;</span>
                                <span class="editable-cell others-val" data-type="othersVal" data-col="1">&nbsp;</span>`;
            costOthersList.appendChild(li);
        }
        while (costOthersList.children.length > total) costOthersList.removeChild(costOthersList.lastChild);
        for (let i = 0; i < total; i++) {
            const row = normalizeExpenseEntryRow(usedCostOthers[i]);
            const li = costOthersList.children[i];
            const nameCell = li.querySelector('.editable-cell[data-type="othersName"]');
            const valCell = li.querySelector('.editable-cell[data-type="othersVal"]');
            nameCell.dataset.row = String(i);
            valCell.dataset.row = String(i);
            nameCell.textContent = hideDateYear(row[0]) || '\u00a0';
            const rawVal = row[1];
            const blankVal = isBlankLedgerValue(rawVal) || String(rawVal).replace(/\u00a0/g, ' ').trim() === '-';
            valCell.textContent = blankVal ? '\u00a0' : (formatNonCashTextDisplay(rawVal) || '\u00a0');
            li.classList.toggle('expense-entry-negative', !blankVal && isOthersOutRow(row));
        }
    }

    refreshCostGroupHeaders(data);

    const wireToggle = (headerId, blockId) => {
        const header = document.getElementById(headerId);
        if (header && !header.dataset.bound) {
            header.dataset.bound = '1';
            header.addEventListener('click', () => {
                const block = document.getElementById(blockId);
                if (block) {
                    if (block.dataset.forceHidden === '1') return;
                    block.dataset.collapsed = block.hidden ? '' : '1';
                    resolveCostBlockState(headerId, blockId);
                }
            });
        }
    };
    wireToggle('costWdHeader', 'costWdBlock');
    wireToggle('costDepHeader', 'costDepBlock');
    wireToggle('costOthersHeader', 'costOthersBlock');

    resolveCostBlockState('costWdHeader', 'costWdBlock');
    resolveCostBlockState('costDepHeader', 'costDepBlock');
    resolveCostBlockState('costOthersHeader', 'costOthersBlock');

    setupExcelInteraction('#expenseLayer');
    setupExcelInteraction('#costLayer');
    setupExcelInteraction('#othersLayer');
}

//#endregion

//#region 其他面板

function panelSyncOthersRowIndexes() {

    document.querySelectorAll('#othersLayer .expense-list').forEach((list) => {
        let displayIndex = 0;
        list.querySelectorAll('li').forEach((li) => {
            const idxEl = li.querySelector('.others-idx');
            const nameEl = li.querySelector('.others-name');
            const valEl = li.querySelector('.others-val');
            if (!idxEl) return;
            const nameText = (nameEl?.textContent || '').replace(/\u00a0/g, '').trim();
            const valText = (valEl?.textContent || '').replace(/\u00a0/g, '').trim();
            if (nameText || valText) {
                displayIndex += 1;
                idxEl.textContent = `${displayIndex}.`;
            } else {
                idxEl.textContent = '';
            }
        });
    });

}

const OTHERS_FIXED_ROWS = document.querySelectorAll('#othersList > li').length || 13;

const isOthersOutRow = (row) => {
    const val = String((Array.isArray(row) && row[1]) || '').replace(/\u00a0/g, ' ').trim();
    if (val === '') return false;
    if (val === '-') return true;
    const clean = val.replace(/,/g, '');
    if (/^-?\d+(?:\.\d+)?$/.test(clean)) return parseFloat(clean) < 0;
    return val.startsWith('-');
};

function fillOthersBlankRows() {
    const list = document.getElementById('othersList');
    if (!list) return false;
    const first = list.querySelector('li');
    if (!first) return false;
    const rowH = first.offsetHeight || 44;
    const card = list.closest('.expense-card');
    const footer = card ? card.querySelector('.card-footer') : null;
    const avail = card
        ? (card.clientHeight - (footer ? footer.offsetHeight : 0) - 16 - 7)
        : list.clientHeight;
    const rowsNeeded = Math.max(OTHERS_FIXED_ROWS, Math.ceil(avail / rowH));
    while (list.children.length < rowsNeeded) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="others-idx"></span>
                                <span class="editable-cell others-name" data-type="othersName" data-col="0">&nbsp;</span>
                                <span class="editable-cell others-val" data-type="othersVal" data-col="1">&nbsp;</span>`;
        list.appendChild(li);
    }
    while (list.children.length > rowsNeeded) {
        const lastLi = list.children[list.children.length - 1];
        const hasContent = [...lastLi.querySelectorAll('.editable-cell')].some((c) => normalizeEditableCellText(c.textContent) !== '');
        if (hasContent) break;
        list.removeChild(lastLi);
    }
    return true;
}

function panelRefreshOthers(data) {
    const othersList = document.getElementById('othersList');
    if (!othersList) return;
    const usedRows = trimTrailingEmptyRows(data.othersExpenses, normalizeExpenseEntryRow, rowHasExpenseEntryData);
    const total = Math.max(OTHERS_FIXED_ROWS, usedRows.length + 1);
    while (othersList.children.length < total) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="others-idx"></span>
                                <span class="editable-cell others-name" data-type="othersName" data-col="0">&nbsp;</span>
                                <span class="editable-cell others-val" data-type="othersVal" data-col="1">&nbsp;</span>`;
        othersList.appendChild(li);
    }
    while (othersList.children.length > total) othersList.removeChild(othersList.lastChild);
    for (let i = 0; i < total; i++) {
        const row = normalizeExpenseEntryRow(usedRows[i]);
        const li = othersList.children[i];
        const nameCell = li.querySelector('.editable-cell[data-type="othersName"]');
        const valCell = li.querySelector('.editable-cell[data-type="othersVal"]');
        nameCell.dataset.row = String(i);
        valCell.dataset.row = String(i);
        nameCell.textContent = hideDateYear(row[0]) || '\u00a0';
        const rawVal = row[1];
        const blankVal = isBlankLedgerValue(rawVal) || String(rawVal).replace(/\u00a0/g, ' ').trim() === '-';
        valCell.textContent = blankVal ? '\u00a0' : (formatNonCashTextDisplay(rawVal) || '\u00a0');
        li.classList.toggle('expense-entry-negative', !blankVal && isOthersOutRow(row));
    }

    setupExcelInteraction('#expenseLayer');
    setupExcelInteraction('#costLayer');
    setupExcelInteraction('#othersLayer');
    updateExpenseTotals(false);
    panelSyncCostRowIndexes();
    panelSyncOthersRowIndexes();

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (fillOthersBlankRows()) setupExcelInteraction('#othersLayer');
        });
    });
}

//#endregion

//#region 支票面板

const checksMonthStore = new Map();
const checksTextStore = new Map();

function getChecksForMonth(monthIndex = currentMonth, year = currentYear) {
    const key = `${year}-${monthIndex}`;
    return checksMonthStore.get(key) || [];
}

function setChecksForMonth(monthIndex, items, year = currentYear) {
    const key = `${year}-${monthIndex}`;
    const normalized = Array.isArray(items) ? items.slice() : [];
    checksMonthStore.set(key, normalized);
    if (Number(year) === Number(currentYear)) {
        const mi = Number(monthIndex);
        if (Array.isArray(monthData) && mi >= 0 && mi < monthData.length) {
            monthData[mi].checks = normalized.slice();
        }
    }
    if (Number(monthIndex) === Number(currentMonth) && Number(year) === Number(currentYear)) {
        panelRefreshChecks();
    }
}

function addCheckForMonth(monthIndex, item, year = currentYear) {
    const list = getChecksForMonth(monthIndex, year).slice();
    list.push(item);
    setChecksForMonth(monthIndex, list, year);
}

function getChecksTextForMonth(monthIndex = currentMonth, year = currentYear) {
    const key = `${year}-${monthIndex}`;
    return checksTextStore.get(key) || [];
}

function setChecksTextForMonth(monthIndex, items, year = currentYear) {
    const key = `${year}-${monthIndex}`;
    const normalized = Array.isArray(items) ? items.slice() : [];
    checksTextStore.set(key, normalized);
    if (Number(year) === Number(currentYear)) {
        const mi = Number(monthIndex);
        if (Array.isArray(monthData) && mi >= 0 && mi < monthData.length) {
            monthData[mi].checkTexts = normalized.slice();
        }
    }
    if (Number(monthIndex) === Number(currentMonth) && Number(year) === Number(currentYear)) {
        panelRefreshChecks();
    }
}

function removeCheckForMonth(monthIndex, indexOrId, year = currentYear) {
    const list = getChecksForMonth(monthIndex, year).slice();
    if (typeof indexOrId === 'number') {
        list.splice(indexOrId, 1);
    } else {
        const idx = list.findIndex((c) => (c && c.id === indexOrId));
        if (idx !== -1) list.splice(idx, 1);
    }
    setChecksForMonth(monthIndex, list, year);
}

window.checksManager = {
    getChecks: getChecksForMonth,
    setChecks: setChecksForMonth,
    addCheck: addCheckForMonth,
    removeCheck: removeCheckForMonth,
    getChecksText: getChecksTextForMonth,
    setChecksText: setChecksTextForMonth,
    refresh: () => panelRefreshChecks()
};

function resolveCheckBlockState(headerId, blockId) {
    const header = document.getElementById(headerId);
    const block = document.getElementById(blockId);
    if (!block) return;
    const hidden = block.dataset.forceHidden === '1' || block.dataset.collapsed === '1';
    block.hidden = hidden;
    if (header) header.setAttribute('aria-expanded', String(!hidden));
}

function panelRefreshChecks(monthIndex = currentMonth) {
    const grid = document.getElementById('checksGrid');
    const empty = document.getElementById('checksEmpty');
    const countEl = document.getElementById('checksHeaderCount');
    if (!grid) return;

    const list = getChecksForMonth(monthIndex, currentYear);
    const count = list.length;

    const chkLayer = document.getElementById('checksLayer');
    if (chkLayer) chkLayer.classList.toggle('checks-empty-active', count === 0);

    const overviewCountEl = document.getElementById('overviewChecksValue');
    if (overviewCountEl) overviewCountEl.textContent = count > 0 ? `${count}张` : '';

    const textEl = document.getElementById('checksTextList');
    if (textEl) {
        const texts = getChecksTextForMonth(monthIndex, currentYear);
        textEl.innerHTML = '';
        if (texts.length) {
            texts.forEach((row) => {
                const isArr = Array.isArray(row);
                const label = isArr ? String(row[0] || '') : String(row || '');
                const amount = isArr && row[1] != null ? String(row[1]) : '';
                const txtRow = document.createElement('div');
                txtRow.className = 'checks-text-row';
                const labelEl = document.createElement('span');
                labelEl.className = 'checks-text-label';
                labelEl.textContent = hideDateYear(label);
                txtRow.appendChild(labelEl);
                if (amount) {
                    const amtEl = document.createElement('span');
                    amtEl.className = 'checks-text-amount';
                    amtEl.textContent = amount.startsWith('$') ? amount : `$${amount}`;
                    txtRow.appendChild(amtEl);
                }
                textEl.appendChild(txtRow);
            });
        }
        const textBlockEl = document.getElementById('checksTextBlock');
        if (textBlockEl) {
            textBlockEl.dataset.forceHidden = texts.length === 0 ? '1' : '';
            resolveCheckBlockState('checksTextHeader', 'checksTextBlock');
        }
    }

    const totalEl = document.getElementById('checksTextTotalValue');
    const headerTotalEl = document.getElementById('checksTextHeaderTotal');
    if (totalEl || headerTotalEl) {
        const textsForTotal = getChecksTextForMonth(monthIndex, currentYear);
        let sum = 0;
        textsForTotal.forEach((row) => {
            const rawAmt = String(Array.isArray(row) && row[1] != null ? row[1] : '').replace(/[$,\s]/g, '');
            const n = parseFloat(rawAmt);
            if (Number.isFinite(n)) sum += n;
        });
        const fmtTotal = (n) => '$' + (formatCategoryDisplay(n) || '0');
        if (totalEl) totalEl.textContent = fmtTotal(sum);
        if (headerTotalEl) headerTotalEl.textContent = 'Total:' + fmtTotal(sum);
    }

    const textHeader = document.getElementById('checksTextHeader');
    if (textHeader && !textHeader.dataset.bound) {
        textHeader.dataset.bound = '1';
        textHeader.addEventListener('click', () => {
            const textBlock = document.getElementById('checksTextBlock');
            if (textBlock) {
                if (textBlock.dataset.forceHidden === '1') return;
                textBlock.dataset.collapsed = textBlock.hidden ? '' : '1';
                resolveCheckBlockState('checksTextHeader', 'checksTextBlock');
            }
        });
    }

    const gridHeader = document.getElementById('checksGridHeader');
    if (gridHeader && !gridHeader.dataset.bound) {
        gridHeader.dataset.bound = '1';
        gridHeader.addEventListener('click', () => {
            const gridBlock = document.getElementById('checksGridBlock');
            if (gridBlock) {
                if (gridBlock.dataset.forceHidden === '1') return;
                gridBlock.dataset.collapsed = gridBlock.hidden ? '' : '1';
                resolveCheckBlockState('checksGridHeader', 'checksGridBlock');
            }
        });
    }

    if (countEl) {
        countEl.innerHTML = count > 0 ? `(${count})<span class="checks-count-zh">张</span>` : '';
    }

    const gridBlockEl = document.getElementById('checksGridBlock');
    if (gridBlockEl) {
        gridBlockEl.dataset.forceHidden = count === 0 ? '1' : '';
        resolveCheckBlockState('checksGridHeader', 'checksGridBlock');
    }

    if (count === 0) {
        grid.innerHTML = '';
        if (empty) empty.hidden = false;
        return;
    }

    if (empty) empty.hidden = true;
    grid.innerHTML = '';

    const texts = getChecksTextForMonth(monthIndex, currentYear);

    list.forEach((item, idx) => {
        const isObj = item && typeof item === 'object';
        const url = isObj ? (item.url || item.src || '') : String(item || '');
        const name = isObj ? (item.name || item.title || `支票 ${idx + 1}`) : `支票 ${idx + 1}`;

        const textRaw = texts[idx];
        const textIsArr = Array.isArray(textRaw);
        const label = textIsArr ? String(textRaw[0] || '') : String(textRaw || '');
        const amount = (textIsArr && textRaw[1] != null ? String(textRaw[1]) : '') || (isObj && item.amount != null ? String(item.amount) : '');
        const displayAmount = amount.startsWith('$') ? amount : `$${amount}`;

        const card = document.createElement('div');
        card.className = 'check-card';
        card.dataset.index = String(idx);

        const imgWrap = document.createElement('div');
        imgWrap.className = 'check-card-img-wrap';
        const img = document.createElement('img');
        img.className = 'check-card-img';
        img.src = url;
        img.alt = name;
        img.loading = 'lazy';
        imgWrap.appendChild(img);

        const info = document.createElement('div');
        info.className = 'check-card-info';
        const titleEl = document.createElement('div');
        titleEl.className = 'check-card-title';
        titleEl.textContent = label || name;
        info.appendChild(titleEl);

        if (amount) {
            const amtEl = document.createElement('span');
            amtEl.className = 'check-card-amount';
            amtEl.textContent = displayAmount;
            info.appendChild(amtEl);
        }

        card.appendChild(imgWrap);
        card.appendChild(info);

        card.addEventListener('click', () => {
            openCheckPreview(url, label || name, displayAmount);
        });

        grid.appendChild(card);
    });
}

function openCheckPreview(url, title, amount) {
    const overlay = document.getElementById('checksPreviewOverlay');
    const img = document.getElementById('checksPreviewImg');
    const titleEl = document.getElementById('checksPreviewTitle');
    if (!overlay || !img) return;
    img.src = url;
    const text = `${title || ''}${amount ? `\u00A0\u00A0\u00A0\u00A0${amount}` : ''}`;
    if (titleEl) titleEl.textContent = text || '';
    overlay.classList.remove('hidden');
}

function closeCheckPreview() {
    const overlay = document.getElementById('checksPreviewOverlay');
    const img = document.getElementById('checksPreviewImg');
    if (!overlay) return;
    overlay.classList.add('hidden');
    if (img) img.src = '';
}

(function initCheckPreviewEvents() {
    const overlay = document.getElementById('checksPreviewOverlay');
    const closeBtn = document.getElementById('checksPreviewClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeCheckPreview();
        });
    }
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeCheckPreview();
        });
    }
})();

//#endregion

//#region Panel-Z

let panelZReadonlyMode = false;

function setPanelZReadonlyMode(on) {
    panelZReadonlyMode = !!on;
    if (!panelZLayer) return;
    const panel = panelZLayer.querySelector('.panel-z');
    if (panel) panel.classList.toggle('readonly', panelZReadonlyMode);
}

// 以只读模式打开 Panel-Z 面板。
function openReadonlyPanelZ() {
    setPanelZReadonlyMode(true);
    openOverlay('panelZLayer');
}

// 以可编辑模式打开 Panel-Z 面板。
function openEditablePanelZ() {
    qzOpenSavedView = false;
    setPanelZReadonlyMode(false);
    openOverlay('panelZLayer');
}

var qzData = [];
var qzLoaded = false;
var qzPendingSave = false;
var qzSelectedDate = '';
var qzViewMonth = 0;
var qzPanelYear = currentYear;
var qzPanelViewData = [];
var qzYearDataCache = {};
var qzPanelAddMode = false;
var qzPanelDraft = null;
var qzLastSavedYear = Number(currentYear);
var qzLastSavedMonth = 0;
var qzOpenSavedView = false;

// 返回 Panel-Z 当前查看月份，0 表示全部月份。
function qzGetViewMonth() {
    return Number.isInteger(qzViewMonth) && qzViewMonth >= 0 && qzViewMonth <= 12 ? qzViewMonth : 0;
}

// 返回 Panel-Z 当前查看年份，0 表示所有年份。
function qzGetPanelYear() {
    var value = Number(qzPanelYear);
    if (value === 0) return 0;
    return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : Number(currentYear);
}

// Panel-Z 切换月份（支持跨年）。
function qzShiftPanelMonth(delta) {
    var cur = qzGetViewMonth();
    var panelYr = qzGetPanelYear();
    if (panelYr === 0) return;
    if (cur === 0) {
        cur = delta < 0 ? 12 : 1;
    } else {
        cur += delta;
        if (cur < 1) {
            if (panelYr > 1) {
                qzViewMonth = 12;
                qzLoadPanelYear(panelYr - 1);
            }
            return;
        }
        if (cur > 12) {
            if (panelYr < 9999) {
                qzViewMonth = 1;
                qzLoadPanelYear(panelYr + 1);
            }
            return;
        }
    }
    qzViewMonth = cur;
    qzSyncMonthSelect();
    qzRenderPanel();
}

// 返回 Panel-Z 当前应该显示的记录集。
function qzGetPanelRecords() {
    if (qzGetPanelYear() === 0) return [];
    return qzGetPanelYear() === Number(currentYear) ? qzData : qzPanelViewData;
}

// 返回 Panel-Z 当前年份对应的可编辑数据数组引用。
function qzGetEditableDataRef() {
    var py = qzGetPanelYear();
    if (py === 0 || py === Number(currentYear)) return qzData;
    return qzPanelViewData;
}

// 保存指定年份的 Panel-Z 数据到后端并同步缓存。
async function qzSaveYearData(targetYear, data) {
    try {
        var json = await fetchJsonSafe(LEDGER_API_BASE + '/ledger/z/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: targetYear, data: data })
        });
        if (json && json.ok && Array.isArray(json.data)) {
            var normalized = qzNormalizeRecords(json.data);
            if (targetYear === Number(currentYear)) {
                qzData = normalized;
            } else {
                qzPanelViewData = normalized;
            }
            qzYearDataCache[targetYear] = normalized.slice();
        }
        return json;
    } catch (_) {
        return { ok: false };
    }
}

// 返回 Panel-Z 可选年份列表。
function qzGetAvailablePanelYears() {
    var years = Array.isArray(ledgerYears) ? ledgerYears.slice() : [];
    years.push(Number(currentYear));
    years.push(Number(qzPanelYear));
    years.push(Number(qzLastSavedYear));
    return Array.from(new Set(years.map(Number).filter(function (year) {
        return Number.isInteger(year) && year >= 1 && year <= 9999;
    }))).sort(function (a, b) { return b - a; });
}

// 规范化月份按钮显示标签。
function qzFormatMonthPickerLabel(monthValue) {
    var monthNum = Number(monthValue);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) return 'ALL';
    return monthLabels[monthNum - 1] || 'ALL';
}

// 规范化年份按钮显示标签。
function qzFormatYearPickerLabel(yearValue) {
    var yearNum = Number(yearValue);
    return yearNum === 0 ? 'ALL' : String(yearNum);
}

// 生成自定义下拉菜单。
function qzBuildPickerMenu(menuId, options, activeValue) {
    var menu = document.getElementById(menuId);
    if (!menu) return;
    var current = String(activeValue);
    menu.innerHTML = options.map(function (item) {
        var valueText = String(item.value);
        var activeClass = valueText === current ? ' active' : '';
        return '<button type="button" class="pz-picker-option' + activeClass + '" data-value="' + escapeHtml(valueText) + '">' + escapeHtml(item.label) + '</button>';
    }).join('');
}

// 关闭 Panel-Z 所有自定义下拉菜单。
function qzClosePickerMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('#pzBottomControls .pz-picker'), function (picker) {
        picker.classList.remove('open');
        var btn = picker.querySelector('.pz-picker-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    });
}

// 刷新 Panel-Z 年/月按钮与显示状态。
function qzSyncPickerButtons() {
    var yearBtn = document.getElementById('pzYearSelectBtn');
    var monthBtn = document.getElementById('pzMonthSelectBtn');
    var controls = document.getElementById('pzBottomControls');
    var yearValue = qzGetPanelYear();
    if (yearBtn) yearBtn.textContent = qzFormatYearPickerLabel(yearValue);
    if (monthBtn) monthBtn.textContent = qzFormatMonthPickerLabel(qzGetViewMonth());
    if (controls) controls.classList.toggle('year-all-mode', yearValue === 0);
}

// 将 Panel-Z 查看月份重置为主界面当前月份。
function qzResetViewMonth() {
    qzViewMonth = Number.isInteger(currentMonth) && currentMonth >= 0 && currentMonth <= 11 ? (currentMonth + 1) : 0;
    var select = document.getElementById('pzMonthSelect');
    if (select) select.value = String(qzGetViewMonth());
}

// 将 Panel-Z 查看年份重置为当前年份。
function qzResetPanelYear() {
    qzPanelYear = Number(currentYear);
    qzPanelViewData = [];
    var select = document.getElementById('pzYearSelect');
    if (select) select.value = String(qzGetPanelYear());
}

// 刷新 Panel-Z 月份下拉框选项。
function qzSyncMonthSelect() {
    var select = document.getElementById('pzMonthSelect');
    if (!select) return;
    select.innerHTML = '<option value="0">ALL</option>' + monthLabels.map(function (label, index) {
        return '<option value="' + (index + 1) + '">' + label + '</option>';
    }).join('');
    select.value = String(qzGetViewMonth());
    qzBuildPickerMenu('pzMonthSelectMenu', [{ value: 0, label: 'ALL' }].concat(monthLabels.map(function (label, index) {
        return { value: index + 1, label: label };
    })), qzGetViewMonth());
    qzSyncPickerButtons();
}

// 同步 Panel-Z 年份下拉框选项和当前值。
function qzSyncYearSelect() {
    var select = document.getElementById('pzYearSelect');
    if (!select) return;
    var years = qzGetAvailablePanelYears();
    select.innerHTML = '<option value="0">ALL</option>' + years.map(function (year) {
        return '<option value="' + year + '">' + year + '</option>';
    }).join('');
    select.value = String(qzGetPanelYear());
    qzBuildPickerMenu('pzYearSelectMenu', [{ value: 0, label: 'ALL' }].concat(years.map(function (year) {
        return { value: year, label: String(year) };
    })), qzGetPanelYear());
    qzSyncPickerButtons();
}

// 读取指定年份的 Panel-Z 数据并更新缓存。
function qzLoadYearRecords(year, forceRefresh) {
    var targetYear = Number(year);
    if (!Number.isInteger(targetYear) || targetYear < 1 || targetYear > 9999) return Promise.resolve([]);
    if (targetYear === Number(currentYear)) {
        qzYearDataCache[targetYear] = qzData.slice();
        return Promise.resolve(qzData.slice());
    }
    if (!forceRefresh && Array.isArray(qzYearDataCache[targetYear])) {
        return Promise.resolve(qzYearDataCache[targetYear].slice());
    }
    return fetchJsonSafe(LEDGER_API_BASE + '/ledger/z/load?year=' + encodeURIComponent(targetYear)).then(function (json) {
        var rows = json && json.ok && Array.isArray(json.data) ? qzNormalizeRecords(json.data) : [];
        qzYearDataCache[targetYear] = rows.slice();
        return rows.slice();
    }).catch(function (_) {
        qzYearDataCache[targetYear] = [];
        return [];
    });
}

// 读取全部年份的 Panel-Z 数据。
function qzLoadAllPanelYears() {
    var years = qzGetAvailablePanelYears();
    return Promise.all(years.map(function (year) {
        return qzLoadYearRecords(year).then(function (records) {
            return { year: year, records: records };
        });
    }));
}

// 按指定年份加载 Panel-Z 查看数据；当前年使用内存数据，ALL 为跨年汇总视图。
function qzLoadPanelYear(year) {
    var targetYear = Number(year);
    if (!Number.isInteger(targetYear) || targetYear < 0 || targetYear > 9999) return;
    qzPanelAddMode = false;
    qzPanelDraft = null;
    qzPanelYear = targetYear;
    qzSyncYearSelect();
    qzSyncMonthSelect();
    if (targetYear === 0) {
        qzViewMonth = 0;
        qzSyncMonthSelect();
        qzLoadAllPanelYears().then(function () {
            qzRenderPanel();
        }).catch(function () {
            qzRenderPanel();
        });
        return;
    }
    if (targetYear === Number(currentYear)) {
        qzPanelViewData = [];
        qzYearDataCache[targetYear] = qzData.slice();
        qzRenderPanel();
        return;
    }
    qzLoadYearRecords(targetYear, true).then(function (records) {
        qzPanelViewData = records.slice();
        qzRenderPanel();
    }).catch(function () {
        qzPanelViewData = [];
        qzRenderPanel();
    });
}

// 解析 quick-Z / panel-z 使用的日期文本，支持 m/d、m/d/yyyy 和 yyyy/m/d。
function qzParseDateValue(raw, fallbackYear) {
    var text = String(raw || '').trim();
    var baseYear = Number(fallbackYear);
    if (!Number.isInteger(baseYear) || baseYear < 1 || baseYear > 9999) baseYear = Number(currentYear) || (new Date().getFullYear());
    var yearFirst = text.match(/^(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})$/);
    var match = yearFirst || text.match(/^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/);
    if (!match) return null;
    var month;
    var day;
    var year;
    if (yearFirst) {
        year = parseInt(match[1], 10);
        month = parseInt(match[2], 10);
        day = parseInt(match[3], 10);
    } else {
        month = parseInt(match[1], 10);
        day = parseInt(match[2], 10);
        year = match[3] ? parseInt(match[3], 10) : baseYear;
        if (match[3] && match[3].length === 2) year += 2000;
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
    var lastDay = new Date(year, month, 0).getDate();
    if (!Number.isInteger(day) || day < 1 || day > lastDay) return null;
    return {
        month: month,
        day: day,
        year: year,
        display: month + '/' + day + '/' + year
    };
}

// quick-Z 日期输入位显示成 年/月/日。
function qzFormatEditorDate(value, fallbackYear) {
    var parsed = qzParseDateValue(value, fallbackYear);
    if (!parsed) return String(value || '').trim();
    return parsed.year + '/' + parsed.month + '/' + parsed.day;
}

// panel-z 新增行日期：手输年份时保留年月日，否则只保留月/日。
function qzFormatPanelDraftDate(value, fallbackYear) {
    var text = String(value || '').trim();
    var parsed = qzParseDateValue(text, fallbackYear);
    if (!parsed) return text;
    var hasExplicitYear = /^\d{4}\s*\/\s*\d{1,2}\s*\/\s*\d{1,2}$/.test(text)
        || /^\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}$/.test(text);
    return hasExplicitYear
        ? (parsed.year + '/' + parsed.month + '/' + parsed.day)
        : (parsed.month + '/' + parsed.day);
}

// 创建 panel-z 底部新增记录草稿。
function qzCreatePanelDraft() {
    var today = qzGetActualToday();
    var parsedToday = qzParseDateValue(today, qzGetPanelYear());
    return {
        date: parsedToday ? (parsedToday.month + '/' + parsedToday.day) : qzFormatPanelDraftDate(today, qzGetPanelYear()),
        beef: '',
        lamb: '',
        chicken: '',
        wing: ''
    };
}

// 同步 panel-z 新增行日期输入框宽度。
function qzSyncAddDateInputWidth(inputEl) {
    if (!inputEl) return;
    var text = String(inputEl.value || '').trim();
    var sample = text || '0/0';
    var ref = document.querySelector('#pzTableBody .pz-editable.pz-edit-date.pz-date-trigger');
    var probe = qzSyncAddDateInputWidth._probe;
    if (!probe) {
        probe = document.createElement('span');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        probe.style.whiteSpace = 'pre';
        probe.style.left = '-9999px';
        probe.style.top = '-9999px';
        qzSyncAddDateInputWidth._probe = probe;
        document.body.appendChild(probe);
    }
    if (ref) {
        var refStyle = window.getComputedStyle(ref);
        probe.style.font = refStyle.font;
        probe.style.fontSize = refStyle.fontSize;
        probe.style.fontWeight = refStyle.fontWeight;
        probe.style.letterSpacing = refStyle.letterSpacing;
    } else {
        var inputStyle = window.getComputedStyle(inputEl);
        probe.style.font = inputStyle.font;
        probe.style.fontSize = inputStyle.fontSize;
        probe.style.fontWeight = inputStyle.fontWeight;
        probe.style.letterSpacing = inputStyle.letterSpacing;
    }
    probe.textContent = sample;
    var textWidth = Math.ceil(probe.getBoundingClientRect().width);
    var inputStyle2 = window.getComputedStyle(inputEl);
    var extra = (parseFloat(inputStyle2.paddingLeft) || 0)
        + (parseFloat(inputStyle2.paddingRight) || 0)
        + (parseFloat(inputStyle2.borderLeftWidth) || 0)
        + (parseFloat(inputStyle2.borderRightWidth) || 0);
    inputEl.style.width = Math.max(28, textWidth + extra) + 'px';
}

// 同步 panel-z 新增行数量输入框宽度。
function qzSyncAddQtyInputWidth(inputEl) {
    if (!inputEl) return;
    var text = String(inputEl.value || '').trim();
    var sample = text || '200';
    var ref = document.querySelector('#pzTableBody .pz-editable.pz-edit-qty');
    var probe = qzSyncAddQtyInputWidth._probe;
    if (!probe) {
        probe = document.createElement('span');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        probe.style.whiteSpace = 'pre';
        probe.style.left = '-9999px';
        probe.style.top = '-9999px';
        qzSyncAddQtyInputWidth._probe = probe;
        document.body.appendChild(probe);
    }
    if (ref) {
        var refStyle = window.getComputedStyle(ref);
        probe.style.font = refStyle.font;
        probe.style.fontSize = refStyle.fontSize;
        probe.style.fontWeight = refStyle.fontWeight;
        probe.style.letterSpacing = refStyle.letterSpacing;
    } else {
        var inputStyle = window.getComputedStyle(inputEl);
        probe.style.font = inputStyle.font;
        probe.style.fontSize = inputStyle.fontSize;
        probe.style.fontWeight = inputStyle.fontWeight;
        probe.style.letterSpacing = inputStyle.letterSpacing;
    }
    probe.textContent = sample;
    var textWidth = Math.ceil(probe.getBoundingClientRect().width);
    var inputStyle2 = window.getComputedStyle(inputEl);
    var extra = (parseFloat(inputStyle2.paddingLeft) || 0)
        + (parseFloat(inputStyle2.paddingRight) || 0)
        + (parseFloat(inputStyle2.borderLeftWidth) || 0)
        + (parseFloat(inputStyle2.borderRightWidth) || 0);
    var minPx = Math.ceil(parseFloat(window.getComputedStyle(document.documentElement).fontSize || '16') * 3.4) + extra;
    inputEl.style.width = Math.max(minPx, textWidth + extra) + 'px';
}

// 返回当前 panel-z 新增行是否有输入框拥有焦点。
function qzGetPanelAddActiveInput() {
    var active = document.activeElement;
    return active && active.classList && active.classList.contains('pz-add-input') ? active : null;
}

// 切换 panel-z 底部新增记录模式。
function qzSetPanelAddMode(on) {
    qzPanelAddMode = !!on;
    qzPanelDraft = qzPanelAddMode ? (qzPanelDraft || qzCreatePanelDraft()) : null;
    qzRenderPanel();
}

// 提交 panel-z 新增行单个输入框的值，不退出新增模式。
function qzCommitPanelDraftInput(inputEl) {
    if (!inputEl || !qzPanelDraft) return false;
    var field = String(inputEl.getAttribute('data-pz-add-field') || '');
    if (!field) return false;
    if (field === 'date') {
        var parsedDate = qzParseDateValue(inputEl.value, qzGetPanelYear());
        if (!parsedDate) {
            qzShowToast('日期错误');
            return false;
        }
        qzPanelDraft.date = qzFormatPanelDraftDate(inputEl.value, qzGetPanelYear());
        inputEl.value = qzPanelDraft.date;
        return true;
    }
    var cleaned = String(inputEl.value || '').replace(/[^0-9.]/g, '');
    inputEl.value = cleaned;
    qzPanelDraft[field] = cleaned;
    return true;
}

// 提交 panel-z 新增行全部 5 个输入位。
function qzCommitPanelDraftAll() {
    if (!qzPanelDraft) return false;
    var draftInputs = document.querySelectorAll('#pzTableBody .pz-add-input');
    var ok = true;
    Array.prototype.forEach.call(draftInputs, function (inputEl) {
        if (!qzCommitPanelDraftInput(inputEl)) ok = false;
    });
    return ok;
}

// 保存 panel-z 新增行记录。
async function qzSavePanelDraft() {
    if (!qzPanelDraft) return;
    if (!qzCommitPanelDraftAll()) return;
    var parsedDate = qzParseDateValue(qzPanelDraft.date, qzGetPanelYear());
    if (!parsedDate) {
        qzShowToast('日期错误');
        return;
    }
    var rec = {
        date: parsedDate.display,
        beef: qzPanelDraft.beef ? (parseFloat(qzPanelDraft.beef) || null) : null,
        lamb: qzPanelDraft.lamb ? (parseFloat(qzPanelDraft.lamb) || null) : null,
        chicken: qzPanelDraft.chicken ? (parseFloat(qzPanelDraft.chicken) || null) : null,
        wing: qzPanelDraft.wing ? (parseFloat(qzPanelDraft.wing) || null) : null
    };
    if (!rec.beef && !rec.lamb && !rec.chicken && !rec.wing) {
        qzShowToast('请输入数量');
        return;
    }
    addOperationRecord('保存数据 ' + rec.date + ': ' + formatQzRowSummary(rec));
    qzLastSavedYear = parsedDate.year;
    qzLastSavedMonth = parsedDate.month;
    try {
        if (parsedDate.year === Number(currentYear)) {
            qzData.push(rec);
            qzSaveLocal();
        } else {
            var saved = await qzAppendRecordToYear(parsedDate.year, rec);
            if (!(saved && saved.ok)) {
                qzShowToast('保存失败');
                return;
            }
        }
        qzPanelDraft = null;
        qzPanelAddMode = false;
        if (qzGetPanelYear() === parsedDate.year) {
            qzLoadPanelYear(parsedDate.year);
        } else {
            qzRenderPanel();
        }
    } catch (_) {
        qzShowToast('保存失败');
    }
}

// Panel-Z 表格里只显示月/日，不显示年份。
function qzFormatTableDate(value) {
    var parsed = qzParseDateValue(value, qzGetPanelYear());
    if (!parsed) return String(value || '').trim();
    return parsed.month + '/' + parsed.day;
}

// 按日期对 Panel-Z 记录做升序排列。
function qzSortRecordsAsc(records, fallbackYear) {
    return (Array.isArray(records) ? records.slice() : []).sort(function (a, b) {
        var pa = qzParseDateValue(a && a.date, fallbackYear);
        var pb = qzParseDateValue(b && b.date, fallbackYear);
        if (pa && pb) {
            if (pa.month !== pb.month) return pa.month - pb.month;
            if (pa.day !== pb.day) return pa.day - pb.day;
            return pa.year - pb.year;
        }
        return String((a && a.date) || '').localeCompare(String((b && b.date) || ''));
    });
}

// 汇总一组 Panel-Z 记录。
function qzSummarizeRecords(records) {
    return (Array.isArray(records) ? records : []).reduce(function (acc, rec) {
        acc.beef += Number(rec && rec.beef) || 0;
        acc.lamb += Number(rec && rec.lamb) || 0;
        acc.chicken += Number(rec && rec.chicken) || 0;
        acc.wing += Number(rec && rec.wing) || 0;
        return acc;
    }, { beef: 0, lamb: 0, chicken: 0, wing: 0 });
}

// 将一条 Panel-Z 记录保存到指定年份。
function qzAppendRecordToYear(targetYear, rec) {
    return qzLoadYearRecords(targetYear, true).then(function (records) {
        var yearData = Array.isArray(records) ? records.slice() : [];
        yearData.push(rec);
        qzYearDataCache[targetYear] = yearData.slice();
        return fetchJsonSafe(LEDGER_API_BASE + '/ledger/z/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: targetYear, data: yearData })
        }).then(function (json) {
            if (json && json.ok && Array.isArray(json.data)) {
                qzYearDataCache[targetYear] = qzNormalizeRecords(json.data);
            }
            return json;
        });
    }).catch(function () {
        var yearData = [];
        yearData.push(rec);
        return fetchJsonSafe(LEDGER_API_BASE + '/ledger/z/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: targetYear, data: yearData })
        }).then(function (json) {
            if (json && json.ok && Array.isArray(json.data)) {
                qzYearDataCache[targetYear] = qzNormalizeRecords(json.data);
            }
            return json;
        });
    });
}

// 规范化 Panel-Z 记录结构并过滤无效数据。
function qzNormalizeRecords(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (item) {
        if (!item || typeof item !== 'object') return null;
        var date = String(item.date || '').trim();
        if (!date) return null;
        // 读取单个 Z 记录字段并转换成标准数值。
        function val(key) {
            var n = parseFloat(item[key]);
            return Number.isFinite(n) ? n : null;
        }
        return { date: date, beef: val('beef'), lamb: val('lamb'), chicken: val('chicken'), wing: val('wing') };
    }).filter(Boolean);
}

// 保存 Panel-Z 记录到本地并同步后端。
function qzSaveLocal() {
    if (isReadonlyMode()) return;
    qzYearDataCache[Number(currentYear)] = qzData.slice();
    if (!qzLoaded) {
        qzPendingSave = true;
        return;
    }
    fetchJsonSafe(LEDGER_API_BASE + '/ledger/z/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: currentYear, data: qzData })
    }).then(function (json) {
        if (json && json.ok && Array.isArray(json.data)) {
            qzData = qzNormalizeRecords(json.data);
            qzYearDataCache[Number(currentYear)] = qzData.slice();
            qzRenderPanel();
           
        }
    });
}

// 从后端加载 Panel-Z 数据；请求失败时不再回退旧本地缓存。
function qzLoadFromDb() {
    fetchJsonSafe(LEDGER_API_BASE + '/ledger/z/load?year=' + encodeURIComponent(currentYear)).then(function (json) {
        if (json && json.ok && Array.isArray(json.data)) {
            qzData = qzNormalizeRecords(json.data);
            qzYearDataCache[Number(currentYear)] = qzData.slice();
            qzRenderPanel();
        } else {
            qzData = [];
            qzYearDataCache[Number(currentYear)] = qzData.slice();
            qzRenderPanel();
        }
    }).catch(function (_) {
        qzData = [];
        qzYearDataCache[Number(currentYear)] = qzData.slice();
        qzRenderPanel();
    }).finally(function () {
        qzLoaded = true;
        if (qzPendingSave) {
            qzPendingSave = false;
            qzSaveLocal();
        }
    });
}

// 获取 quick-Z 当前应使用的日期。
function qzGetToday() {
    if (qzSelectedDate) return qzSelectedDate;
    var now = new Date();
    return now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + String(now.getDate()).padStart(2, '0');
}

// 返回系统当前日期，不受 quick-Z 已选日期影响。
function qzGetActualToday() {
    var now = new Date();
    return now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + String(now.getDate()).padStart(2, '0');
}

// 渲染 Panel-Z 列表和总计信息。
function qzRenderPanel() {
    var tbody = document.getElementById('pzTableBody');
    var footerWrap = document.getElementById('pzFooter');
    var titleEl = document.getElementById('panelZTitle');
    var yearEl = document.getElementById('pzTitleYear');
    var secondHeaderEl = document.getElementById('pzSecondHeader');
    var totalEl = document.getElementById('pzGrandTotal');
    var toggleBtn = document.getElementById('pzDateToggleBtn');
    var bottomControlsEl = document.getElementById('pzBottomControls');
    var panelEl = panelZLayer ? panelZLayer.querySelector('.panel-z') : null;
    if (!tbody) return;
    var grandTotal = 0;
    var html = '';
    var panelYear = qzGetPanelYear();
    var isYearAll = panelYear === 0;
    var panelRecords = qzGetPanelRecords();
    var activeMonth = qzGetViewMonth();
    var monthName = activeMonth >= 1 && activeMonth <= 12 ? (monthLabels[activeMonth - 1] || '---') : 'ALL';
    var monthLabel = activeMonth >= 1 && activeMonth <= 12
        ? (monthName.charAt(0) + monthName.slice(1).toLowerCase())
        : 'All';
    var visibleRows = activeMonth >= 1
        ? qzSortRecordsAsc(panelRecords.filter(function (rec) {
            return parseQzRecordMonth(rec.date) === activeMonth;
        }), panelYear)
        : qzSortRecordsAsc(panelRecords, panelYear);
    var isReadonly = isYearAll || !!panelZReadonlyMode || isReadonlyMode();
    if (panelEl) panelEl.classList.toggle('readonly', isReadonly);
    if (bottomControlsEl) bottomControlsEl.style.display = '';

    var cellReadonly = isReadonly;
    var editableAttr = cellReadonly ? 'false' : 'true';
    if (titleEl) titleEl.textContent = isYearAll ? 'ALL' : monthName;
    if (yearEl) yearEl.textContent = isYearAll ? '' : String(panelYear);
    if (secondHeaderEl) secondHeaderEl.textContent = isYearAll ? '年份' : '日期';
    if (toggleBtn) toggleBtn.textContent = isYearAll ? 'All' : (monthLabel + String(panelYear));
    // 把数量和对应金额渲染成组合显示。
    function renderQtyAmount(value, unitPrice) {
        if (value === null || value === undefined) return '-';
        var amount = Math.round(value * unitPrice);
        return '<span class="pz-qty-amt"><span class="pz-qty-amt-main">' + value + '</span><span class="pz-qty-amt-sub">(' + amount + ')</span></span>';
    }
    if (isYearAll) {
        qzGetAvailablePanelYears().forEach(function (year, rowIndex) {
            var yearRecords = year === Number(currentYear) ? qzData : (Array.isArray(qzYearDataCache[year]) ? qzYearDataCache[year] : []);
            var summary = qzSummarizeRecords(yearRecords);
            var t = summary.beef + summary.lamb + summary.chicken + summary.wing * 1.5;
            grandTotal += t;
            html += '<div class="pz-data-row pz-filled-row">';
            html += '<span class="pz-row-index">' + (rowIndex + 1) + '.</span>';
            html += '<span>' + year + '</span>';
            html += '<span>' + renderQtyAmount(summary.beef != null ? summary.beef : null, 1) + '</span>';
            html += '<span>' + renderQtyAmount(summary.lamb != null ? summary.lamb : null, 1) + '</span>';
            html += '<span>' + renderQtyAmount(summary.chicken != null ? summary.chicken : null, 1) + '</span>';
            html += '<span>' + renderQtyAmount(summary.wing != null ? summary.wing : null, 1.5) + '</span>';
            html += '<span>' + Math.round(t) + '</span>';
            html += '</div>';
        });
    } else {
        var panelDataRef = qzGetEditableDataRef();
        visibleRows.forEach(function (rec, rowIndex) {
            var i = panelDataRef.indexOf(rec);
            var t = (rec.beef || 0) + (rec.lamb || 0) + (rec.chicken || 0) + (rec.wing || 0) * 1.5;
            grandTotal += t;
            html += '<div class="pz-data-row pz-filled-row">';
            html += '<span class="pz-row-index" data-qz-index="' + i + '">' + (rowIndex + 1) + '.</span>';
            html += '<span class="pz-editable pz-edit-date pz-date-trigger" contenteditable="false" data-qz-index="' + i + '">' + escapeHtml(qzFormatTableDate(rec.date)) + '</span>';
            html += '<span><span class="pz-qty-amt"><span class="pz-qty-amt-main pz-editable pz-edit-qty" contenteditable="' + editableAttr + '" data-qz-index="' + i + '" data-qz-field="beef">' + (rec.beef != null ? rec.beef : '') + '</span><span class="pz-qty-amt-sub">' + (rec.beef != null ? '(' + Math.round(rec.beef * 1) + ')' : '') + '</span></span></span>';
            html += '<span><span class="pz-qty-amt"><span class="pz-qty-amt-main pz-editable pz-edit-qty" contenteditable="' + editableAttr + '" data-qz-index="' + i + '" data-qz-field="lamb">' + (rec.lamb != null ? rec.lamb : '') + '</span><span class="pz-qty-amt-sub">' + (rec.lamb != null ? '(' + Math.round(rec.lamb * 1) + ')' : '') + '</span></span></span>';
            html += '<span><span class="pz-qty-amt"><span class="pz-qty-amt-main pz-editable pz-edit-qty" contenteditable="' + editableAttr + '" data-qz-index="' + i + '" data-qz-field="chicken">' + (rec.chicken != null ? rec.chicken : '') + '</span><span class="pz-qty-amt-sub">' + (rec.chicken != null ? '(' + Math.round(rec.chicken * 1) + ')' : '') + '</span></span></span>';
            html += '<span><span class="pz-qty-amt"><span class="pz-qty-amt-main pz-editable pz-edit-qty" contenteditable="' + editableAttr + '" data-qz-index="' + i + '" data-qz-field="wing">' + (rec.wing != null ? rec.wing : '') + '</span><span class="pz-qty-amt-sub">' + (rec.wing != null ? '(' + Math.round(rec.wing * 1.5) + ')' : '') + '</span></span></span>';
            html += '<span>' + Math.round(t) + '</span>';
            html += '</div>';
        });
    }
    if (!isYearAll) {
        if (qzPanelAddMode && qzPanelDraft) {
            html += '<div class="pz-data-row pz-add-row" id="pzAddRow">';
            html += '<span class="pz-add-cell"></span>';
            html += '<span class="pz-add-cell pz-add-date-cell"><input class="pz-add-input" id="pzAddDateInput" type="text" inputmode="numeric" data-pz-add-field="date" value="' + escapeHtml(qzPanelDraft.date || '') + '" aria-label="新增日期" /></span>';
            html += '<span class="pz-add-cell"><span class="pz-qty-amt"><input class="pz-add-input pz-qty-amt-main" type="text" inputmode="decimal" data-pz-add-field="beef" value="' + escapeHtml(qzPanelDraft.beef || '') + '" aria-label="新增牛" /><span class="pz-qty-amt-sub"></span></span></span>';
            html += '<span class="pz-add-cell"><span class="pz-qty-amt"><input class="pz-add-input pz-qty-amt-main" type="text" inputmode="decimal" data-pz-add-field="lamb" value="' + escapeHtml(qzPanelDraft.lamb || '') + '" aria-label="新增羊" /><span class="pz-qty-amt-sub"></span></span></span>';
            html += '<span class="pz-add-cell"><span class="pz-qty-amt"><input class="pz-add-input pz-qty-amt-main" type="text" inputmode="decimal" data-pz-add-field="chicken" value="' + escapeHtml(qzPanelDraft.chicken || '') + '" aria-label="新增鸡" /><span class="pz-qty-amt-sub"></span></span></span>';
            html += '<span class="pz-add-cell"><span class="pz-qty-amt"><input class="pz-add-input pz-qty-amt-main" type="text" inputmode="decimal" data-pz-add-field="wing" value="' + escapeHtml(qzPanelDraft.wing || '') + '" aria-label="新增鸡翅" /><span class="pz-qty-amt-sub"></span></span></span>';
            html += '<span class="pz-add-cell"><span class="pz-add-actions"><button type="button" class="pz-footer-btn" id="pzAddSaveBtn">保存</button></span></span>';
            html += '</div>';
        } else {
            html += '<div class="pz-data-row pz-add-row" id="pzAddRowTrigger">';
            html += '<span class="pz-add-cell"></span><span class="pz-add-cell"></span><span class="pz-add-cell"></span><span class="pz-add-cell"></span><span class="pz-add-cell"></span><span class="pz-add-cell"></span>';
            html += '<span class="pz-add-cell"><button type="button" class="pz-footer-btn" id="pzAddRowBtn" aria-label="新增记录">+</button></span>';
            html += '</div>';
        }
    }
    tbody.innerHTML = html;
    if (!isYearAll) {
        var panelDataLen = qzGetEditableDataRef().length;
        Array.prototype.forEach.call(tbody.querySelectorAll('.pz-date-trigger'), function (el) {
            el.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                var idx = parseInt(el.getAttribute('data-qz-index') || '-1', 10);
                if (Number.isInteger(idx) && idx >= 0 && idx < panelDataLen) {
                    showQzRowDeleteConfirm(idx);
                }
            });
        });
        var addRowBtn = document.getElementById('pzAddRowBtn');
        if (addRowBtn) {
            addRowBtn.addEventListener('click', function () {
                qzPanelDraft = qzCreatePanelDraft();
                qzSetPanelAddMode(true);
            });
        }
        var addSaveBtn = document.getElementById('pzAddSaveBtn');
        if (addSaveBtn) {
            addSaveBtn.addEventListener('click', function () {
                qzSavePanelDraft();
            });
        }
        Array.prototype.forEach.call(tbody.querySelectorAll('.pz-add-input'), function (inputEl) {
            var addField = String(inputEl.getAttribute('data-pz-add-field') || '');
            if (addField === 'date') {
                qzSyncAddDateInputWidth(inputEl);
            } else if (addField === 'beef' || addField === 'lamb' || addField === 'chicken' || addField === 'wing') {
                qzSyncAddQtyInputWidth(inputEl);
            }
            inputEl.addEventListener('click', function (e) {
                e.stopPropagation();
            });
            inputEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (qzCommitPanelDraftInput(inputEl)) inputEl.blur();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    inputEl.blur();
                }
            });
        });
    }
    if (footerWrap) footerWrap.querySelector('span') && (footerWrap.querySelector('span').textContent = 'Total');
    if (totalEl) totalEl.textContent = String(Math.round(grandTotal));
}

// 显示 quick-Z 保存结果提示。
function qzShowToast(msg) {
    var t = document.getElementById('qzToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2000);
}

//#region 面板 · Quick-Z

const qzSaveConfirmBtn = document.getElementById('qzSaveConfirmBtn');
const qzSaveViewBtn = document.getElementById('qzSaveViewBtn');

if (qzSaveConfirmBtn) {
    qzSaveConfirmBtn.addEventListener('click', () => {
        closeOverlay('qzSaveLayer');
        navStack.length = 0;
    });
}

if (qzSaveViewBtn) {
    qzSaveViewBtn.addEventListener('click', () => {
        closeOverlay('qzSaveLayer');
        navStack.length = 0;
        qzOpenSavedView = true;
        openReadonlyPanelZ();
    });
}


var MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

(function initQuickZ() {
    var beefEl = document.getElementById('qzBeef');
    var lambEl = document.getElementById('qzLamb');
    var chickenEl = document.getElementById('qzChicken');
    var wingEl = document.getElementById('qzWing');
    var dateLabel = document.getElementById('qzDateLabel');
    var dateInput = document.getElementById('qzDateInput');
    var monthBtn = document.getElementById('qzMonthBtn');
    var dayBtn = document.getElementById('qzDayBtn');
    var monthMenu = document.getElementById('qzMonthMenu');
    var dayMenu = document.getElementById('qzDayMenu');
    var wrenchBtn = document.getElementById('qzWrenchBtn');
    var manualBtn = document.getElementById('qzManualBtn');
    var dateRow = document.getElementById('qzDateRow');
    var quickZPanel = document.querySelector('#quickZLayer .quick-z-panel');
    var qzDefaultDate = '';
    var qzEditMode = false;
    var qzDateEdit = false;
    var qzManualEdit = false;
    var qzEditSnapshot = null;
    var qzBtnMap = [
        { btn: document.getElementById('qzAddBeef'), input: beefEl, label: '牛' },
        { btn: document.getElementById('qzAddLamb'), input: lambEl, label: '羊' },
        { btn: document.getElementById('qzAddChicken'), input: chickenEl, label: '鸡' },
        { btn: document.getElementById('qzAddWing'), input: wingEl, label: '鸡翅' }
    ];

    // 格式化 quick-Z 输入框里的数值文本。
    function qzFormatNum(v) {
        if (!Number.isFinite(v)) return '';
        return Number.isInteger(v) ? String(v) : String(v);
    }

    // 从 quick-Z 输入框安全读取正数。
    function qzReadNum(inputEl) {
        if (!inputEl) return null;
        var n = parseFloat(String(inputEl.value || '').trim());
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    // 把数值写回 quick-Z 输入框。
    function qzSetNum(inputEl, v) {
        if (!inputEl) return;
        if (!Number.isFinite(v) || v <= 0) {
            inputEl.value = '';
            return;
        }
        inputEl.value = qzFormatNum(v);
    }

    // 返回当前是否有 quick-Z 编辑输入框拥有焦点。
    function qzGetActiveEditInput() {
        var active = document.activeElement;
        if (active === dateInput) return active;
        if (active && active.classList && active.classList.contains('qz-btn-edit-input')) return active;
        return null;
    }

    // 记录进入编辑模式前的 5 个输入位，供取消时还原。
    function qzCaptureEditSnapshot() {
        return {
            date: String((dateInput && dateInput.value) || qzDefaultDate || qzGetToday()),
            beef: String((beefEl && beefEl.value) || ''),
            lamb: String((lambEl && lambEl.value) || ''),
            chicken: String((chickenEl && chickenEl.value) || ''),
            wing: String((wingEl && wingEl.value) || '')
        };
    }

    // 把编辑快照恢复回当前表单。
    function qzRestoreEditSnapshot(snapshot) {
        if (!snapshot) return;
        setQZDateStr(snapshot.date || qzGetToday());
        if (dateInput) dateInput.value = snapshot.date || qzGetToday();
        if (qzEditMode) populateQzDatePickers(dateInput.value);
        if (beefEl) beefEl.value = snapshot.beef || '';
        if (lambEl) lambEl.value = snapshot.lamb || '';
        if (chickenEl) chickenEl.value = snapshot.chicken || '';
        if (wingEl) wingEl.value = snapshot.wing || '';
    }

    // 更新 quick-Z 底部按钮文案。
    function qzSyncActionButtons() {
        var clearBtn = document.getElementById('qzClearBtn');
        if (clearBtn) clearBtn.textContent = qzEditMode ? '取消' : '清空';
    }

    // 提交 quick-Z 按钮内联输入框的数值。
    function qzCommitInlineValueInput(inlineInput) {
        if (!inlineInput) return;
        var field = inlineInput.getAttribute('data-qz-field');
        if (!field) return;
        var map = { beef: beefEl, lamb: lambEl, chicken: chickenEl, wing: wingEl };
        var target = map[field];
        if (!target) return;
        var cleaned = String(inlineInput.value || '').replace(/[^0-9.]/g, '');
        inlineInput.value = cleaned;
        if (!cleaned) {
            target.value = '';
            return;
        }
        var parsed = parseFloat(cleaned);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            target.value = '';
            return;
        }
        target.value = qzFormatNum(parsed);
    }

    // 提交当前聚焦的单个输入框，不退出编辑模式。
    function qzCommitFocusedEditInput(inputEl) {
        if (!inputEl) return false;
        if (inputEl === dateInput) {
            var parsed = qzParseDateValue(dateInput.value, qzGetPanelYear());
            if (!parsed) {
                qzShowToast('日期错误');
                return false;
            }
            setQZDateStr(parsed.display);
            if (dateInput) dateInput.value = parsed.display;
            return true;
        }
        qzCommitInlineValueInput(inputEl);
        return true;
    }

    // 提交 5 个编辑位，供最终保存前统一校验。
    function qzCommitAllEditInputs() {
        if (dateInput && !qzCommitFocusedEditInput(dateInput)) return false;
        if (quickZPanel && quickZPanel.querySelectorAll) {
            var inlineInputs = quickZPanel.querySelectorAll('.qz-btn-edit-input');
            Array.prototype.forEach.call(inlineInputs, function (inputEl) {
                qzCommitInlineValueInput(inputEl);
            });
        }
        return true;
    }

    // 取消当前 quick-Z 编辑，恢复到进入编辑模式前。
    function qzCancelEditMode() {
        qzRestoreEditSnapshot(qzEditSnapshot);
        setQzEditMode(false);
    }

    // 根据当前编辑状态刷新 quick-Z 按钮文案。
    function refreshQzButtons() {
        qzBtnMap.forEach(function (item) {
            if (!item.btn || !item.input) return;
            var current = qzReadNum(item.input);
            if (!qzManualEdit) {
                item.btn.textContent = current == null ? item.label : (item.label + ':' + qzFormatNum(current));
                return;
            }
            var field = item.input === beefEl ? 'beef' : item.input === lambEl ? 'lamb' : item.input === chickenEl ? 'chicken' : 'wing';
            var currentText = current == null ? '' : qzFormatNum(current);
            item.btn.innerHTML = '<span class="qz-btn-edit-wrap"><span class="qz-btn-label">' + item.label + '</span><span class="qz-btn-edit-value"><span class="qz-btn-edit-ghost">' + currentText + '</span><input class="qz-btn-edit-input" type="text" inputmode="decimal" data-qz-field="' + field + '" value="' + currentText + '" aria-label="' + item.label + ' 数值" /></span></span>';
            var valueInput = item.btn.querySelector('.qz-btn-edit-input');
            if (!valueInput) return;
            valueInput.addEventListener('input', function () {
                qzCommitInlineValueInput(valueInput);
            });
            valueInput.addEventListener('click', function (e) {
                e.stopPropagation();
            });
            valueInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    qzCommitFocusedEditInput(valueInput);
                    valueInput.blur();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    valueInput.blur();
                }
            });
        });
    }

    // 保存一条新的 quick-Z 记录并更新列表。
    async function saveQuickZRecord() {
        var b = parseFloat(beefEl.value) || 0;
        var l = parseFloat(lambEl.value) || 0;
        var c = parseFloat(chickenEl.value) || 0;
        var w = parseFloat(wingEl.value) || 0;
        if (!b && !l && !c && !w) {
            qzShowToast('请先填数量');
            return;
        }
        var rawDate = (dateInput && dateInput.value ? String(dateInput.value).trim() : '') || qzDefaultDate || qzGetToday();
        var parsedDate = qzParseDateValue(rawDate, qzGetPanelYear());
        if (!parsedDate) {
            qzShowToast('日期错误');
            if (dateInput) {
                dateInput.focus();
                placeInputCaretToEnd(dateInput);
            }
            return;
        }
        var useDate = parsedDate.display;
        var targetYear = parsedDate.year;
        var rec = { date: useDate, beef: b || null, lamb: l || null, chicken: c || null, wing: w || null };
        setQZDateStr(useDate);
        addOperationRecord('保存数据 ' + useDate + ': ' + formatQzRowSummary(rec));
        qzLastSavedYear = targetYear;
        qzLastSavedMonth = parsedDate.month;
        try {
            if (targetYear === Number(currentYear)) {
                qzData.push(rec);
                qzSaveLocal();
                qzRenderPanel();
            } else {
                var saved = await qzAppendRecordToYear(targetYear, rec);
                if (!(saved && saved.ok)) {
                    qzShowToast('保存失败');
                    return;
                }
                if (qzGetPanelYear() === 0) {
                    qzLoadPanelYear(0);
                } else if (qzGetPanelYear() === targetYear) {
                    qzLoadPanelYear(targetYear);
                }
            }
        } catch (_) {
            qzShowToast('保存失败');
            return;
        }
        beefEl.value = ''; lambEl.value = ''; chickenEl.value = ''; wingEl.value = '';
        setQzEditMode(false);
        refreshQzButtons();
        // 验证入口时验证层已藏，不能再用 verify 是否可见判断；直接开成功层（openOverlay 会收起 quickZ）
        if (reopenVerifyOnClose) {
            openOverlay('qzSaveLayer');
        } else {
            qzShowToast('保存成功');
            closeOverlay('quickZLayer');
        }
    }

    // 同步 quick-Z 当前选中日期到相关控件。
    function setQZDateStr(val) {
        if (!val) return;
        var parsed = qzParseDateValue(val, qzGetPanelYear());
        var nextVal = parsed ? parsed.display : String(val);
        qzSelectedDate = nextVal;
        qzDefaultDate = nextVal;
        if (dateLabel) dateLabel.textContent = parsed ? (MONTH_ABBR[parsed.month - 1] + ' ' + parsed.day) : String(val);
        if (dateInput) dateInput.value = qzFormatEditorDate(nextVal, qzGetPanelYear());
    }

    var qzCurMonth = null;
    var qzCurDay = null;

    // 根据月份刷新日按钮菜单。
    function qzSyncDayPicker(month, keepDay) {
        qzCurMonth = month;
        var year = qzGetPanelYear() || new Date().getFullYear();
        var daysInMonth = new Date(year, month, 0).getDate();
        var curDay = keepDay || qzCurDay || 1;
        if (curDay > daysInMonth) curDay = daysInMonth;
        qzCurDay = curDay;
        monthBtn.textContent = MONTH_ABBR[month - 1];
        dayBtn.textContent = curDay;

        dayMenu.innerHTML = '';
        for (var d = 1; d <= daysInMonth; d++) {
            (function (dayVal) {
                var btn = document.createElement('button');
                btn.className = 'quick-date-picker-option';
                btn.type = 'button';
                btn.textContent = dayVal;
                if (dayVal === curDay) btn.classList.add('active');
                btn.addEventListener('click', function () {
                    qzCurDay = dayVal;
                    dayBtn.textContent = dayVal;
                    syncQzDateFromPickers();
                    closeQzPicker(dayMenu.parentElement);
                });
                dayMenu.appendChild(btn);
            })(d);
        }

        setTimeout(function () {
            var sel = dayMenu.querySelector('.active');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }, 0);
    }

    // 初始化月份按钮和菜单（一次性）。
    function buildQzMonthPicker() {
        if (monthMenu._built) return;
        for (var m = 1; m <= 12; m++) {
            (function (monthVal) {
                var btn = document.createElement('button');
                btn.className = 'quick-date-picker-option';
                btn.type = 'button';
                btn.textContent = MONTH_ABBR[monthVal - 1];
                btn.addEventListener('click', function () {
                    qzCurMonth = monthVal;
                    monthBtn.textContent = MONTH_ABBR[monthVal - 1];
                    qzSyncDayPicker(monthVal, null);
                    syncQzDateFromPickers();
                    closeQzPicker(monthMenu.parentElement);
                });
                monthMenu.appendChild(btn);
            })(m);
        }
        monthMenu._built = true;
    }

    // 把按钮选择同步到隐藏输入框和标签。
    function syncQzDateFromPickers() {
        if (!qzCurMonth || !qzCurDay) return;
        var year = qzGetPanelYear();
        if (!year) year = new Date().getFullYear();
        var display = qzCurMonth + '/' + qzCurDay;
        var fullDate = year + '/' + qzCurMonth + '/' + qzCurDay;
        if (dateInput) dateInput.value = fullDate;
        if (dateLabel) dateLabel.textContent = MONTH_ABBR[qzCurMonth - 1] + ' ' + qzCurDay;
        qzDefaultDate = fullDate;
        qzSelectedDate = fullDate;
    }

    // 打开/关闭 picker 菜单。
    function openQzPicker(pickerEl) {
        closeAllQzPickers();
        if (!pickerEl) return;

        if (pickerEl === monthMenu.parentElement && qzCurMonth) {
            var btns = monthMenu.querySelectorAll('.quick-date-picker-option');
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('active', MONTH_ABBR.indexOf(btns[i].textContent) + 1 === qzCurMonth);
            }
        }

        pickerEl.classList.add('open');
        setTimeout(function () {
            var sel = pickerEl.querySelector('.quick-date-picker-option.active');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }, 0);
    }
    function closeQzPicker(pickerEl) {
        if (pickerEl) pickerEl.classList.remove('open');
    }
    function closeAllQzPickers() {
        if (monthMenu && monthMenu.parentElement) closeQzPicker(monthMenu.parentElement);
        if (dayMenu && dayMenu.parentElement) closeQzPicker(dayMenu.parentElement);
    }

    // 用当前日期值初始化 picker。
    function populateQzDatePickers(dateVal) {
        var parsed = qzParseDateValue(dateVal, qzGetPanelYear());
        qzCurMonth = parsed ? parsed.month : (new Date().getMonth() + 1);
        qzCurDay = parsed ? parsed.day : new Date().getDate();
        buildQzMonthPicker();
        monthBtn.textContent = MONTH_ABBR[qzCurMonth - 1];
        dayBtn.textContent = qzCurDay;
        qzSyncDayPicker(qzCurMonth, qzCurDay);
    }

    // 根据日期/手动输入两个子状态的组合，同步 quick-Z 编辑 UI。
    function syncQzEditState() {
        var wasEditing = qzEditMode;
        qzEditMode = !!(qzDateEdit || qzManualEdit);
        if (dateRow && dateRow.classList) {
            dateRow.classList.toggle('editing', qzDateEdit);
        }
        if (qzEditMode && !wasEditing) {
            qzEditSnapshot = qzCaptureEditSnapshot();
            var curDateVal = qzDefaultDate || qzGetToday();
            if (dateInput) dateInput.value = qzFormatEditorDate(curDateVal, qzGetPanelYear());
        }
        if (qzDateEdit && dateInput) {
            populateQzDatePickers(dateInput.value);
        }
        if (!qzDateEdit) {
            closeAllQzPickers();
        }
        if (!qzEditMode) {
            qzEditSnapshot = null;
        }
        qzSyncActionButtons();
        refreshQzButtons();
    }

    // 同时切换日期与手动输入编辑模式。
    function setQzEditMode(on) {
        qzDateEdit = !!on;
        qzManualEdit = !!on;
        syncQzEditState();
    }

    // 把 quick-Z 日期重置为今天。
    function setQZDate() {
        setQZDateStr(qzGetToday());
    }

    if (wrenchBtn && dateInput) {
        wrenchBtn.addEventListener('click', function (e) {
            if (isReadonlyMode()) return;
            e.stopPropagation();
            qzManualEdit = false;
            qzDateEdit = !qzDateEdit;
            syncQzEditState();
        });

        dateInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (qzCommitFocusedEditInput(dateInput)) dateInput.blur();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                dateInput.blur();
            }
        });
    }

    if (manualBtn) {
        manualBtn.addEventListener('click', function (e) {
            if (isReadonlyMode()) return;
            e.stopPropagation();
            qzDateEdit = false;
            qzManualEdit = !qzManualEdit;
            syncQzEditState();
        });
    }

    if (dateRow) {
        dateRow.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }

    if (quickZPanel) {
        quickZPanel.addEventListener('keydown', function (e) {
            if (qzEditMode) {
                var activeEditInput = qzGetActiveEditInput();
                if (e.key === 'Enter') {
                    if (activeEditInput) return;
                    e.preventDefault();
                    if (!qzCommitAllEditInputs()) return;
                    saveQuickZRecord();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (activeEditInput) {
                        activeEditInput.blur();
                        return;
                    }
                    qzCancelEditMode();
                    return;
                }
            }
            if (e.key === 'Enter') {
                var target = e.target;
                if (target === dateInput) return;
                if (target && target.tagName === 'INPUT') return;
                e.preventDefault();
                saveQuickZRecord();
            }
        });
    }

    [beefEl, lambEl, chickenEl, wingEl].forEach(function (el) {
        if (!el) return;
        el.addEventListener('input', function () {
            if (!qzEditMode) refreshQzButtons();
        });
    });

    // 给 quick-Z 对应食材字段累加固定数值。
    function addToField(inputEl, amt) {
        var cur = qzReadNum(inputEl) || 0;
        qzSetNum(inputEl, cur + amt);
        refreshQzButtons();
    }
    qzBtnMap.forEach(function (item) {
        if (!item.btn || !item.input) return;
        item.btn.addEventListener('click', function (e) {
            if (isReadonlyMode()) return;
            if (qzEditMode) {
                var t = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
                if (t && t.classList && t.classList.contains('qz-btn-edit-input')) return;
                var inlineInput = item.btn.querySelector('.qz-btn-edit-input');
                if (inlineInput) {
                    inlineInput.focus();
                    placeInputCaretToEnd(inlineInput);
                }
                return;
            }
            addToField(item.input, 120);
        });
        item.btn.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            item.btn.click();
        });
    });

    document.addEventListener('pointerdown', function (e) {
        if (!qzEditMode || !quickZPanel) return;
        var target = e.target;
        if (!target) return;
        var allowKeep = target === dateInput
            || (target.classList && target.classList.contains('qz-btn-edit-input'))
            || (target.closest && (target.closest('.qz-btn') || target.closest('#qzSaveBtn') || target.closest('#qzClearBtn') || target.closest('#qzWrenchBtn') || target.closest('#qzManualBtn') || target.closest('.quick-date-picker')));
        if (allowKeep) return;
        var activeEditInput = qzGetActiveEditInput();
        if (activeEditInput) {
            activeEditInput.blur();
            return;
        }
        qzCancelEditMode();
    });

    var clrBtn = document.getElementById('qzClearBtn');
    if (clrBtn) clrBtn.addEventListener('click', function () {
        if (isReadonlyMode()) return;
        if (qzEditMode) {
            qzCancelEditMode();
            return;
        }
        beefEl.value = ''; lambEl.value = ''; chickenEl.value = ''; wingEl.value = '';
        refreshQzButtons();
    });

    var saveBtn = document.getElementById('qzSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', function () {
        if (isReadonlyMode()) return;
        if (qzEditMode && !qzCommitAllEditInputs()) return;
        saveQuickZRecord();
    });

    if (quickZLayer) {
        var obs = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                if (m.attributeName === 'class' && quickZLayer.classList.contains('active')) {
                    qzSelectedDate = '';
                    setQZDate();
                    setQzEditMode(false);
                    if (beefEl) beefEl.value = '';
                    if (lambEl) lambEl.value = '';
                    if (chickenEl) chickenEl.value = '';
                    if (wingEl) wingEl.value = '';
                    refreshQzButtons();
                }
            });
        });
        obs.observe(quickZLayer, { attributes: true });
        quickZLayer.addEventListener('click', function (e) {
            if (e.target === quickZLayer) goBack();
        });
    }

    qzSelectedDate = '';
    setQZDate();
    setQzEditMode(false);
    refreshQzButtons();

    monthBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var picker = monthMenu.parentElement;
        if (picker.classList.contains('open')) { closeQzPicker(picker); }
        else { openQzPicker(picker); }
    });

    dayBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var picker = dayMenu.parentElement;
        if (picker.classList.contains('open')) { closeQzPicker(picker); }
        else { openQzPicker(picker); }
    });

    document.addEventListener('click', function (e) {
        var pickers = [monthMenu.parentElement, dayMenu.parentElement];
        for (var i = 0; i < pickers.length; i++) {
            if (pickers[i] && pickers[i].classList.contains('open') && !pickers[i].contains(e.target)) {
                pickers[i].classList.remove('open');
            }
        }
    });
})();

//#endregion



const qzRowdeleteConfirmLayer = document.getElementById('qzRowdeleteConfirmLayer');
const qzRowdeleteConfirmText = document.getElementById('qzRowdeleteConfirmText');
const qzRowdeleteConfirmBtn = document.getElementById('qzRowdeleteConfirmBtn');
const qzRowdeleteCancelBtn = document.getElementById('qzRowdeleteCancelBtn');

// 显示 Panel-Z 行删除确认弹层。
function showQzRowDeleteConfirm(index) {
    pendingDeleteQzIndex = index;
    if (qzRowdeleteConfirmText) {
        qzRowdeleteConfirmText.textContent = '是否整行删除？';
    }
    showConfirmLayer(qzRowdeleteConfirmLayer);
}

// 关闭 Panel-Z 行删除确认弹层。
function hideQzRowDeleteConfirm() {
    pendingDeleteQzIndex = -1;
    hideConfirmLayer(qzRowdeleteConfirmLayer);
}

if (qzRowdeleteCancelBtn) {
    qzRowdeleteCancelBtn.addEventListener('click', hideQzRowDeleteConfirm);
}
if (qzRowdeleteConfirmBtn) {
    qzRowdeleteConfirmBtn.addEventListener('click', () => {
        if (isReadonlyMode()) {
            hideQzRowDeleteConfirm();
            return;
        }
        var editRef = qzGetEditableDataRef();
        if (pendingDeleteQzIndex >= 0 && pendingDeleteQzIndex < editRef.length) {
            const removed = editRef[pendingDeleteQzIndex];
            const rowDate = removed && removed.date ? removed.date : qzGetToday();
            const beforeText = formatQzRowSummary(removed);
            editRef.splice(pendingDeleteQzIndex, 1);
            addOperationRecord('移除数据: ' + rowDate + ': ' + beforeText + ' - ' + rowDate + ': [ ]');
            var delYear = qzGetPanelYear();
            if (delYear === 0 || delYear === Number(currentYear)) {
                qzSaveLocal();
            } else {
                qzSaveYearData(delYear, editRef);
            }
            qzRenderPanel();
        }
        hideQzRowDeleteConfirm();
    });
}
if (qzRowdeleteConfirmLayer) {
    qzRowdeleteConfirmLayer.addEventListener('click', (e) => {
        if (e.target === qzRowdeleteConfirmLayer) hideQzRowDeleteConfirm();
    });
}

(function initPanelZ() {
    var qzTableBody = document.getElementById('pzTableBody');
    if (qzTableBody) {
        // 提交 Panel-Z 表格单元格修改并触发保存。
        function commitEditableCell(target) {
            if (!target || !target.classList || !target.classList.contains('pz-editable')) return;
            var idx = parseInt(target.getAttribute('data-qz-index') || '-1', 10);
            if (!Number.isInteger(idx) || idx < 0) return;
            var isEmptyRow = target.getAttribute('data-qz-empty') === '1';
            var panelDataRef = qzGetEditableDataRef();
            var existing = panelDataRef[idx];
            var rec = existing;
            var changed = false;
            var shouldSave = false;
            if (target.classList.contains('pz-edit-qty')) {
                var field = target.getAttribute('data-qz-field');
                if (!field) return;
                var raw = (target.textContent || '').replace(/[^0-9.]/g, '').trim();
                var num = raw ? parseFloat(raw) : NaN;
                var nextVal = Number.isFinite(num) ? num : null;
                if (!rec && isEmptyRow) {
                    if (!Number.isFinite(num)) {
                        qzRenderPanel();
                        return;
                    }
                    rec = { date: qzGetToday(), beef: null, lamb: null, chicken: null, wing: null };
                    panelDataRef.push(rec);
                    changed = true;
                }
                if (!rec) return;
                if (rec[field] !== nextVal) {
                    var before = rec[field];
                    rec[field] = nextVal;
                    changed = true;
                    shouldSave = true;
                    var rowDate = rec.date || qzGetToday();
                    if (before == null && nextVal != null) {
                        addOperationRecord('保存数据 ' + rowDate + ': [' + field + ':' + nextVal + ']');
                    } else if (before != null && nextVal == null) {
                        addOperationRecord('移除数据: ' + rowDate + ': [' + field + ':' + before + '] - ' + rowDate + ': [ ]');
                    } else {
                        addOperationRecord('修改数据 ' + rowDate + ': [' + field + ':' + before + '] → ' + rowDate + ': [' + field + ':' + nextVal + ']');
                    }
                }
            }
            if (changed || shouldSave) {
                var saveYear = qzGetPanelYear();
                if (saveYear === 0 || saveYear === Number(currentYear)) {
                    qzSaveLocal();
                } else {
                    qzSaveYearData(saveYear, panelDataRef);
                }
                qzRenderPanel();
            } else if (isEmptyRow) {
                qzRenderPanel();
            }
        }

        qzTableBody.addEventListener('click', function (e) {
            if (panelZReadonlyMode) return;
            var clickTarget = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
            var dateEl = clickTarget && clickTarget.closest ? clickTarget.closest('.pz-date-trigger') : null;
            if (!dateEl) return;
            var idx = parseInt(dateEl.getAttribute('data-qz-index') || '-1', 10);
            var editableLen = qzGetEditableDataRef().length;
            if (Number.isInteger(idx) && idx >= 0 && idx < editableLen) {
                showQzRowDeleteConfirm(idx);
            }
        });

        qzTableBody.addEventListener('keydown', function (e) {
            if (panelZReadonlyMode) return;
            var target = e.target;
            if (!target || !target.classList || !target.classList.contains('pz-editable')) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                target.blur();
            }
        });

        qzTableBody.addEventListener('focusout', function (e) {
            if (panelZReadonlyMode) return;
            var target = e.target;
            if (!target || !target.classList || !target.classList.contains('pz-editable')) return;
            commitEditableCell(target);
        });
    }

    var pzMonthSelect = document.getElementById('pzMonthSelect');
    var pzMonthPicker = document.getElementById('pzMonthPicker');
    var pzMonthSelectBtn = document.getElementById('pzMonthSelectBtn');
    var pzMonthSelectMenu = document.getElementById('pzMonthSelectMenu');
    if (pzMonthSelect) {
        qzSyncMonthSelect();
        pzMonthSelect.addEventListener('change', function () {
            var nextMonth = parseInt(String(pzMonthSelect.value || '0'), 10);
            qzPanelAddMode = false;
            qzPanelDraft = null;
            qzViewMonth = Number.isInteger(nextMonth) && nextMonth >= 0 && nextMonth <= 12 ? nextMonth : 0;
            qzSyncMonthSelect();
            qzRenderPanel();
        });
    }

    var pzYearSelect = document.getElementById('pzYearSelect');
    var pzYearPicker = document.getElementById('pzYearPicker');
    var pzYearSelectBtn = document.getElementById('pzYearSelectBtn');
    var pzYearSelectMenu = document.getElementById('pzYearSelectMenu');
    if (pzYearSelect) {
        qzSyncYearSelect();
        pzYearSelect.addEventListener('change', function () {
            var nextYear = parseInt(String(pzYearSelect.value || currentYear), 10);
            if (!Number.isInteger(nextYear) || nextYear < 0 || nextYear > 9999) {
                qzSyncYearSelect();
                return;
            }
            qzLoadPanelYear(nextYear);
        });
    }

    // 切换 Panel-Z 自定义下拉菜单展开状态。
    function togglePzPicker(pickerEl) {
        if (!pickerEl) return;
        var willOpen = !pickerEl.classList.contains('open');
        qzClosePickerMenus();
        if (!willOpen) return;
        pickerEl.classList.add('open');
        var btn = pickerEl.querySelector('.pz-picker-btn');
        if (btn) btn.setAttribute('aria-expanded', 'true');
    }

    // 绑定 Panel-Z 下拉按钮点击事件。
    function bindPzPickerButton(btnEl, pickerEl) {
        if (!btnEl || !pickerEl) return;
        btnEl.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            togglePzPicker(pickerEl);
        });
    }

    // 绑定 Panel-Z 下拉选项点击事件。
    function bindPzPickerMenu(menuEl, selectEl) {
        if (!menuEl || !selectEl) return;
        menuEl.addEventListener('click', function (e) {
            var optionBtn = e.target && e.target.closest ? e.target.closest('.pz-picker-option') : null;
            if (!optionBtn) return;
            e.preventDefault();
            e.stopPropagation();
            selectEl.value = String(optionBtn.getAttribute('data-value') || '');
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            qzClosePickerMenus();
        });
    }

    bindPzPickerButton(pzYearSelectBtn, pzYearPicker);
    bindPzPickerButton(pzMonthSelectBtn, pzMonthPicker);
    bindPzPickerMenu(pzYearSelectMenu, pzYearSelect);
    bindPzPickerMenu(pzMonthSelectMenu, pzMonthSelect);

    var pzBottomControls = document.getElementById('pzBottomControls');
    var pzDateToggleBtn = document.getElementById('pzDateToggleBtn');
    var pzMonthPrevBtn = document.getElementById('pzMonthPrevBtn');
    var pzMonthNextBtn = document.getElementById('pzMonthNextBtn');
    if (pzMonthPrevBtn) {
        pzMonthPrevBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            qzClosePickerMenus();
            qzShiftPanelMonth(-1);
        });
    }
    if (pzMonthNextBtn) {
        pzMonthNextBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            qzClosePickerMenus();
            qzShiftPanelMonth(1);
        });
    }
    if (pzBottomControls && pzDateToggleBtn) {
        pzDateToggleBtn.addEventListener('click', function () {
            pzBottomControls.classList.add('expanded');
            if (pzYearSelectBtn) pzYearSelectBtn.focus();
        });
    }

    document.addEventListener('click', function (e) {
        if (!pzBottomControls) return;
        if (pzBottomControls.contains(e.target)) return;
        qzClosePickerMenus();
    });

    document.addEventListener('keydown', function (e) {
        if (!qzPanelAddMode) return;
        if (e.key === 'Enter') {
            var activeAddInput = qzGetPanelAddActiveInput();
            if (activeAddInput) return;
            e.preventDefault();
            qzSavePanelDraft();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            var focusedAddInput = qzGetPanelAddActiveInput();
            if (focusedAddInput) {
                focusedAddInput.blur();
                return;
            }
            qzPanelDraft = null;
            qzSetPanelAddMode(false);
        }
    });

    document.addEventListener('pointerdown', function (e) {
        if (!qzPanelAddMode) return;
        var target = e.target;
        if (!target) return;
        var keepInside = target.classList && target.classList.contains('pz-add-input');
        if (!keepInside && target.closest) {
            keepInside = !!(target.closest('#pzAddRow') || target.closest('#pzAddSaveBtn') || target.closest('#pzAddRowBtn'));
        }
        if (keepInside) return;
        qzPanelDraft = null;
        qzSetPanelAddMode(false);
    });

    var pzLayerEl = document.getElementById('panelZLayer');
    if (pzLayerEl) {
        var obs2 = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                if (m.attributeName === 'class' && pzLayerEl.classList.contains('active')) {
                    qzClosePickerMenus();
                    qzPanelAddMode = false;
                    qzPanelDraft = null;
                    qzPanelYear = qzOpenSavedView ? Number(qzLastSavedYear || currentYear) : Number(currentYear);
                    qzViewMonth = qzOpenSavedView
                        ? (Number.isInteger(qzLastSavedMonth) && qzLastSavedMonth >= 1 && qzLastSavedMonth <= 12
                            ? qzLastSavedMonth
                            : (Number.isInteger(currentMonth) ? currentMonth + 1 : 0))
                        : (Number.isInteger(currentMonth) ? currentMonth + 1 : 0);
                    if (qzGetPanelYear() === Number(currentYear)) {
                        qzPanelViewData = [];
                        qzSyncYearSelect();
                        qzSyncMonthSelect();
                        qzRenderPanel();
                    } else {
                        qzSyncYearSelect();
                        qzSyncMonthSelect();
                        qzLoadPanelYear(qzGetPanelYear());
                    }
                    qzOpenSavedView = false;
                }
            });
        });
        obs2.observe(pzLayerEl, { attributes: true });
    }

    qzResetPanelYear();
    qzResetViewMonth();
    qzSyncYearSelect();
    qzSyncMonthSelect();

    (function initPzFooterToggle() {
        var footerEl = document.getElementById('pzFooter');
        if (!footerEl) return;

        var expanded = false;

        // 展开 Footer 显示分项汇总。
        function expandFooter() {
            var panelRecords = qzGetPanelRecords();
            var activeMonth = qzGetViewMonth();
            var visibleRows = activeMonth >= 1
                ? panelRecords.filter(function (rec) {
                    return parseQzRecordMonth(rec.date) === activeMonth;
                })
                : panelRecords;
            var summary = qzSummarizeRecords(visibleRows);
            var grandTotal = Math.round(summary.beef + summary.lamb + summary.chicken + summary.wing * 1.5);

            // 渲染 Footer 数量与金额组合单元格。
            function renderQtyAmt(val, unitPrice) {
                var main = val ? String(val) : '';
                var sub = val ? '(' + Math.round(val * unitPrice) + ')' : '';
                return '<span class="pz-qty-amt">' +
                    '<span class="pz-qty-amt-main pz-editable pz-edit-qty">' + main + '</span>' +
                    '<span class="pz-qty-amt-sub">' + sub + '</span>' +
                    '</span>';
            }

            footerEl.className = 'pz-data-row pz-footer-expanded';
            footerEl.style.cssText = 'border-top:2.5px solid rgba(0,0,0,0.5);margin-top:5px;cursor:pointer;flex-shrink:0;';

            footerEl.innerHTML =
                '<span class="pz-row-index"></span>' +
                '<span class="pz-editable pz-edit-date" style="text-align:left;">Total</span>' +
                '<span>' + renderQtyAmt(summary.beef || null, 1) + '</span>' +
                '<span>' + renderQtyAmt(summary.lamb || null, 1) + '</span>' +
                '<span>' + renderQtyAmt(summary.chicken || null, 1) + '</span>' +
                '<span>' + renderQtyAmt(summary.wing || null, 1.5) + '</span>' +
                '<span>' + grandTotal + '</span>';

            expanded = true;
        }

        // 收起 Footer 恢复默认总计行。
        function collapseFooter() {
            footerEl.className = 'pz-footer';
            footerEl.style.cssText = '';
            footerEl.innerHTML = '<span>Total</span><span id="pzGrandTotal">—</span>';
            qzRenderPanel();
            expanded = false;
        }

        footerEl.style.cursor = 'pointer';
        footerEl.addEventListener('click', function (e) {
            e.stopPropagation();
            if (expanded) {
                collapseFooter();
            } else {
                expandFooter();
            }
        });

        var pzYearSelectEl = document.getElementById('pzYearSelect');
        var pzMonthSelectEl = document.getElementById('pzMonthSelect');
        if (pzYearSelectEl) pzYearSelectEl.addEventListener('change', function () { if (expanded) collapseFooter(); });
        if (pzMonthSelectEl) pzMonthSelectEl.addEventListener('change', function () { if (expanded) collapseFooter(); });

        var pzLayerElReset = document.getElementById('panelZLayer');
        if (pzLayerElReset) {
            var obsReset = new MutationObserver(function (mutations) {
                mutations.forEach(function (m) {
                    if (m.attributeName === 'class' && !pzLayerElReset.classList.contains('active')) {
                        expanded = false;
                    }
                });
            });
            obsReset.observe(pzLayerElReset, { attributes: true });
        }
    })();

})();

qzLoadFromDb();

//#endregion

//#region 日志面板


const logdeleteConfirmLayer = document.getElementById('logdeleteConfirmLayer');
const logdeleteConfirmText = document.getElementById('logdeleteConfirmText');
const logdeleteConfirmBtn = document.getElementById('logdeleteConfirmBtn');
const logdeleteCancelBtn = document.getElementById('logdeleteCancelBtn');

const MAX_ACCESS_LOGS = 100;
const accessLogs = [];
let currentAccessSession = null;
let accessLogMasked = false;
let hasFullAccess = false;

// 判断当前用户是否有权查看访问日志。
function canViewLogs() {
    return hasFullAccess;
}

// 从 UA 解析真实设备类型，只返回 IPHONE / ANDROID / MAC / WINDOWS；无法确定返回空字符串。
function detectDeviceLabel() {
    const uaLower = String(navigator.userAgent || '').toLowerCase();
    if (uaLower.includes('iphone')) return 'IPHONE';
    if (uaLower.includes('ipad')) return '';
    if (uaLower.includes('android')) return 'ANDROID';
    if (uaLower.includes('windows')) return 'WINDOWS';
    if (uaLower.includes('macintosh') || uaLower.includes('mac os')) return 'MAC';
    return '';
}

// 归一化历史记录的设备文本，只保留 IPHONE / ANDROID / MAC / WINDOWS，无法识别返回空字符串。
function normalizeDeviceLabel(deviceText) {
    const v = String(deviceText || '').trim().toLowerCase();
    if (v.includes('iphone')) return 'IPHONE';
    if (v.includes('ipad')) return '';
    if (v.includes('android')) return 'ANDROID';
    if (v.includes('windows')) return 'WINDOWS';
    if (v.includes('mac')) return 'MAC';
    return '';
}

// 格式化日志时间戳。
function formatLogDate(now) {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${d} ${hh}:${mm}`;
}

// 根据验证码获取操作标签。
function getOpLabelFromCode(codeText) {
    const v = String(codeText || '').trim().toLowerCase();
    if (v === 'y') return '仅浏览';
    return '';
}

// 根据验证码获取面板名称。
function getPanelNameFromCode(codeText) {
    const v = String(codeText || '').trim().toLowerCase();
    if (v === 'c' || v === 'cash') return 'PanelC';
    if (v === 'z') return 'PanelZ';
    if (v === '0') return 'PanelZ';
    if (v === 'l') return 'PanelRecords';
    if (v === 'y') return 'MainPage';
    if (v === '2') return 'Root';
    return 'PanelUnknown';
}

// 根据验证码生成日志样式类名。
function getCodeClassName(codeText) {
    const v = String(codeText || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return v ? `log-code-${v}` : '';
}

// 根据设备标签生成日志样式类名。
function getDeviceClassName(deviceText) {
    const v = String(deviceText || '').trim().toLowerCase();
    if (v.includes('windows')) return 'log-device-windows';
    if (v.includes('mac')) return 'log-device-mac';
    if (v.includes('iphone')) return 'log-device-iphone';
    if (v.includes('android')) return 'log-device-android';
    return '';
}

// 规范化操作记录中的数值文本。
function normalizeOpValue(raw) {
    return String(raw == null ? '' : raw).trim();
}

// 构建访问日志操作列 HTML。
function buildLogOpHtml(codeText, opText) {
    const panel = escapeHtml(getPanelNameFromCode(codeText));
    const raw = String(opText || '').trim();
    if (raw === '仅浏览') return `<span class="op-panel-wrap"><span class="op-dash-left">-</span><span class="op-panel-text">仅浏览</span><span class="op-dash-right">-</span></span>`;
    if (!raw) return `<span class="op-panel-wrap"><span class="op-dash-left">-</span><span class="op-panel-text">${panel}</span><span class="op-dash-right">-</span></span>`;

    let m = raw.match(/^移除数据:\s*([^:]+):\s*(.*?)\s*-\s*([^:]+):\s*(.*)$/);
    if (m) {
        const date = escapeHtml(String(m[1] || '').trim());
        const beforeVal = normalizeOpValue(m[2]);
        const body = beforeVal ? `${date} ${escapeHtml(beforeVal)}` : date;
        return `<span class="op-panel-wrap"><span class="op-dash-left">-</span><span class="op-panel-text">${panel}</span><span class="op-dash-right">-</span></span><span class="op-record-wrap"><span class="op-del">[DEL] ${body}</span></span>`;
    }

    m = raw.match(/^保存数据\s+([^:]+):\s*(.*)$/);
    if (m) {
        const date = escapeHtml(String(m[1] || '').trim());
        const afterVal = normalizeOpValue(m[2]);
        const body = afterVal ? `${date} ${escapeHtml(afterVal)}` : date;
        return `<span class="op-panel-wrap"><span class="op-dash-left">-</span><span class="op-panel-text">${panel}</span><span class="op-dash-right">-</span></span><span class="op-record-wrap"><span class="op-add">[ADD] ${body}</span></span>`;
    }

    m = raw.match(/^修改数据\s+([^:]+):\s*(.*?)\s*→\s*([^:]+):\s*(.*)$/);
    if (m) {
        const oldDate = escapeHtml(String(m[1] || '').trim());
        const oldVal = normalizeOpValue(m[2]);
        const newDate = escapeHtml(String(m[3] || '').trim());
        const newVal = normalizeOpValue(m[4]);
        const oldBody = oldVal ? `${oldDate} ${escapeHtml(oldVal)}` : oldDate;
        const newBody = newVal ? `${newDate} ${escapeHtml(newVal)}` : newDate;
        return `<span class="op-panel-wrap"><span class="op-dash-left">-</span><span class="op-panel-text">${panel}</span><span class="op-dash-right">-</span></span><span class="op-record-wrap"><span class="op-del">${oldBody}</span><span class="op-arrow">→</span><span class="op-add">${newBody}</span></span>`;
    }

    return `<span class="op-panel-wrap"><span class="op-dash-left">-</span><span class="op-panel-text">${panel}</span><span class="op-dash-right">-</span></span><span class="op-record-wrap">${escapeHtml(raw)}</span>`;
}

// 将值格式化为方括号包裹的展示文本。
function formatBracketValue(value) {
    const txt = String(value == null ? '' : value).trim();
    return `[${txt}]`;
}

// 格式化 Panel-Z 行摘要为方括号文本。
function formatQzRowSummary(rec) {
    if (!rec || typeof rec !== 'object') return '[]';
    const b = rec.beef == null ? '' : String(rec.beef);
    const l = rec.lamb == null ? '' : String(rec.lamb);
    const c = rec.chicken == null ? '' : String(rec.chicken);
    const w = rec.wing == null ? '' : String(rec.wing);
    return `[牛:${b} 羊:${l} 鸡:${c} 鸡翅:${w}]`;
}

// 渲染访问日志列表。
function renderAccessLogs() {
    const list = document.getElementById('logList');
    if (!list) return;
    if (accessLogMasked) {
        list.innerHTML = '';
        list.style.removeProperty('--log-col-1');
        list.style.removeProperty('--log-col-2');
        list.style.removeProperty('--log-col-3');
        list.style.removeProperty('--log-col-4');
        return;
    }
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    let logHtml = accessLogs.map((item) => {
        const time = String(item.time || '');
        const shortTime = time.replace(/^\d{4}\//, '');
        const device = normalizeDeviceLabel(String(item.device || ''));
        const deviceClass = getDeviceClassName(device);
        const ip = String(item.ip || 'Unknown');
        const code = String(item.code || '');
        const panelName = getPanelNameFromCode(code);
        const codeClass = getCodeClassName(code);
        const op = String(item.op || '-');
        const opHtml = buildLogOpHtml(code, op);
        const mobileDeviceHtml = device ? `<span class="log-device log-device-chip ${deviceClass}">${escapeHtml(device)}</span>` : '';
        if (isMobile) {
            return `<div class="log-row mobile-log-row"><div class="log-line log-line-top"><span class="log-time">${escapeHtml(shortTime)}</span>${mobileDeviceHtml}<span class="log-ip">${escapeHtml(ip)}</span></div><div class="log-line log-line-bottom"><span class="log-code log-code-chip"><span class="log-code-val ${codeClass}">${escapeHtml(panelName)}</span></span><span class="log-op log-op-chip">${opHtml}</span></div></div>`;
        }
        return `<div class="log-row"><span>${escapeHtml(shortTime)}</span><span class="log-device-chip ${deviceClass}">${escapeHtml(device)}</span><span>${escapeHtml(ip)}</span><span class="log-code-chip"><span class="log-code-val ${codeClass}">${escapeHtml(panelName)}</span></span><span class="log-op-chip">${opHtml}</span></div>`;
    }).join('');
    if (accessLogs.length > 0) {
        logHtml += '<div class="log-remove-wrap"><button type="button" class="log-remove-btn">移除</button><button type="button" class="log-clear-btn">全部删除</button></div>';
    }
    list.innerHTML = logHtml;
    if (!isMobile) {
        applyDesktopLogColumnWidths(list);
    } else {
        list.style.removeProperty('--log-col-1');
        list.style.removeProperty('--log-col-2');
        list.style.removeProperty('--log-col-3');
        list.style.removeProperty('--log-col-4');
    }
}

// 按内容宽度设置桌面端日志列宽。
function applyDesktopLogColumnWidths(list) {
    const rows = Array.from(list.querySelectorAll('.log-row:not(.mobile-log-row)'));
    if (!rows.length) {
        list.style.removeProperty('--log-col-1');
        list.style.removeProperty('--log-col-2');
        list.style.removeProperty('--log-col-3');
        list.style.removeProperty('--log-col-4');
        return;
    }
    list.style.removeProperty('--log-col-1');
    list.style.removeProperty('--log-col-2');
    list.style.removeProperty('--log-col-3');
    list.style.removeProperty('--log-col-4');
    const maxCols = [0, 0, 0, 0];
    rows.forEach((row) => {
        for (let i = 0; i < 4; i++) {
            const cell = row.children[i];
            if (!cell) continue;
            const width = Math.ceil(cell.scrollWidth);
            if (width > maxCols[i]) maxCols[i] = width;
        }
    });
    list.style.setProperty('--log-col-1', `${maxCols[0]}px`);
    list.style.setProperty('--log-col-2', `${maxCols[1]}px`);
    list.style.setProperty('--log-col-3', `${maxCols[2]}px`);
    list.style.setProperty('--log-col-4', `${maxCols[3]}px`);
}

// 从数据库加载访问日志。
async function loadAccessLogsFromDb() {
    try {
        const json = await fetchJsonSafe(`${LEDGER_API_BASE}/access-log/list?limit=${MAX_ACCESS_LOGS}`);
        if (!json || !json.ok || !Array.isArray(json.data)) return;
        accessLogs.length = 0;
        accessLogs.push(...json.data.slice(0, MAX_ACCESS_LOGS));
        renderAccessLogs();
    } catch (_) { }
}

// 保存单条访问日志到数据库。
async function saveAccessLogToDb(entry) {
    try {
        return await fetchJsonSafe(`${LEDGER_API_BASE}/access-log/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry)
        });
    } catch (_) {
        return null;
    }
}

// 为当前会话新增一条操作记录（每次改动独立一条，落库后可回看）。
async function addOperationRecord(opText) {
    const op = String(opText || '').trim();
    if (!op || !currentAccessSession || !currentAccessSession.code) return;
    const entry = {
        id: 0,
        time: formatLogDate(new Date()),
        device: detectDeviceLabel(),
        code: currentAccessSession.code,
        op
    };
    accessLogs.unshift(entry);
    if (accessLogs.length > MAX_ACCESS_LOGS) accessLogs.length = MAX_ACCESS_LOGS;
    renderAccessLogs();
    const saved = await saveAccessLogToDb(entry);
    entry.ip = saved && saved.ip ? String(saved.ip) : 'Unknown';
    if (saved && saved.ok && saved.id) {
        entry.id = Number(saved.id);
    }
    renderAccessLogs();
}

// 根据验证码新增一条访问记录。
async function addAccessRecordByCode(codeText) {
    const code = String(codeText || '').trim();
    if (!code) return;
    const entry = {
        id: 0,
        time: formatLogDate(new Date()),
        device: detectDeviceLabel(),
        code,
        op: getOpLabelFromCode(code)
    };
    accessLogs.unshift(entry);
    if (accessLogs.length > MAX_ACCESS_LOGS) accessLogs.length = MAX_ACCESS_LOGS;
    renderAccessLogs();
    const saved = await saveAccessLogToDb(entry);
    entry.ip = saved && saved.ip ? String(saved.ip) : 'Unknown';
    if (saved && saved.ok && saved.id) {
        entry.id = Number(saved.id);
    }
    currentAccessSession = { id: entry.id, code: code.toLowerCase() };
    renderAccessLogs();
}

renderAccessLogs();
loadAccessLogsFromDb();

// 显示 ActionRecords 删除最后10条确认弹层。
function showLogDeleteConfirm() {
    showConfirmLayer(logdeleteConfirmLayer);
}

// 关闭 ActionRecords 删除最后10条确认弹层。
function hideLogDeleteConfirm() {
    hideConfirmLayer(logdeleteConfirmLayer);
}


const logListEl = document.getElementById('logList');
if (logListEl) {
    logListEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('log-remove-btn')) {
            if (accessLogs.length === 0) return;
            showLogDeleteConfirm();
        }
        if (e.target.classList.contains('log-clear-btn')) {
            if (accessLogs.length === 0) return;
            if (isReadonlyMode()) return;
            accessLogs.length = 0;
            renderAccessLogs();
            fetchJsonSafe(`${LEDGER_API_BASE}/access-log/delete-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
        }
    });
}
if (logdeleteCancelBtn) {
    logdeleteCancelBtn.addEventListener('click', hideLogDeleteConfirm);
}
if (logdeleteConfirmBtn) {
    logdeleteConfirmBtn.addEventListener('click', async () => {
        if (isReadonlyMode()) {
            hideLogDeleteConfirm();
            return;
        }
        const count = Math.min(10, accessLogs.length);
        if (count <= 0) {
            hideLogDeleteConfirm();
            return;
        }
        const removed = accessLogs.splice(0, count);
        const ids = removed.map((item) => Number(item.id)).filter((id) => id > 0);
        renderAccessLogs();
        hideLogDeleteConfirm();
        if (ids.length > 0) {
            try {
                await fetchJsonSafe(`${LEDGER_API_BASE}/access-log/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids })
                });
            } catch (_) { }
        }
    });
}
if (logdeleteConfirmLayer) {
    logdeleteConfirmLayer.addEventListener('click', (e) => {
        if (e.target === logdeleteConfirmLayer) hideLogDeleteConfirm();
    });
}
const codeInputLayer = document.getElementById('codeInputLayer');
const codeInput = document.getElementById('codeInput');
const codeSubmitBtn = document.getElementById('codeSubmitBtn');
const codeError = document.getElementById('codeError');

function syncCodeSubmitBtn() {
    const wrap = document.getElementById('codeInputWrap');
    if (wrap) wrap.classList.toggle('ready', !!(codeInput && codeInput.value.trim()));
}

function showCodeVerifyDialog() {
    if (!codeInputLayer) return;
    if (codeInput) codeInput.value = '';
    if (codeError) codeError.style.display = 'none';
    syncCodeSubmitBtn();
    showConfirmLayer(codeInputLayer);
    requestAnimationFrame(() => {
        if (codeInput) codeInput.focus({ preventScroll: true });
    });
}

function hideCodeVerifyDialog() {
    hideConfirmLayer(codeInputLayer);
}

function submitCodeVerify() {
    if (!codeInput) return;
    const code = codeInput.value.trim();
    if (!code) return;
    if (code === '777') {
        hideCodeVerifyDialog();
        loadAccessLogsFromDb();
        openOverlay('logLayer');
    } else {
        if (codeError) codeError.style.display = 'block';
        codeInput.value = '';
        syncCodeSubmitBtn();
        codeInput.focus();
    }
}

if (codeInput) {
    codeInput.addEventListener('input', () => {
        if (codeError) codeError.style.display = 'none';
        syncCodeSubmitBtn();
    });
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitCodeVerify();
        }
    });
}
if (codeSubmitBtn) {
    codeSubmitBtn.addEventListener('click', submitCodeVerify);
}
if (codeInputLayer) {
    codeInputLayer.addEventListener('click', (e) => {
        if (e.target === codeInputLayer) hideCodeVerifyDialog();
    });
}

document.getElementById('openLogBtn').addEventListener('click', () => {
    showCodeVerifyDialog();
});

//#endregion

//#region 打印面板
const PRINT_CATS = [
    { key: 'cash', label: '现金', cls: 'p-1' },
    { key: 'check', label: '刷卡', cls: 'p-2' },
    { key: 'delivery', label: '外卖', cls: 'p-3' },
    { key: 'expense', label: '工资', cls: 'p-5' },
    { key: 'costTotal', label: '收支', cls: 'p-6' },
    { key: 'others', label: '其他', cls: 'p-4' },
];
let printMode = 'month';
let printPreviewYear = Number(currentYear);
let printYearSelection = new Set();
let printYearStartMonth = 0;
let printYearEndMonth = new Date().getMonth();
let printYearRanges = [];
let printTotalTemplateId = null;
let printSelectedCats = PRINT_CATS.map((c) => c.key);
const PRINT_MODULE_MAX_SAVED = 5;
const PRINT_MODULE_INSERTABLE_MAX_POSITION = 3;
const PRINT_CUSTOM_MODULE_KEY = '__custom_module__';
let printInsertableModules = [];
let printActiveModuleIds = [];
let printEnabledTableIds = [];
let printEnabledModuleIds = [];
let printSelectedTableIds = [];
let printTotalPagesCache = [];
let printPaperOrientation = 'portrait';   // 'portrait' | 'landscape'
let printPreviewRequestToken = 0;

const PRINT_A4_MM_TO_PX = 96 / 25.4;

function getPrintA4PageSpec(marginXmm = 6, marginYmm = marginXmm) {
    const isLandscape = printPaperOrientation === 'landscape';
    const pageWidthMm = isLandscape ? 297 : 210;
    const pageHeightMm = isLandscape ? 210 : 297;
    const pageWidthPx = Math.round(pageWidthMm * PRINT_A4_MM_TO_PX);
    const pageHeightPx = Math.round(pageHeightMm * PRINT_A4_MM_TO_PX);
    const marginXPx = Math.round(marginXmm * PRINT_A4_MM_TO_PX);
    const marginYPx = Math.round(marginYmm * PRINT_A4_MM_TO_PX);
    return {
        pageWidthMm,
        pageHeightMm,
        pageWidthPx,
        pageHeightPx,
        marginXPx,
        marginYPx,
        contentWidthPx: pageWidthPx - marginXPx * 2,
        contentHeightPx: pageHeightPx - marginYPx * 2,
        pageSize: `A4 ${isLandscape ? 'landscape' : 'portrait'}`,
    };
}

function buildPrintA4PageHtml(contentHtml, spec, pageBreak = false) {
    const pageBreakStyle = pageBreak ? 'page-break-after:always;break-after:page;' : '';
    return `<div class="print-page" style="width:${spec.pageWidthPx}px;height:${spec.pageHeightPx}px;padding:${spec.marginYPx}px ${spec.marginXPx}px;box-sizing:border-box;background:#fff;overflow:hidden;${pageBreakStyle}">${contentHtml}</div>`;
}

function buildPrintA4PreviewHtml(contentEl, pageHtml, spec) {
    const rect = contentEl.getBoundingClientRect();
    const scale = Math.min(
        Math.max(0.01, rect.width / spec.pageWidthPx),
        Math.max(0.01, rect.height / spec.pageHeightPx)
    );
    const width = Math.floor(spec.pageWidthPx * scale);
    const height = Math.floor(spec.pageHeightPx * scale);
    return `<div style="width:${width}px;height:${height}px;margin:auto;overflow:hidden;position:relative;"><div style="width:${spec.pageWidthPx}px;height:${spec.pageHeightPx}px;transform:scale(${scale});transform-origin:top left;">${pageHtml}</div></div>`;
}

let printPreviewCurrentPage = 1;
let printPreviewTotalPages = 1;
let printPageIndicatorHideTimer = null;   // 页码指示器自动隐藏定时器

// 保存打印偏好设置。
function savePrintPrefs() {
    queueAppPrefSave(APP_PREF_KEYS.PRINT, {
        cats: printSelectedCats,
        moduleIds: printActiveModuleIds.slice(),
        moduleId: printActiveModuleIds[0] || null,
        moduleActive: printActiveModuleIds.length > 0,
        enabledTableIds: printEnabledTableIds.slice(),
        enabledModuleIds: printEnabledModuleIds.slice(),
        selectedTableIds: printSelectedTableIds.slice(),
    });
}

// 规范化打印启用项 ID 列表。
function normalizePrintEnabledIdList(rawIds, allowedIds) {
    const allowed = new Set((Array.isArray(allowedIds) ? allowedIds : []).map((id) => Number(id)).filter((id) => id > 0));
    const source = Array.isArray(rawIds) ? rawIds : [];
    const unique = [];
    source.forEach((value) => {
        const id = Number(value) || 0;
        if (id > 0 && allowed.has(id) && !unique.includes(id)) unique.push(id);
    });
    return unique;
}

// 获取已启用的打印表格 ID。
function getPrintEnabledTableIds() {
    return printEnabledTableIds.slice();
}

// 获取已启用的打印模块 ID。
function getPrintEnabledModuleIds() {
    return printEnabledModuleIds.slice();
}

// 设置打印启用的表格与模块 ID。
function setPrintEnabledIds(tableIds, moduleIds) {
    printEnabledTableIds = Array.isArray(tableIds) ? tableIds.map((id) => Number(id) || 0).filter((id) => id > 0) : [];
    printEnabledModuleIds = Array.isArray(moduleIds) ? moduleIds.map((id) => Number(id) || 0).filter((id) => id > 0) : [];
    savePrintPrefs();
    Promise.resolve(refreshPrintInsertableModules()).then(() => {
        renderPrintContentButtons();
        if (printMode === 'total') renderPrintTotalTemplateButtons();
    }).catch(() => { });
}

// 确保指定打印项处于启用状态。
function ensurePrintEnabledItem(kind, id) {
    const numId = Number(id) || 0;
    if (numId <= 0) return;
    if (kind === 'table') {
        if (!printEnabledTableIds.includes(numId)) {
            printEnabledTableIds.push(numId);
            savePrintPrefs();
        }
        return;
    }
    if (kind === 'module' && !printEnabledModuleIds.includes(numId)) {
        printEnabledModuleIds.push(numId);
        savePrintPrefs();
    }
}

window.yybbqGetPrintEnabledTableIds = getPrintEnabledTableIds;
window.yybbqGetPrintEnabledModuleIds = getPrintEnabledModuleIds;
window.yybbqSetPrintEnabledIds = setPrintEnabledIds;
window.yybbqEnsurePrintEnabledItem = ensurePrintEnabledItem;

// 判断模块位置是否可插入打印坑位。
function isPrintInsertableModulePosition(position) {
    const pos = Number(position) || 0;
    return pos >= 1 && pos <= PRINT_MODULE_INSERTABLE_MAX_POSITION;
}

// 生成打印模块选择键。
function getPrintModuleKey(moduleId) {
    const id = Number(moduleId) || 0;
    return id > 0 ? `${PRINT_CUSTOM_MODULE_KEY}:${id}` : PRINT_CUSTOM_MODULE_KEY;
}

// 从选择键解析模块 ID。
function parsePrintModuleKey(key) {
    const raw = String(key || '');
    if (raw === PRINT_CUSTOM_MODULE_KEY) return printActiveModuleIds[0] || 0;
    if (!raw.startsWith(`${PRINT_CUSTOM_MODULE_KEY}:`)) return 0;
    return Number(raw.split(':')[1]) || 0;
}

// 判断键是否代表自定义模块占用。
function isPrintModuleOccupantKey(key) {
    const raw = String(key || '');
    return raw === PRINT_CUSTOM_MODULE_KEY || raw.startsWith(`${PRINT_CUSTOM_MODULE_KEY}:`);
}

// 获取已启用的可插入打印模块列表。
function getPrintEnabledModulesList() {
    const enabledSet = new Set(printEnabledModuleIds);
    return printInsertableModules.filter((item) => enabledSet.has(item.id));
}

// 规范化当前激活的打印模块 ID。
function normalizePrintActiveModuleIds(rawIds) {
    const allowed = new Set(getPrintEnabledModulesList().map((item) => item.id));
    const source = Array.isArray(rawIds) ? rawIds : (rawIds != null ? [rawIds] : []);
    const unique = [];
    source.forEach((value) => {
        const id = Number(value) || 0;
        if (id > 0 && allowed.has(id) && !unique.includes(id)) unique.push(id);
    });
    return unique;
}

// 计算打印面板可用模块槽位数。
function getPrintAvailableModuleSlots(selectedSet = new Set(printSelectedCats)) {
    const safeSet = selectedSet instanceof Set ? selectedSet : new Set(printSelectedCats);
    const emptyNamedPits = PRINT_NAMED_PIT_KEYS.filter((key) => !safeSet.has(key)).length;
    return Math.max(1, emptyNamedPits);
}

// 计算最多可选打印模块数。
function getPrintMaxSelectableModules(selectedSet = new Set(printSelectedCats)) {
    const insertableCount = getPrintEnabledModulesList().length;
    if (insertableCount <= 0) return 0;
    const available = getPrintAvailableModuleSlots(selectedSet);
    if (available >= insertableCount) return insertableCount;
    if (available >= PRINT_MODULE_INSERTABLE_MAX_POSITION) return PRINT_MODULE_INSERTABLE_MAX_POSITION;
    return 1;
}

// 将激活模块数同步到上限。
function syncPrintActiveModuleIdsToLimit(selectedSet = new Set(printSelectedCats)) {
    printActiveModuleIds = normalizePrintActiveModuleIds(printActiveModuleIds);
    const max = getPrintMaxSelectableModules(selectedSet);
    if (max <= 0) {
        printActiveModuleIds = [];
        return;
    }
    if (printActiveModuleIds.length > max) {
        printActiveModuleIds = printActiveModuleIds.slice(0, max);
    }
}

// 判断模块是否处于打印激活状态。
function isPrintModuleActive(moduleId) {
    const id = Number(moduleId) || 0;
    return id > 0 && printActiveModuleIds.includes(id);
}

// 切换打印模块选中状态。
function togglePrintModuleSelection(moduleId, selectedSet = new Set(printSelectedCats)) {
    const id = Number(moduleId) || 0;
    if (!id || !getPrintEnabledModulesList().some((item) => item.id === id)) return;
    syncPrintActiveModuleIdsToLimit(selectedSet);
    const max = getPrintMaxSelectableModules(selectedSet);
    if (max <= 0) return;
    const idx = printActiveModuleIds.indexOf(id);
    if (idx >= 0) {
        printActiveModuleIds.splice(idx, 1);
        return;
    }
    if (max <= 1) {
        printActiveModuleIds = [id];
        return;
    }
    if (printActiveModuleIds.length >= max) return;
    printActiveModuleIds.push(id);
}

// 构建打印模块快照对象。
function buildPrintModuleSnapshot(item) {
    const position = Number(item && item.position) || 0;
    const data = item && item.data && typeof item.data === 'object' ? item.data : {};
    const fallbackTitle = `模块 ${position || ''}`.trim();
    return {
        id: Number(item && item.id) || 0,
        position,
        title: String(data.title || fallbackTitle).trim() || fallbackTitle || '模块',
        data,
    };
}

// 获取所有激活模块的快照列表。
function getPrintActiveModuleSnapshots() {
    syncPrintActiveModuleIdsToLimit();
    return printActiveModuleIds
        .map((id) => printInsertableModules.find((item) => item.id === id))
        .filter(Boolean);
}

// 获取首个激活模块快照。
function getPrintActiveModuleSnapshot() {
    return getPrintActiveModuleSnapshots()[0] || null;
}

// 从后端刷新可插入打印模块列表。
async function refreshPrintInsertableModules() {
    try {
        const json = await fetchJsonSafe(`${LEDGER_API_BASE}/custom-module/list`);
        if (!json || !json.ok || !Array.isArray(json.data)) return;
        const allModules = json.data
            .sort((a, b) => (Number(a.position) - Number(b.position)) || (Number(a.id) - Number(b.id)))
            .map(buildPrintModuleSnapshot)
            .filter((item) => item.id > 0);
        printInsertableModules = allModules;
        const allModuleIds = allModules.map((item) => item.id);
        if (!printEnabledModuleIds.length) {
            printEnabledModuleIds = allModuleIds.slice();
        } else {
            printEnabledModuleIds = normalizePrintEnabledIdList(printEnabledModuleIds, allModuleIds);
            if (!printEnabledModuleIds.length && allModuleIds.length) printEnabledModuleIds = allModuleIds.slice();
        }
        const normalized = normalizePrintActiveModuleIds(printActiveModuleIds);
        if (normalized.length !== printActiveModuleIds.length
            || normalized.some((id, index) => id !== printActiveModuleIds[index])) {
            printActiveModuleIds = normalized;
            savePrintPrefs();
        }
        syncPrintActiveModuleIdsToLimit();
    } catch (_) { }
}

// 设置并保存激活的打印模块。
async function setPrintActiveModule(saved) {
    await refreshPrintInsertableModules();
    if (saved && saved.id && printEnabledModuleIds.includes(Number(saved.id))) {
        const id = Number(saved.id) || 0;
        const max = getPrintMaxSelectableModules();
        if (max <= 1) {
            printActiveModuleIds = id > 0 ? [id] : [];
        } else if (id > 0 && !printActiveModuleIds.includes(id) && printActiveModuleIds.length < max) {
            printActiveModuleIds.push(id);
        } else if (id > 0 && max <= 1) {
            printActiveModuleIds = [id];
        }
        syncPrintActiveModuleIdsToLimit();
    }
    savePrintPrefs();
    renderPrintContentButtons();
    updatePrintPreviewContent();
}

// 渲染自定义模块的打印预览 HTML。
function renderPrintCustomModule(widthPx, pitBoxH, scale, moduleId = null, context = null) {
    const id = Number(moduleId) || 0;
    const snapshot = id > 0
        ? printInsertableModules.find((item) => item.id === id)
        : getPrintActiveModuleSnapshot();
    if (!snapshot || !snapshot.data) return '';
    const renderer = window.yybbqRenderModuleInPit;
    if (typeof renderer !== 'function') return '';
    const resolvePayload = window.yybbqResolveModulePayloadForPrint;
    const payload = (typeof resolvePayload === 'function' && resolvePayload(id)) || snapshot.data;
    return renderer(payload, widthPx, scale, pitBoxH, context);
}

// 加载打印偏好设置。
async function loadPrintPrefs() {
    printMode = 'month';
    printPreviewYear = Number(currentYear);
    printYearSelection = new Set([Number(currentYear)]);
    printYearStartMonth = 0;
    printYearEndMonth = new Date().getMonth();
    printYearRanges = [];
    printInsertableModules = [];
    printActiveModuleIds = [];
    const prefs = await loadAppPref(APP_PREF_KEYS.PRINT);
    const source = prefs;
    await refreshPrintInsertableModules();
    if (!source || typeof source !== 'object') {
        printSelectedCats = PRINT_CATS.map((c) => c.key);
        return;
    }
    const cats = Array.isArray(source.cats) ? source.cats.filter((k) => PRINT_CATS.some((c) => c.key === k)) : [];
    printSelectedCats = cats.length ? cats : PRINT_CATS.map((c) => c.key);
    if (Array.isArray(source.moduleIds)) {
        printActiveModuleIds = normalizePrintActiveModuleIds(source.moduleIds);
    } else if (source.moduleActive && source.moduleId) {
        printActiveModuleIds = normalizePrintActiveModuleIds([source.moduleId]);
    } else {
        printActiveModuleIds = [];
    }
    if (Array.isArray(source.enabledModuleIds)) {
        printEnabledModuleIds = source.enabledModuleIds.map((id) => Number(id) || 0).filter((id) => id > 0);
    }
    if (Array.isArray(source.enabledTableIds)) {
        printEnabledTableIds = source.enabledTableIds.map((id) => Number(id) || 0).filter((id) => id > 0);
    }
    if (Array.isArray(source.selectedTableIds)) {
        printSelectedTableIds = source.selectedTableIds.map((id) => Number(id) || 0).filter((id) => id > 0);
    }
    syncPrintActiveModuleIdsToLimit();
}

// 深拷贝默认月度数据结构。
function cloneDefaultMonthData() {
    return JSON.parse(JSON.stringify(defaultMonthData));
}

// 规范化打印预览单月数据。
function normalizePrintPreviewMonthData(rawMonth, targetYear, monthIndex) {
    const fallbackMonth = Array.isArray(defaultMonthData) && defaultMonthData[monthIndex]
        ? JSON.parse(JSON.stringify(defaultMonthData[monthIndex]))
        : {};
    const clonedRaw = rawMonth && typeof rawMonth === 'object' ? JSON.parse(JSON.stringify(rawMonth)) : {};
    const data = Object.assign(fallbackMonth, clonedRaw);
    const dayCount = new Date(Number(targetYear) || Number(currentYear), monthIndex + 1, 0).getDate();
    data.cashDays = normalizeLedgerDayArray(data.cashDays, dayCount);
    data.checkDays = normalizeLedgerDayArray(data.checkDays, dayCount);
    data.costExpenses = Array.isArray(data.costExpenses) ? data.costExpenses : Array.from({ length: 8 }, () => ['', '']);
    data.costOthersExpenses = Array.isArray(data.costOthersExpenses) ? data.costOthersExpenses : Array.from({ length: 8 }, () => ['', '']);
    data.othersExpenses = Array.isArray(data.othersExpenses) ? data.othersExpenses : Array.from({ length: 8 }, () => ['', '']);
    data.costTotal = Number(data.costTotal) || 0;
    data.othersTotal = Number(data.othersTotal) || 0;
    data.expense = Number(data.expense) || 0;
    data.totalOverrides = data.totalOverrides || { Check: null, uber: null, riceball: null, panda: null, bm: null };
    data.deliveryDetails = data.deliveryDetails || { uber: [], riceball: [], panda: [], bm: [], dinein: [] };
    data.deliveryDetails.uber = Array.isArray(data.deliveryDetails.uber) ? data.deliveryDetails.uber : [];
    data.deliveryDetails.riceball = Array.isArray(data.deliveryDetails.riceball) ? data.deliveryDetails.riceball : [];
    data.deliveryDetails.panda = Array.isArray(data.deliveryDetails.panda) ? data.deliveryDetails.panda : [];
    data.deliveryDetails.bm = Array.isArray(data.deliveryDetails.bm) ? data.deliveryDetails.bm : [];
    data.deliveryDetails.dinein = Array.isArray(data.deliveryDetails.dinein) ? data.deliveryDetails.dinein : [];
    data.salesBreakdown = data.salesBreakdown || { Check: 0, cash: 0, cost: 0, uber: 0, riceball: 0, panda: 0, bm: 0 };
    data.salesBreakdown.uber = sumTextEntries(data.deliveryDetails.uber);
    data.salesBreakdown.riceball = sumTextEntries(data.deliveryDetails.riceball);
    data.salesBreakdown.panda = sumTextEntries(data.deliveryDetails.panda);
    data.salesBreakdown.bm = sumTextEntries(data.deliveryDetails.bm);
    data.salesBreakdown.Check = sumTextEntries(data.deliveryDetails.dinein);
    data.salesBreakdown.cash = sumLedgerDayArray(data.cashDays);
    data.salesBreakdown.cost = Number(data.salesBreakdown.cost) || 0;
    ['Check', 'uber', 'riceball', 'panda', 'bm'].forEach((key) => {
        const ov = data.totalOverrides[key];
        if (typeof ov === 'number' && ov !== 0 && Number.isFinite(ov)) data.salesBreakdown[key] = ov;
    });
    if (!Array.isArray(data.salaryRows)) data.salaryRows = [];
    while (data.salaryRows.length < 17) data.salaryRows.push(['', '', '']);
    return data;
}

// 规范化打印预览全年数据。
function normalizePrintPreviewYearData(months, targetYear) {
    const safeMonths = Array.isArray(months) ? months : [];
    return Array.from({ length: 12 }, (_, monthIndex) => normalizePrintPreviewMonthData(safeMonths[monthIndex], targetYear, monthIndex));
}

// 获取指定年份的打印预览数据。
async function fetchPrintPreviewYearData(year) {
    const targetYear = Number(year);
    if (!Number.isInteger(targetYear)) return cloneDefaultMonthData();
    if (targetYear === Number(currentYear) && Array.isArray(monthData) && monthData.length === 12) {
        return normalizePrintPreviewYearData(JSON.parse(JSON.stringify(monthData)), targetYear);
    }
    if (printPreviewYearCache.has(targetYear)) {
        return JSON.parse(JSON.stringify(printPreviewYearCache.get(targetYear)));
    }
    try {
        const json = await fetchJsonSafe(`${LEDGER_API_BASE}/ledger/load?year=${encodeURIComponent(targetYear)}`);
        const loaded = cloneDefaultMonthData();
        if (json && json.ok && Array.isArray(json.data) && json.data.length === 12) {
            for (let i = 0; i < 12; i++) if (json.data[i]) loaded[i] = json.data[i];
        }
        const normalized = normalizePrintPreviewYearData(loaded, targetYear);
        printPreviewYearCache.set(targetYear, JSON.parse(JSON.stringify(normalized)));
        return normalized;
    } catch (_) {
        const fallback = normalizePrintPreviewYearData(cloneDefaultMonthData(), targetYear);
        printPreviewYearCache.set(targetYear, JSON.parse(JSON.stringify(fallback)));
        return fallback;
    }
}

// 计算打印内容按钮槽位总数。
function getPrintContentButtonSlotCount() {
    return PRINT_CATS.length + 1 + getPrintEnabledModulesList().length;
}

// 获取打印分类键集合。
function getPrintContentCatKeySet() {
    return new Set(PRINT_CATS.map((cat) => cat.key));
}

// 同步打印模块按钮激活样式。
function syncPrintModuleButtonStates(wrap = document.getElementById('printContentButtons')) {
    if (!wrap) return;
    wrap.querySelectorAll('.print-content-btn[data-module-id]').forEach((btn) => {
        const moduleId = Number(btn.dataset.moduleId) || 0;
        btn.classList.toggle('active', isPrintModuleActive(moduleId));
    });
}

const PRINT_CONTROL_BTN_WIDTH = 72;
const PRINT_CONTROL_BTN_HEIGHT = 32;

// 应用打印内容按钮区布局变量。
function applyPrintContentButtonLayout(wrap) {
    if (!wrap) return;
    const slotCount = Math.max(1, getPrintContentButtonSlotCount());
    wrap.style.setProperty('--print-content-slot-count', String(slotCount));
    wrap.style.setProperty('--print-control-btn-width', `${PRINT_CONTROL_BTN_WIDTH}px`);
    wrap.style.setProperty('--print-control-btn-height', `${PRINT_CONTROL_BTN_HEIGHT}px`);
    wrap.dataset.slotCount = String(slotCount);
}

// 应用打印表格按钮区布局变量。
function applyPrintTableButtonLayout(wrap) {
    if (!wrap) return;
    const slotCount = Math.max(1, wrap.querySelectorAll('.print-content-btn[data-template-id]').length || 1);
    wrap.style.setProperty('--print-table-slot-count', String(slotCount));
    wrap.style.setProperty('--print-control-btn-width', `${PRINT_CONTROL_BTN_WIDTH}px`);
    wrap.style.setProperty('--print-control-btn-height', `${PRINT_CONTROL_BTN_HEIGHT}px`);
    wrap.dataset.slotCount = String(slotCount);
}

// 判断是否已选中全部打印分类。
function isAllPrintCatsSelected() {
    return PRINT_CATS.every((cat) => printSelectedCats.includes(cat.key));
}

// 同步打印「全部」按钮激活状态。
function syncPrintContentAllButton() {
    const wrap = document.getElementById('printContentButtons');
    if (!wrap) return;
    const allBtn = wrap.querySelector('.print-content-btn[data-key="__all__"]');
    if (allBtn) allBtn.classList.toggle('active', isAllPrintCatsSelected());
}

// 渲染打印内容选择按钮。
function renderPrintContentButtons() {
    const wrap = document.getElementById('printContentButtons');
    if (!wrap) return;
    syncPrintActiveModuleIdsToLimit();
    applyPrintContentButtonLayout(wrap);
    const catButtonsHtml = PRINT_CATS.map((cat) => {
        const active = printSelectedCats.includes(cat.key) ? ' active' : '';
        return `<button type="button" class="print-content-btn ${cat.cls}${active}" data-key="${cat.key}">${cat.label}</button>`;
    }).join('');
    const allActive = isAllPrintCatsSelected() ? ' active' : '';
    const moduleBtnHtml = getPrintEnabledModulesList().map((mod, index) => {
        const active = isPrintModuleActive(mod.id) ? ' active' : '';
        const label = escapeHtml(mod.title);
        const slot = Math.min(PRINT_MODULE_INSERTABLE_MAX_POSITION, (index % PRINT_MODULE_INSERTABLE_MAX_POSITION) + 1);
        return `<button type="button" class="print-content-btn p-module p-module-${slot}${active}" data-key="${getPrintModuleKey(mod.id)}" data-module-id="${mod.id}" title="${label}">${label}</button>`;
    }).join('');
    wrap.innerHTML = `${catButtonsHtml}${moduleBtnHtml}<button type="button" class="print-content-btn p-all${allActive}" data-key="__all__">全部</button>`;
    const printCatKeys = getPrintContentCatKeySet();
    wrap.querySelectorAll('.print-content-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (!key) return;
            if (key.startsWith(`${PRINT_CUSTOM_MODULE_KEY}:`)) {
                const moduleId = Number(key.split(':')[1]) || 0;
                if (!moduleId) return;
                togglePrintModuleSelection(moduleId);
                syncPrintModuleButtonStates(wrap);
                savePrintPrefs();
                updatePrintPreviewContent();
                return;
            }
            if (key === '__all__') {
                if (isAllPrintCatsSelected()) {
                    printSelectedCats = [];
                    wrap.querySelectorAll('.print-content-btn[data-key]').forEach((item) => {
                        if (printCatKeys.has(item.dataset.key)) item.classList.remove('active');
                    });
                    btn.classList.remove('active');
                } else {
                    printSelectedCats = PRINT_CATS.map((c) => c.key);
                    wrap.querySelectorAll('.print-content-btn[data-key]').forEach((item) => {
                        if (printCatKeys.has(item.dataset.key)) item.classList.add('active');
                    });
                    btn.classList.add('active');
                }
                syncPrintActiveModuleIdsToLimit();
                syncPrintModuleButtonStates(wrap);
                savePrintPrefs();
                updatePrintPreviewContent();
                return;
            }
            const next = new Set(printSelectedCats);
            if (next.has(key)) {
                next.delete(key);
                btn.classList.remove('active');
            } else {
                next.add(key);
                btn.classList.add('active');
            }
            printSelectedCats = PRINT_CATS.map((c) => c.key).filter((k) => next.has(k));
            syncPrintActiveModuleIdsToLimit();
            syncPrintModuleButtonStates(wrap);
            syncPrintContentAllButton();
            savePrintPrefs();
            updatePrintPreviewContent();
        });
    });
}

// 渲染打印年份多选按钮。
function renderPrintYearButtons(years) {
    const wrap = document.getElementById('printYearButtons');
    if (!wrap) return;
    wrap.innerHTML = years.map((year) => {
        const active = printYearSelection.has(Number(year)) ? ' active' : '';
        return `<button type="button" class="print-year-btn${active}" data-year="${year}">${year}</button>`;
    }).join('');
    wrap.querySelectorAll('.print-year-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const year = Number(btn.dataset.year);
            if (!Number.isInteger(year)) return;
            if (printYearSelection.has(year)) {
                printYearSelection.delete(year);
                btn.classList.remove('active');
            } else {
                printYearSelection.add(year);
                btn.classList.add('active');
            }
            savePrintPrefs();
        });
    });
}

// 判断打印表格是否被选中。
function isPrintTableSelected(templateId) {
    const id = Number(templateId) || 0;
    return id > 0 && printSelectedTableIds.includes(id);
}

// 切换打印表格选中状态。
function togglePrintTableSelection(templateId) {
    const id = Number(templateId) || 0;
    if (!id) return;
    const idx = printSelectedTableIds.indexOf(id);
    if (idx >= 0) {
        printSelectedTableIds.splice(idx, 1);
    } else {
        printSelectedTableIds.push(id);
    }
    savePrintPrefs();
}

// 筛选已启用的自定义表格模板。
function getPrintEnabledTemplates(templates) {
    const enabledSet = new Set(printEnabledTableIds);
    return templates.filter((item) => enabledSet.has(Number(item.id)));
}

// 渲染总报表模式的表格选择按钮。
async function renderPrintTotalTemplateButtons() {
    const wrap = document.getElementById('printYearButtons');
    if (!wrap) return;
    const api = window.__yybbqCustomTable;
    if (!api || typeof api.ensureLoaded !== 'function') {
        wrap.innerHTML = '<span class="tr-custom-status">自定义表格未就绪</span>';
        return;
    }
    try {
        await api.ensureLoaded();
    } catch (_) {
        wrap.innerHTML = '<span class="tr-custom-status">表格加载失败</span>';
        return;
    }
    const templates = Array.isArray(api.getTemplates?.()) ? api.getTemplates() : [];
    const allIds = templates.map((item) => Number(item.id)).filter((id) => id > 0);
    if (!printEnabledTableIds.length && allIds.length) {
        printEnabledTableIds = allIds.slice();
        savePrintPrefs();
    } else {
        printEnabledTableIds = normalizePrintEnabledIdList(printEnabledTableIds, allIds);
        if (!printEnabledTableIds.length && allIds.length) printEnabledTableIds = allIds.slice();
    }
    const enabledTemplates = getPrintEnabledTemplates(templates);
    if (!enabledTemplates.length) {
        printSelectedTableIds = [];
        wrap.innerHTML = '<span class="tr-custom-status">暂无表格</span>';
        return;
    }
    printSelectedTableIds = normalizePrintEnabledIdList(printSelectedTableIds, enabledTemplates.map((item) => item.id));
    if (!printSelectedTableIds.length) {
        printSelectedTableIds = [Number(enabledTemplates[0].id)];
        savePrintPrefs();
    }
    wrap.innerHTML = enabledTemplates.map((item, index) => {
        const active = isPrintTableSelected(item.id) ? ' active' : '';
        const label = typeof api.getTemplateTitle === 'function'
            ? api.getTemplateTitle(item.id)
            : `表格 ${item.index}`;
        const tone = `p-${(index % 6) + 1}`;
        return `<button type="button" class="print-content-btn ${tone}${active}" data-template-id="${item.id}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
    }).join('');
    wrap.querySelectorAll('.print-content-btn[data-template-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            togglePrintTableSelection(Number(btn.dataset.templateId) || 0);
            wrap.querySelectorAll('.print-content-btn[data-template-id]').forEach((item) => {
                item.classList.toggle('active', isPrintTableSelected(item.dataset.templateId));
            });
            updatePrintPreviewContent();
        });
    });
    applyPrintTableButtonLayout(wrap);
}

// 获取总报表模式选中的表格列表。
async function getPrintTotalTemplateSelections() {
    const api = window.__yybbqCustomTable;
    if (!api || typeof api.ensureLoaded !== 'function') return [];
    await api.ensureLoaded();
    const templates = getPrintEnabledTemplates(Array.isArray(api.getTemplates?.()) ? api.getTemplates() : []);
    if (!templates.length) return [];
    const selectedIds = printSelectedTableIds.length
        ? printSelectedTableIds.slice()
        : [Number(templates[0].id)];
    return selectedIds
        .map((id) => templates.find((item) => Number(item.id) === Number(id)))
        .filter(Boolean)
        .map((item) => ({
            meta: item,
            data: api.getTemplateById?.(item.id) || item.data || null,
            title: typeof api.getTemplateTitle === 'function' ? api.getTemplateTitle(item.id) : `自定义表格 ${item.index}`,
            renderPrintHtml: api.renderPrintHtml,
        }));
}

// 获取总报表模式首个选中表格。
async function getPrintTotalTemplateSelection() {
    const selections = await getPrintTotalTemplateSelections();
    return selections[0] || null;
}

// 规范化年报打印的年月范围输入。
function normalizePrintYearRangeInput(year, startMonth, endMonth) {
    const normalizedYear = Number(year);
    if (!Number.isInteger(normalizedYear) || normalizedYear < 2000 || normalizedYear > 2100) return null;
    let start = Math.max(0, Math.min(11, Number(startMonth) || 0));
    let end = Math.max(0, Math.min(11, Number(endMonth) || 0));
    if (end < start) end = start;
    return { year: normalizedYear, startMonth: start, endMonth: end };
}

// 比较两个年报打印范围。
function comparePrintYearRanges(a, b) {
    if (a.year !== b.year) return a.year - b.year;
    if (a.startMonth !== b.startMonth) return a.startMonth - b.startMonth;
    return a.endMonth - b.endMonth;
}

// 获取当前年报打印范围。
function getCurrentPrintYearRange() {
    return normalizePrintYearRangeInput(printPreviewYear, printYearStartMonth, printYearEndMonth);
}

// 格式化年报打印范围标签。
function formatPrintYearRangeLabel(range) {
    if (!range) return '';
    const startLabel = formatMonthAbbr(monthLabels[range.startMonth] || '');
    const endLabel = formatMonthAbbr(monthLabels[range.endMonth] || '');
    return range.startMonth === range.endMonth
        ? `${range.year}${startLabel}`
        : `${range.year}${startLabel}-${endLabel}`;
}

// 获取用户显式添加的年报范围列表。
function getExplicitPrintYearRanges() {
    return (Array.isArray(printYearRanges) ? printYearRanges : [])
        .map((range) => normalizePrintYearRangeInput(range?.year, range?.startMonth, range?.endMonth))
        .filter(Boolean)
        .sort(comparePrintYearRanges);
}

// 获取实际生效的年报范围列表。
function getEffectivePrintYearRanges() {
    const explicit = getExplicitPrintYearRanges();
    if (explicit.length) return explicit;
    const currentRange = getCurrentPrintYearRange();
    return currentRange ? [currentRange] : [];
}

// 将年报范围展开为年月条目。
function expandPrintYearRanges(ranges) {
    const seen = new Set();
    const entries = [];
    (Array.isArray(ranges) ? ranges : []).forEach((range) => {
        if (!range) return;
        for (let month = range.startMonth; month <= range.endMonth; month += 1) {
            const key = `${range.year}-${month}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({ year: range.year, month });
        }
    });
    entries.sort((a, b) => (a.year - b.year) || (a.month - b.month));
    return entries;
}

// 构建年报打印所需的年月数据条目。
async function buildPrintYearMonthEntries() {
    const ranges = getEffectivePrintYearRanges();
    const monthKeys = expandPrintYearRanges(ranges);
    if (!monthKeys.length) return [];
    const years = Array.from(new Set(monthKeys.map((item) => item.year))).sort((a, b) => a - b);
    const yearEntries = await Promise.all(years.map(async (year) => [year, await fetchPrintPreviewYearData(year)]));
    const yearMap = new Map(yearEntries.map(([year, months]) => [Number(year), Array.isArray(months) ? months : []]));
    return monthKeys.map((item) => ({
        year: item.year,
        month: item.month,
        data: yearMap.get(item.year)?.[item.month] || {}
    }));
}

// 渲染年报范围摘要展示。
function renderPrintYearRangeSummary() {
    const summaryEl = document.getElementById('printYearRangeSummary');
    if (!summaryEl) return;
    const ranges = getExplicitPrintYearRanges();
    if (printMode !== 'year' || !ranges.length) {
        summaryEl.style.display = 'none';
        summaryEl.innerHTML = '';
        return;
    }
    summaryEl.style.display = 'block';
    summaryEl.innerHTML = ranges.map((range, index) => {
        const label = escapeHtml(formatPrintYearRangeLabel(range));
        return `${index ? '<span class="print-range-summary-sep">,</span>' : ''}<span class="print-range-summary-item">${label}</span>`;
    }).join('');
}

// 将当前年月范围加入年报列表。
function addCurrentPrintYearRange() {
    const currentRange = getCurrentPrintYearRange();
    if (!currentRange) return;
    const exists = printYearRanges.some((range) => {
        const normalized = normalizePrintYearRangeInput(range?.year, range?.startMonth, range?.endMonth);
        return normalized
            && normalized.year === currentRange.year
            && normalized.startMonth === currentRange.startMonth
            && normalized.endMonth === currentRange.endMonth;
    });
    if (!exists) {
        printYearRanges.push(currentRange);
        printYearRanges.sort(comparePrintYearRanges);
    }
    renderPrintYearRangeSummary();
    updatePrintPreviewContent();
}

// 渲染年报起止月份下拉控件。
function renderPrintYearMonthRange() {
    const startSel = document.getElementById('printYearStartMonth');
    const endSel = document.getElementById('printYearEndMonth');
    if (!startSel || !endSel) return;

    const opts = monthLabels.map((label, idx) => `<option value="${idx}">${label}</option>`).join('');
    startSel.innerHTML = opts;
    endSel.innerHTML = opts;

    let start = Math.max(0, Math.min(11, printYearStartMonth));
    let end = Math.max(0, Math.min(11, printYearEndMonth));
    if (end < start) end = start;
    startSel.value = String(start);
    endSel.value = String(end);

    const onChange = () => {
        let s = Number(startSel.value) || 0;
        let e = Number(endSel.value) || 0;
        if (e < s) {
            e = s;
            endSel.value = String(e);
        }
        printYearStartMonth = s;
        printYearEndMonth = e;
        updatePrintPreviewContent();
    };
    startSel.onchange = onChange;
    endSel.onchange = onChange;
}

// 切换打印模式（月报/年报/总报表）。
function setPrintMode(mode) {
    printMode = mode === 'total' ? 'total' : (mode === 'year' ? 'year' : 'month');
    const monthBtn = document.getElementById('printModeMonthBtn');
    const yearBtn = document.getElementById('printModeYearBtn');
    const totalBtn = document.getElementById('printModeTotalBtn');
    const controls = document.getElementById('printControls');
    const yearField = document.getElementById('printYearField');
    const monthField = document.getElementById('printMonthField');
    const totalField = document.getElementById('printTotalField');

    if (monthBtn) {
        monthBtn.classList.toggle('active', printMode === 'month');
        monthBtn.setAttribute('aria-selected', printMode === 'month' ? 'true' : 'false');
    }
    if (yearBtn) {
        yearBtn.classList.toggle('active', printMode === 'year');
        yearBtn.setAttribute('aria-selected', printMode === 'year' ? 'true' : 'false');
    }
    if (totalBtn) {
        totalBtn.classList.toggle('active', printMode === 'total');
        totalBtn.setAttribute('aria-selected', printMode === 'total' ? 'true' : 'false');
    }
    if (controls) controls.setAttribute('data-mode', printMode);
    if (yearField) yearField.style.display = printMode === 'total' ? 'none' : '';
    if (monthField) monthField.style.display = printMode === 'month' ? '' : 'none';
    if (totalField) totalField.style.display = printMode === 'total' ? '' : 'none';

    const yearRangeField = document.getElementById('printYearMonthRange');
    if (yearRangeField) yearRangeField.style.display = (printMode === 'year') ? '' : 'none';

    if (printMode === 'year') {
        // 点击“打印年报”时默认：当前年份 + 1月 ~ 当前月份
        printPreviewYear = Number(currentYear);
        printYearStartMonth = 0;
        printYearEndMonth = Math.max(0, Math.min(11, currentMonth));

        const yearSelect = document.getElementById('printYearSelect');
        if (yearSelect) yearSelect.value = String(printPreviewYear);

        // 年报为纵向版式，默认纵向，不受前面页面横纵设置影响
        printPaperOrientation = 'portrait';
        const yearWrapper = document.getElementById('printPreviewWrapper');
        const yearOriSwitch = yearWrapper?.querySelector('.print-orientation-switch');
        if (yearOriSwitch) {
            yearOriSwitch.style.display = '';
            yearOriSwitch.querySelectorAll('.ori-btn').forEach((b) => b.classList.toggle('active', b.dataset.ori === 'portrait'));
        }
        const yearSheet = yearWrapper?.querySelector('.print-a4-sheet');
        if (yearWrapper && yearSheet) applyMaxA4Size(yearWrapper, yearSheet);

        // 渲染范围选择器并绑定事件
        renderPrintYearMonthRange();
    }
    if (printMode === 'total') {
        printPaperOrientation = 'portrait';
        const wrapper = document.getElementById('printPreviewWrapper');
        const oriSwitch = wrapper?.querySelector('.print-orientation-switch');
        if (oriSwitch) {
            oriSwitch.style.display = '';
            oriSwitch.querySelectorAll('.ori-btn').forEach((b) => b.classList.toggle('active', b.dataset.ori === 'portrait'));
        }
        renderPrintTotalTemplateButtons();
    } else {
        const wrapper = document.getElementById('printPreviewWrapper');
        const oriSwitch = wrapper?.querySelector('.print-orientation-switch');
        if (oriSwitch) oriSwitch.style.display = '';
    }
    renderPrintYearRangeSummary();
    updatePrintPreviewContent();  // 打印模式变化（月/年/全部）→ 即时更新预览
}

// 填充打印面板的年份与月份控件。
function populatePrintControls() {
    if (typeof printPreviewYear === 'undefined') {
        printPreviewYear = Number(currentYear);
    }

    const yearSelect = document.getElementById('printYearSelect');
    const monthSelect = document.getElementById('printMonthSelect');
    if (!yearSelect || !monthSelect) return;

    const years = (Array.isArray(ledgerYears) ? ledgerYears : []).concat(Number(currentYear));
    const uniq = Array.from(new Set(years)).filter(y => Number.isInteger(y) && y >= 2000 && y <= 2100).sort((a, b) => b - a);

    yearSelect.innerHTML = uniq.map((year) => `<option value="${year}">${year}</option>`).join('');
    monthSelect.innerHTML = monthLabels.map((label, index) => `<option value="${index}">${label}</option>`).join('');

    yearSelect.value = String(printPreviewYear || currentYear);
    monthSelect.value = String(currentMonth);

    renderPrintYearButtons(uniq);
    renderPrintContentButtons();
    setPrintMode(printMode);
}

const printModeMonthBtn = document.getElementById('printModeMonthBtn');
const printModeYearBtn = document.getElementById('printModeYearBtn');
const printModeTotalBtn = document.getElementById('printModeTotalBtn');
const printYearSelect = document.getElementById('printYearSelect');
const printMonthSelect = document.getElementById('printMonthSelect');
const printYearRangeAddBtn = document.getElementById('printYearRangeAddBtn');

if (printModeMonthBtn) printModeMonthBtn.addEventListener('click', () => setPrintMode('month'));
if (printModeYearBtn) printModeYearBtn.addEventListener('click', () => setPrintMode('year'));
if (printModeTotalBtn) printModeTotalBtn.addEventListener('click', () => setPrintMode('total'));
if (printYearRangeAddBtn) printYearRangeAddBtn.addEventListener('click', addCurrentPrintYearRange);

if (printYearSelect) printYearSelect.addEventListener('change', () => {
    printPreviewYear = Number(printYearSelect.value) || Number(currentYear);
    // 年报模式下切换年份时，智能默认月份范围
    if (printMode === 'year') {
        const y = Number(printPreviewYear);
        if (y === Number(currentYear)) {
            printYearStartMonth = 0;
            printYearEndMonth = Math.max(0, Math.min(11, currentMonth));
        } else {
            printYearStartMonth = 0;
            printYearEndMonth = 11;
        }
        renderPrintYearMonthRange();   // 刷新范围下拉
    }
    updatePrintPreviewContent();  // 年份变化 → 即时更新预览
});
if (printMonthSelect) printMonthSelect.addEventListener('change', () => {
    updatePrintPreviewContent();  // 月份变化 → 即时更新预览
});

document.addEventListener('yybbq-custom-table-updated', () => {
    if (printMode === 'total') {
        renderPrintTotalTemplateButtons();
        updatePrintPreviewContent();
    }
});

document.addEventListener('yybbq-custom-module-updated', () => {
    refreshPrintInsertableModules().then(() => {
        renderPrintContentButtons();
        const printLayer = document.getElementById('printLayer');
        if (printLayer && printLayer.classList.contains('active')) {
            updatePrintPreviewContent();
        }
    });
});

// 内容按钮点击已在 renderPrintContentButtons 内部绑定（切换选中并保存）
function previewBuildTableRows(rows, rowCount) {
    return Array.from({ length: rowCount }, (_, index) => {
        const row = Array.isArray(rows) && rows[index] ? rows[index] : ['', ''];
        return [String(row[0] || '').trim(), String(row[1] ?? '').replace(/\u00a0/g, ' ').trim()];
    });
}

// 判断表格是否存在有效内容。
function previewHasTableContent(rows) {
    if (!Array.isArray(rows)) return false;
    return rows.some((row) => {
        const name = String((Array.isArray(row) ? row[0] : '') || '').trim();
        const value = String((Array.isArray(row) ? row[1] : '') ?? '').replace(/\u00a0/g, ' ').trim();
        return name !== '' || value !== '';
    });
}

const PRINT_SUMMARY_ORDER_KEYS = null;

// 获取打印摘要行分类目录。
function getPrintSummaryCatalogCats() {
    if (Array.isArray(PRINT_SUMMARY_ORDER_KEYS) && PRINT_SUMMARY_ORDER_KEYS.length) {
        return PRINT_SUMMARY_ORDER_KEYS
            .map((key) => PRINT_CATS.find((cat) => cat.key === key))
            .filter(Boolean);
    }
    return PRINT_CATS.slice();
}

// 计算打印摘要行各槽位宽度。
function buildPrintSummaryLayout(innerW, summaryCount, gap, options) {
    const opts = options || {};
    const minItemW = Number.isFinite(opts.minItemW) ? opts.minItemW : 40;
    const safeCount = Math.max(1, Number(summaryCount) || 1);
    const summaryRowW = Math.max(120, Number(innerW) || 0);
    const gapTotal = gap * Math.max(0, safeCount - 1);
    const distributableW = Math.max(0, summaryRowW - gapTotal);
    const baseW = Math.max(minItemW, Math.floor(distributableW / safeCount));
    const remainder = distributableW - baseW * safeCount;
    const widths = Array.from({ length: safeCount }, (_, index) => baseW + (index < remainder ? 1 : 0));
    return { summaryRowW, widths, slotCount: safeCount };
}

// 构建打印摘要行完整布局（含模块槽位）。
function buildPrintSummaryRowLayout(innerW, gap, options) {
    const opts = options || {};
    const catalogCats = getPrintSummaryCatalogCats();
    const moduleMetas = Array.isArray(opts.moduleMetas) ? opts.moduleMetas : [];
    const moduleCount = moduleMetas.length;
    const slotCount = 1 + moduleCount + catalogCats.length;
    const layout = buildPrintSummaryLayout(innerW, slotCount, gap, Object.assign({ minItemW: 1 }, opts));
    return Object.assign({
        catalogCats,
        moduleMetas,
        moduleCount,
        moduleSlotStart: moduleCount > 0 ? 1 : -1,
        catalogSlotOffset: 1 + moduleCount,
    }, layout);
}

// 获取激活模块的摘要元数据列表。
function getPrintModuleSummaryMetas() {
    return getPrintActiveModuleSnapshots().map((snapshot) => {
        if (!snapshot || !snapshot.data) return null;
        const payload = snapshot.data;
        const totalFlags = (typeof window.yybbqResolveModuleTotalFlags === 'function')
            ? window.yybbqResolveModuleTotalFlags(payload)
            : { showTotalCol: payload.showTotal !== false, showTotalRow: payload.showTotal !== false };
        if (!totalFlags.showTotalCol && !totalFlags.showTotalRow) return null;
        const reader = window.yybbqGetModuleGrandTotal;
        const grandTotal = typeof reader === 'function' ? Number(reader(payload)) || 0 : 0;
        const title = String(snapshot.title || payload.title || '模块').trim() || '模块';
        return { id: snapshot.id, title, grandTotal };
    }).filter(Boolean);
}

// 获取首个激活模块摘要元数据。
function getPrintModuleSummaryMeta() {
    return getPrintModuleSummaryMetas()[0] || null;
}

const PRINT_NAMED_PIT_KEYS = ['cash', 'check', 'delivery', 'expense'];
const PRINT_PUBLIC_PIT_DEFAULT_KEYS = ['costTotal', 'others'];
const PRINT_NAMED_PIT_HEIGHT_KEYS = ['cash', 'check', 'delivery', 'expense'];

// 获取打印预留坑位键集合。
function getPrintReservedPitKeys() {
    return new Set([...PRINT_NAMED_PIT_KEYS, ...PRINT_PUBLIC_PIT_DEFAULT_KEYS]);
}

// 获取打印扩展分类键列表。
function getPrintExtensionKeys() {
    const reserved = getPrintReservedPitKeys();
    return PRINT_CATS.map((cat) => cat.key).filter((key) => !reserved.has(key));
}

// 获取打印分类元数据。
function getPrintCatMeta(key) {
    return PRINT_CATS.find((cat) => cat.key === key) || { key, label: key, cls: 'p-ext' };
}

// 分配打印五坑框架的占用槽位。
function allocatePrintStackSlots(selectedSet, options = {}) {
    const safeSet = selectedSet instanceof Set ? selectedSet : new Set();
    const extensionKeyList = getPrintExtensionKeys();
    let newcomers = extensionKeyList.filter((key) => safeSet.has(key));
    const moduleIds = Array.isArray(options.moduleIds)
        ? options.moduleIds.map((id) => Number(id) || 0).filter((id) => id > 0)
        : [];
    if (moduleIds.length > 0) {
        newcomers = [...moduleIds.map((id) => getPrintModuleKey(id)), ...newcomers];
    } else if (options.moduleActive) {
        const fallbackId = printActiveModuleIds[0] || 0;
        newcomers = [fallbackId > 0 ? getPrintModuleKey(fallbackId) : PRINT_CUSTOM_MODULE_KEY, ...newcomers];
    }
    const namedPits = PRINT_NAMED_PIT_KEYS.map((ownerKey) => ({
        ownerKey,
        occupantKey: safeSet.has(ownerKey) ? ownerKey : null,
    }));
    let newcomerIndex = 0;
    namedPits.forEach((pit) => {
        if (!pit.occupantKey && newcomerIndex < newcomers.length) {
            pit.occupantKey = newcomers[newcomerIndex];
            newcomerIndex += 1;
        }
    });
    const publicItems = [];
    PRINT_PUBLIC_PIT_DEFAULT_KEYS.forEach((key) => {
        if (safeSet.has(key)) publicItems.push(key);
    });
    while (newcomerIndex < newcomers.length) {
        publicItems.push(newcomers[newcomerIndex]);
        newcomerIndex += 1;
    }
    return { namedPits, publicItems };
}

// 计算 A 公共坑内部单元格布局。
function buildPublicPitCellLayouts(itemCount, outerW, outerH, gap) {
    const count = Math.max(0, Number(itemCount) || 0);
    const width = Math.max(0, Number(outerW) || 0);
    const height = Math.max(0, Number(outerH) || 0);
    const safeGap = Math.max(0, Number(gap) || 0);
    if (count === 0) return [];
    if (count === 1) return [{ x: 0, y: 0, w: width, h: height }];
    const halfW = Math.max(1, Math.floor((width - safeGap) / 2));
    const rightW = Math.max(1, width - halfW - safeGap);
    if (count === 2) {
        return [
            { x: 0, y: 0, w: halfW, h: height },
            { x: halfW + safeGap, y: 0, w: rightW, h: height },
        ];
    }
    const topH = Math.max(1, Math.floor((height - safeGap) / 2));
    const bottomH = Math.max(1, height - topH - safeGap);
    if (count === 3) {
        return [
            { x: 0, y: 0, w: halfW, h: topH },
            { x: halfW + safeGap, y: 0, w: rightW, h: topH },
            { x: 0, y: topH + safeGap, w: width, h: bottomH },
        ];
    }
    if (count === 4) {
        const halfH = Math.max(1, Math.floor((height - safeGap) / 2));
        const bottomCellH = Math.max(1, height - halfH - safeGap);
        return [
            { x: 0, y: 0, w: halfW, h: halfH },
            { x: halfW + safeGap, y: 0, w: rightW, h: halfH },
            { x: 0, y: halfH + safeGap, w: halfW, h: bottomCellH },
            { x: halfW + safeGap, y: halfH + safeGap, w: rightW, h: bottomCellH },
        ];
    }
    const cols = 2;
    const rows = Math.ceil(count / cols);
    const cellH = Math.max(1, Math.floor((height - safeGap * (rows - 1)) / rows));
    return Array.from({ length: count }, (_, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const y = row * (cellH + safeGap);
        const h = row === rows - 1 ? Math.max(1, height - y) : cellH;
        return {
            x: col === 0 ? 0 : halfW + safeGap,
            y,
            w: col === 0 ? halfW : rightW,
            h,
        };
    });
}

// 渲染扩展分类打印坑位块。
function renderPrintExtensionPitBlock(key, innerW, boxH, scale) {
    const meta = getPrintCatMeta(key);
    const titleFont = Math.max(6, Math.round(6.5 * scale));
    const bodyFont = Math.max(5, Math.round(6 * scale));
    const safeH = Math.max(0, Number(boxH) || 0);
    const safeW = Math.max(0, Number(innerW) || 0);
    const pad = Math.max(1, Math.round(1.5 * scale));
    return `<div class="preview-block preview-extension-pit" data-print-ext="${escapeHtml(key)}" style="width:${safeW}px;height:${safeH}px;min-height:${safeH}px;padding:${pad}px;box-sizing:border-box;"><div class="preview-block-title" style="font-size:${titleFont}px;">${escapeHtml(meta.label)}</div><div style="width:100%;height:${Math.max(0, safeH - titleFont - pad * 2)}px;display:flex;align-items:center;justify-content:center;font-size:${bodyFont}px;color:#666;">&nbsp;</div></div>`;
}

// 计算打印行内各单元格宽度。
function buildPrintRowItemWidths(contentW, itemCount, gap, minItemW = 12) {
    const safeCount = Math.max(1, Number(itemCount) || 1);
    const rowW = Math.max(0, Number(contentW) || 0);
    const gapTotal = gap * Math.max(0, safeCount - 1);
    const baseW = Math.floor((rowW - gapTotal) / safeCount);
    const remainder = rowW - gapTotal - baseW * safeCount;
    return Array.from({ length: safeCount }, (_, index) => {
        const width = baseW + (index < remainder ? 1 : 0);
        return Math.max(minItemW, width);
    });
}

// 计算打印预览表格展示行数。
function previewGetTableDisplayRowCount(rows, minRows = 1) {
    if (!Array.isArray(rows)) return Math.max(1, minRows);
    const filledRows = rows.filter((row) => {
        const name = String((Array.isArray(row) ? row[0] : '') || '').trim();
        const value = String((Array.isArray(row) ? row[1] : '') ?? '').replace(/\u00a0/g, ' ').trim();
        return name !== '' || value !== '';
    }).length;
    return Math.max(minRows, filledRows);
}

// 构建现金区打印预览行。
function previewBuildCashRows(values, dayCount) {
    const safeValues = Array.isArray(values) ? values : [];
    const renderRow = (startDay, endDay, slotCount, hiddenLastSlot) => {
        const cells = [];
        let total = 0;
        for (let slot = 0; slot < slotCount; slot++) {
            const day = startDay + slot;
            if (hiddenLastSlot && slot === slotCount - 1) {
                cells.push({ hidden: true, day: '', value: '' });
                continue;
            }
            if (day <= endDay) {
                const value = normalizeLedgerDayValue(safeValues[day - 1]);
                total += value === '' || value === 'off' ? 0 : Number(value);
                cells.push({ hidden: false, day, value: formatLedgerCellDisplay(value) || '' });
            } else {
                cells.push({ hidden: true, day: '', value: '' });
            }
        }
        return { cells, total: formatCategoryDisplay(total) || '' };
    };

    const firstEnd = Math.min(15, dayCount);
    const secondStart = Math.min(16, dayCount + 1);
    const rows = [renderRow(1, firstEnd, 16, true)];
    if (secondStart <= dayCount) rows.push(renderRow(secondStart, dayCount, 16, false));
    return rows;
}

// 构建刷卡区打印预览记录。
function previewBuildDineinRecords(records) {
    const safe = Array.isArray(records) ? records.slice(0, 30) : [];
    const parsed = safe.map((record) => {
        const text = String(record || '').trim();
        const parsedEntry = parseMiniDetailEntry(text);
        return {
            date: parsedEntry.date || '',
            amount: formatNonCashTextDisplay(parsedEntry.amount || parsedEntry.raw || ''),
        };
    });
    while (parsed.length < 30) {
        parsed.push({ date: '', amount: '' });
    }
    return parsed;
}

// 构建文本明细打印预览项。
function previewBuildTextItems(items) {
    const safe = Array.isArray(items) ? items.slice() : [];
    return safe.map((item) => formatNonCashEntryDisplay(item));
}

// 构建工资表打印预览矩阵。
function previewBuildSalaryMatrix(rows, firstRows, secondRows) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    let highestFilledIndex = -1;
    sourceRows.forEach((row, index) => {
        if (Array.isArray(row) && row.some((cell) => String(cell || '').replace(/\u00a0/g, '').trim() !== '')) {
            highestFilledIndex = index;
        }
    });
    const totalRows = Math.max(12, highestFilledIndex + 1);
    const visibleRows = Array.from({ length: totalRows }, (_, index) => Array.isArray(sourceRows[index]) ? sourceRows[index] : ['', '', '']);
    const safeFirst = Math.max(1, Number(firstRows) || 5);
    const safeSecond = Math.max(1, Number(secondRows) || 3);
    const firstEnd = Math.max(0, safeFirst - 1);
    const secondStart = Math.max(0, safeFirst);
    const secondEnd = Math.max(secondStart, safeFirst + safeSecond - 1);
    const sumRange = (start, end) => {
        let first = 0;
        let second = 0;
        for (let i = start; i <= end; i++) {
            const row = visibleRows[i] || [];
            first += Number(row[1]) || 0;
            second += Number(row[2]) || 0;
        }
        return { first, second, total: first + second };
    };
    const all = sumRange(0, visibleRows.length - 1);
    const kitchen = sumRange(0, firstEnd);
    const station = sumRange(secondStart, secondEnd);
    return { visibleRows, kitchen, station, all, totalRows: visibleRows.length };
}

// 刷新打印预览主体内容。
async function updatePrintPreviewContent() {
    const wrapper = document.getElementById('printPreviewWrapper');
    if (!wrapper) return;

    const content = wrapper.querySelector('#printPreviewContent');
    if (!content) return;

    const requestToken = ++printPreviewRequestToken;

    const orderedSelected = PRINT_CATS.slice();
    const selectedSet = new Set(printSelectedCats);
    const fixedCats = PRINT_CATS.slice();
    const targetYear = Number(printPreviewYear) || Number(currentYear);
    const targetMonth = printMode === 'month'
        ? (Number(document.getElementById('printMonthSelect')?.value) || 0)
        : Number(currentMonth) || 0;

    if (printMode === 'year') {
        const monthEntries = await buildPrintYearMonthEntries();
        if (requestToken !== printPreviewRequestToken) return;
        renderYearReportBatchPages(content, monthEntries, selectedSet, orderedSelected);
        return;
    }

    if (printMode === 'total') {
        const selections = await getPrintTotalTemplateSelections();
        if (requestToken !== printPreviewRequestToken) return;
        if (!selections.length || !selections.every((item) => item.data && typeof item.renderPrintHtml === 'function')) {
            content.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">暂无自定义表格</div>';
            printTotalPagesCache = [];
            printPreviewTotalPages = 1;
            updatePrintPreviewPage(1, true);
            return;
        }
        const rect = content.getBoundingClientRect();
        const previewWidthPx = Math.max(200, Math.floor(rect.width) || content.clientWidth || 392);
        const api = window.__yybbqCustomTable;
        const paginated = typeof api?.buildPaginatedPrintHtml === 'function'
            ? api.buildPaginatedPrintHtml(selections, { previewWidthPx, forPrint: false })
            : { pages: [selections.map((item) => item.renderPrintHtml(item.data, { title: item.title })).join('')], totalPages: 1 };
        printTotalPagesCache = Array.isArray(paginated.pages) ? paginated.pages : [String(paginated.pages || '')];
        printPreviewTotalPages = Math.max(1, Number(paginated.totalPages) || printTotalPagesCache.length || 1);
        if (printPreviewCurrentPage > printPreviewTotalPages) printPreviewCurrentPage = 1;
        const pageIndex = Math.max(0, Math.min(printPreviewCurrentPage - 1, printTotalPagesCache.length - 1));
        content.innerHTML = printTotalPagesCache[pageIndex] || '';
        updatePrintPreviewPage(printPreviewCurrentPage, true);
        const wrapper = document.getElementById('printPreviewWrapper');
        const sheet = wrapper?.querySelector('.print-a4-sheet');
        if (wrapper && sheet) applyMaxA4Size(wrapper, sheet);
        return;
    }

    const previewMonths = await fetchPrintPreviewYearData(targetYear);
    if (requestToken !== printPreviewRequestToken) return;

    const md = (Array.isArray(previewMonths) && previewMonths.length === 12)
        ? (previewMonths[targetMonth] || {})
        : {};

    const pageSpec = getPrintA4PageSpec();
    const monthHtml = renderOneMonthDetail(
        md,
        targetYear,
        targetMonth,
        selectedSet,
        orderedSelected,
        pageSpec.contentWidthPx,
        pageSpec.contentHeightPx
    );
    content.innerHTML = buildPrintA4PreviewHtml(content, buildPrintA4PageHtml(monthHtml, pageSpec), pageSpec);
    updatePrintPreviewPage(1, true);
    return;

    const sb = md.salesBreakdown || {};
    const deliveryDetails = md.deliveryDetails || {};
    const cash = Number(sb.cash) || 0;
    const check = Number(sb.Check) || 0;
    const delivery = (Number(sb.uber) || 0) + (Number(sb.riceball) || 0) + (Number(sb.panda) || 0) + (Number(sb.bm) || 0);
    const others = Number(sb.cost) || 0;
    const expense = Number(md.expense) || 0;
    const costTotal = Number(md.costTotal) || 0;
    const total = cash + check + delivery + others - expense - costTotal;
    const dayCount = new Date(targetYear, targetMonth + 1, 0).getDate();
    const summaryMap = { cash, check, delivery, others, expense, costTotal };

    const paperW = Math.max(240, content.clientWidth || 0);
    const paperH = Math.max(180, content.clientHeight || 0);
    const isLandscape = printPaperOrientation === 'landscape';
    const isPortrait = !isLandscape;
    const designW = isLandscape ? 560 : 392;
    const designH = isLandscape ? 382 : 554;
    const frameW = Math.max(220, Math.floor(paperW));
    const frameH = Math.max(160, Math.floor(paperH));
    const scale = Math.min((frameW - 10) / designW, (frameH - 10) / designH, 1.18);
    const gap = isPortrait ? Math.max(1, Math.round(2 * scale)) : Math.max(3, Math.round(4 * scale));
    const padY = 0;
    const padX = 0;
    const innerW = Math.max(80, frameW - padX * 2);
    const innerH = Math.max(80, frameH - padY * 2);
    const titleH = isPortrait ? Math.max(14, Math.round(16 * scale)) : Math.max(17, Math.round(19 * scale));
    const summaryH = isPortrait ? Math.max(16, Math.round(18 * scale)) : Math.max(20, Math.round(24 * scale));
    const blockPadV = isPortrait ? Math.max(1, Math.round(1.5 * scale)) : Math.max(2, Math.round(2.5 * scale));
    const blockPadH = isPortrait ? Math.max(2, Math.round(3 * scale)) : Math.max(4, Math.round(6 * scale));
    const blockTitleH = isPortrait ? Math.max(8, Math.round(9 * scale)) : Math.max(11, Math.round(12 * scale));
    const blockTitleGap = Math.max(1, Math.round(2 * scale));
    const blockInnerSlack = 0;
    const dayFont = isPortrait ? Math.max(4, Math.round(4.6 * scale)) : Math.max(6, Math.round(6.6 * scale));
    const numFont = isPortrait ? Math.max(5, Math.round(6.2 * scale)) : Math.max(7, Math.round(9 * scale));
    const cashNumFont = isPortrait ? Math.max(4, Math.round(5.4 * scale)) : Math.max(6, Math.round(7.6 * scale));
    const cashTotalFont = isPortrait ? Math.max(5, Math.round(6.4 * scale)) : Math.max(7, Math.round(8.6 * scale));
    const smallFont = isPortrait ? Math.max(5, Math.round(5.8 * scale)) : Math.max(7, Math.round(8 * scale));
    const titleFont = isPortrait ? Math.max(9, Math.round(11 * scale)) : Math.max(12, Math.round(15 * scale));
    const summaryLabelFont = isPortrait ? Math.max(5, Math.round(5.8 * scale)) : Math.max(8, Math.round(9 * scale));
    const summaryValueFont = isPortrait ? Math.max(5, Math.round(6.2 * scale)) : Math.max(8, Math.round(10 * scale));
    const hasBottomBlock =
        (selectedSet.has('costTotal') && previewHasTableContent(md.costExpenses)) ||
        (selectedSet.has('others') && previewHasTableContent(md.othersExpenses));

    const activeBlockRatios = [
        selectedSet.has('cash') ? { key: 'cash', ratio: 74 } : null,
        selectedSet.has('check') ? { key: 'check', ratio: 138 } : null,
        selectedSet.has('delivery') ? { key: 'delivery', ratio: 112 } : null,
        selectedSet.has('expense') ? { key: 'expense', ratio: 90 } : null,
        hasBottomBlock ? { key: 'bottom', ratio: 78 } : null,
    ].filter(Boolean);

    const blockRatios = activeBlockRatios.length > 0
        ? activeBlockRatios
        : [{ key: 'cash', ratio: 1 }];

    const totalRatio = blockRatios.reduce((acc, item) => acc + item.ratio, 0) || 1;
    const remainingH = Math.max(40, innerH - titleH - summaryH - gap * (blockRatios.length + 1));
    const heights = {};
    let usedH = 0;
    blockRatios.forEach((item, index) => {
        const h = index === blockRatios.length - 1
            ? (remainingH - usedH)
            : Math.max(32, Math.floor(remainingH * item.ratio / totalRatio));
        heights[item.key] = h;
        usedH += h;
    });

    const summaryCount = 1 + fixedCats.length;
    const summaryLayout = buildPrintSummaryLayout(innerW, summaryCount, gap);
    const summaryRowW = summaryLayout.summaryRowW;
    const summaryWidths = summaryLayout.widths;

    const titleText = printMode === 'month'
        ? `${escapeHtml(String(targetYear))} ${escapeHtml(monthLabels[targetMonth] || '')}`
        : (printMode === 'year' ? `${escapeHtml(String(targetYear))} YEAR` : 'TOTAL REPORT');

    const summaryHtml = [`
                <div class="report-summary-item total" style="width:${summaryWidths[0]}px; min-width:${summaryWidths[0]}px; padding:${isPortrait ? '3px 2px' : '2px 7px'}; gap:${isPortrait ? 2 : 8}px;">
                    <div class="label" style="font-size:${summaryLabelFont}px;">总计</div>
                    <div class="value" style="font-size:${summaryValueFont}px;">${escapeHtml(formatCategoryDisplay(total) || '')}</div>
                </div>
            `].concat(fixedCats.map((cat, catIndex) => `
                <div class="report-summary-item" style="width:${summaryWidths[catIndex + 1]}px; min-width:${summaryWidths[catIndex + 1]}px; padding:${isPortrait ? '1px 2px' : '2px 7px'}; gap:${isPortrait ? 2 : 8}px; ${selectedSet.has(cat.key) && !(cat.key === 'others' && !previewHasTableContent(md.othersExpenses)) ? '' : 'display:none;'}">
                    <div class="label" style="font-size:${summaryLabelFont}px;">${escapeHtml(cat.label)}</div>
                    <div class="value" style="font-size:${summaryValueFont}px;">${escapeHtml(formatCategoryDisplay(summaryMap[cat.key]) || '') || '&nbsp;'}</div>
                </div>
            `)).join('');

    let stackHtml = '';
    const renderHiddenBlock = (boxH) => `<div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; border-color:transparent; background:transparent;"></div>`;

    if (selectedSet.has('cash')) {
        const boxH = heights.cash || 0;
        const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
        const cashBodyH = isPortrait ? bodyH : Math.max(10, Math.floor(bodyH * 0.84));
        const cashRows = previewBuildCashRows(md.cashDays, dayCount);
        const rowGap = cashRows.length > 1 ? Math.max(1, Math.round(2 * scale)) : 0;
        const cashRowH = Math.max(10, Math.floor((cashBodyH - rowGap) / cashRows.length));
        const cellGap = Math.max(2, Math.round(3 * scale));
        const totalLabelW = Math.max(12, Math.round(16 * scale));
        const totalCellW = Math.max(34, Math.round(48 * scale));
        const dayBoxW = Math.max(12, Math.floor((innerW - blockPadH * 2 - totalLabelW - totalCellW - cellGap * 17) / 16));
        const dayRowHtml = cashRows.map((row) => {
            const cells = row.cells.map((cell) => `
                        <div class="preview-day-box${isPortrait ? ' portrait' : ''}${cell.hidden ? ' preview-hidden-slot' : ''}" style="width:${dayBoxW}px; min-width:${dayBoxW}px; height:${cashRowH}px; padding:${isPortrait ? '1px 1px' : '0 2px'}; column-gap:${Math.max(1, Math.round(1 * scale))}px; row-gap:${isPortrait ? 1 : 0}px;">
                            <span class="day" style="font-size:${dayFont}px; min-width:${Math.max(5, Math.round(7 * scale))}px;">${cell.hidden ? '&nbsp;' : escapeHtml(String(cell.day))}</span>
                            <strong class="amt" style="font-size:${cashNumFont}px;">${cell.hidden ? '&nbsp;' : escapeHtml(cell.value)}</strong>
                        </div>
                    `).join('');
            return `
                        <div class="preview-cash-row" style="height:${cashRowH}px; gap:${cellGap}px;">
                            ${cells}
                            <div class="preview-cash-total-label" style="width:${totalLabelW}px; min-width:${totalLabelW}px; font-size:${Math.max(12, Math.round(16 * scale))}px;">T</div>
                            <div class="preview-day-box" style="width:${totalCellW}px; min-width:${totalCellW}px; height:${cashRowH}px; display:flex; align-items:center; justify-content:center;">
                                <strong class="amt" style="font-size:${cashTotalFont}px;">${escapeHtml(row.total)}</strong>
                            </div>
                        </div>
                    `;
        }).join('');

        stackHtml += `
                        <div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;">
                            <div class="preview-block-title" style="font-size:${Math.max(8, Math.round(9 * scale))}px;">现金</div>
                        <div class="preview-cash-grid" style="gap:${rowGap}px; height:${cashBodyH}px;">
                            ${dayRowHtml}
                        </div>
                    </div>
                `;
    }

    if (selectedSet.has('check')) {
        const boxH = heights.check || 0;
        const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
        const records = previewBuildDineinRecords(deliveryDetails.dinein);
        const cols = 6;
        const rowsNeeded = 5;
        const cellGapX = Math.max(3, Math.round(5 * scale));
        const cellGapY = Math.max(3, Math.round(4 * scale));
        const checkRowSlack = Math.max(isPortrait ? 0 : 1, Math.round(1 * scale));
        const cellW = Math.max(34, Math.floor((innerW - blockPadH * 2 - checkRowSlack - cellGapX * (cols - 1)) / cols));
        const cellH = Math.max(10, Math.floor((bodyH - cellGapY * (rowsNeeded - 1)) / rowsNeeded));
        const rowsHtml = Array.from({ length: rowsNeeded }, (_, rowIndex) => {
            const cells = Array.from({ length: cols }, (_, colIndex) => {
                const item = records[rowIndex * cols + colIndex] || { date: '', amount: '' };
                const isEmpty = !item.date && !item.amount;
                return `
                            <div class="preview-check-cell${isEmpty ? ' preview-empty' : ''}" style="width:${cellW}px; min-width:${cellW}px; height:${cellH}px; column-gap:${Math.max(2, Math.round(3 * scale))}px; font-size:${smallFont}px;">
                                <span class="date" style="font-size:${smallFont}px;">${escapeHtml(item.date || '') || '&nbsp;'}</span>
                                <strong class="amt" style="font-size:${numFont}px;">${escapeHtml(item.amount || '') || '&nbsp;'}</strong>
                            </div>
                        `;
            }).join('');
            return `<div class="preview-check-row" style="height:${cellH}px; gap:${cellGapX}px; margin-bottom:${rowIndex === rowsNeeded - 1 ? 0 : cellGapY}px;">${cells}</div>`;
        }).join('');

        stackHtml += `
                    <div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;">
                        <div class="preview-block-title" style="font-size:${Math.max(8, Math.round(9 * scale))}px;">刷卡</div>
                        <div class="preview-check-grid" style="height:${bodyH}px;">${rowsHtml}</div>
                    </div>
                `;
    }

    if (selectedSet.has('delivery')) {
        const boxH = heights.delivery || 0;
        const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
        const quadGapX = gap;
        const quadGapY = gap;
        const quadOuterPad = 10;
        const deliveryContentW = innerW - blockPadH * 2;
        const deliveryRowSlack = isPortrait ? Math.max(6, Math.round(8 * scale)) : 0;
        const quadW = Math.max(48, Math.floor((deliveryContentW - quadGapX - deliveryRowSlack) / 2));
        const quadH = Math.max(18, Math.floor((bodyH - quadGapY) / 2));
        const deliveryCols = 4;
        const renderDeliveryBox = (label, items) => {
            const titleH2 = Math.max(12, Math.round(14 * scale));
            const bodyH2 = Math.max(8, quadH - titleH2 - 3);
            const itemGapX = Math.max(2, Math.round(3 * scale));
            const itemGapY = Math.max(1, Math.round(2 * scale));
            const itemW = Math.max(18, Math.floor((quadW - quadOuterPad - itemGapX * (deliveryCols - 1)) / deliveryCols));
            const safeItems = previewBuildTextItems(items);
            const rowsNeeded = 2;
            const itemH = Math.max(7, Math.floor((bodyH2 - itemGapY * (rowsNeeded - 1)) / rowsNeeded));
            const totalSlots = rowsNeeded * deliveryCols;
            const paddedItems = safeItems.slice(0, totalSlots);
            while (paddedItems.length < totalSlots) paddedItems.push('');
            const itemHtml = paddedItems.map((item) => `
                        <div class="preview-delivery-item${!item ? ' preview-empty' : ''}" style="width:${itemW}px; min-width:${itemW}px; height:${itemH}px; font-size:${smallFont}px;">${escapeHtml(item) || '&nbsp;'}</div>
                    `).join('');
            return `
                        <div class="preview-delivery-box" style="width:${quadW}px; height:${quadH}px; min-width:${quadW}px; min-height:${quadH}px;">
                            <div class="preview-delivery-title" style="font-size:${isPortrait ? Math.max(5, Math.round(6 * scale)) : Math.max(7, Math.round(8 * scale))}px;">${label}</div>
                            <div class="preview-delivery-items" style="grid-template-columns:repeat(${deliveryCols}, ${itemW}px); gap:${itemGapY}px ${itemGapX}px; height:${bodyH2}px;">${itemHtml}</div>
                        </div>
                    `;
        };
        stackHtml += `
                    <div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;">
                        <div class="preview-block-title" style="font-size:${isPortrait ? Math.max(6, Math.round(7 * scale)) : Math.max(8, Math.round(9 * scale))}px;">外卖平台</div>
                        <div class="preview-delivery-grid" style="grid-template-columns:${quadW}px ${quadW}px; grid-auto-rows:${quadH}px; gap:${quadGapY}px ${quadGapX}px; height:${bodyH}px;">
                            ${renderDeliveryBox('Uber', deliveryDetails.uber)}
                            ${renderDeliveryBox('饭团', deliveryDetails.riceball)}
                            ${renderDeliveryBox('熊猫', deliveryDetails.panda)}
                            ${renderDeliveryBox('BM', deliveryDetails.bm)}
                        </div>
                    </div>
                `;
    }

    if (selectedSet.has('expense')) {
        const boxH = heights.expense || 0;
        const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
        const salaryLayout = previewBuildSalaryMatrix(md.salaryRows, md.salarySectionFirstRows, md.salarySectionSecondRows);
        const leadW = Math.max(24, Math.round(34 * scale));
        const tailW = isPortrait ? Math.max(24, Math.round(30 * scale)) : Math.max(28, Math.round(42 * scale));
        const salaryTailCols = isPortrait ? 1 : 3;
        const personCount = Math.max(12, Number(salaryLayout.totalRows) || 12);
        const personW = Math.max(12, Math.floor((innerW - blockPadH * 2 - leadW - salaryTailCols * tailW) / personCount));
        const salaryTableH = Math.max(8, bodyH - 4);
        const rowH = Math.max(7, Math.floor((salaryTableH - 3) / 4));
        const fmt = (n) => escapeHtml(formatCategoryDisplay(n) || '') || '&nbsp;';
        const fmtCell = (value) => escapeHtml(formatNonCashTextDisplay(value) || '') || '&nbsp;';
        const personCols = Array.from({ length: personCount }, () => `<col style="width:${personW}px;">`).join('');
        const cellsText = (getter) => salaryLayout.visibleRows.map((row, index) => `<td>${escapeHtml(getter(row, index) || '') || '&nbsp;'}</td>`).join('');
        const cellsMoney = (getter) => salaryLayout.visibleRows.map((row, index) => `<td>${fmtCell(getter(row, index))}</td>`).join('');

        stackHtml += `
                    <div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;">
                        <div class="preview-block-title" style="font-size:${isPortrait ? Math.max(6, Math.round(7 * scale)) : Math.max(8, Math.round(9 * scale))}px;">工资</div>
                        <div class="preview-salary-wrap" style="height:${salaryTableH}px; padding-bottom:3px;">
                            <table class="preview-salary-table" style="height:${salaryTableH}px; font-size:${smallFont}px;">
                                <colgroup>
                                    <col style="width:${leadW}px;">
                                    ${personCols}
                                    <col style="width:${tailW}px;">
                                </colgroup>
                                <tbody>
                                    ${isPortrait
                ? `<tr style="height:${rowH}px;"><th>name</th>${cellsText((row) => row[0])}<th>Total</th></tr>
                                           <tr style="height:${rowH}px;"><th>上半月</th>${cellsMoney((row) => row[1])}<td>${fmt(salaryLayout.all.first)}</td></tr>
                                           <tr style="height:${rowH}px;"><th>下半月</th>${cellsMoney((row) => row[2])}<td>${fmt(salaryLayout.all.second)}</td></tr>
                                           <tr style="height:${rowH}px;"><th>备注</th>${cellsText(() => '')}<td>${fmt(salaryLayout.all.total)}</td></tr>`
                : `<tr style="height:${rowH}px;"><th>name</th>${cellsText((row) => row[0])}<th>后厨</th><th>起台</th><th>Total</th></tr>
                                           <tr style="height:${rowH}px;"><th>上半月</th>${cellsMoney((row) => row[1])}<td>${fmt(salaryLayout.kitchen.first)}</td><td>${fmt(salaryLayout.station.first)}</td><td>${fmt(salaryLayout.all.first)}</td></tr>
                                           <tr style="height:${rowH}px;"><th>下半月</th>${cellsMoney((row) => row[2])}<td>${fmt(salaryLayout.kitchen.second)}</td><td>${fmt(salaryLayout.station.second)}</td><td>${fmt(salaryLayout.all.second)}</td></tr>
                                           <tr style="height:${rowH}px;"><th>备注</th>${cellsText(() => '')}<td>${fmt(salaryLayout.kitchen.total)}</td><td>${fmt(salaryLayout.station.total)}</td><td>${fmt(salaryLayout.all.total)}</td></tr>`}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
    }

    if (selectedSet.has('costTotal') || selectedSet.has('others')) {
        const boxH = heights.bottom || 0;
        const bottomTitleH = Math.max(8, Math.round(9 * scale));
        const bottomTitleGap = 1;
        const bodyH = Math.max(10, boxH - blockPadV * 2 - bottomTitleH - bottomTitleGap);
        const gapX = gap;
        const showCostTotal = selectedSet.has('costTotal');
        const showOthers = selectedSet.has('others');
        const both = showCostTotal && showOthers;
        const halfW = Math.max(54, Math.floor((innerW - gapX) / 2));
        const fullW = innerW;
        const boxBodyH = bodyH;
        const renderMoneyBox = (label, rows, widthPx) => {
            const rowCount = previewGetTableDisplayRowCount(rows, 1);
            const items = previewBuildTableRows(rows, rowCount);
            const headW = Math.max(18, Math.round(22 * scale));
            const amtW = Math.max(32, Math.round(40 * scale));
            const innerBoxW = Math.max(40, widthPx - blockPadH * 2);
            const nameW = Math.max(28, innerBoxW - headW - amtW - 2);
            const normalRows = 5;
            const rowH = Math.max(6, Math.floor(boxBodyH / normalRows));
            const tableH = Math.max(rowH, Math.min(boxBodyH, rowH * rowCount));
            const compactBoxH = blockPadV * 2 + bottomTitleH + bottomTitleGap + tableH;
            const finalBoxH = rowCount === 1 ? compactBoxH : boxH;
            const tableRows = items.map((row, index) => `
                        <tr style="height:${rowH}px;"><td style="text-align:left; padding-left:2px;">${index + 1}</td><td>${escapeHtml(row[0]) || '&nbsp;'}</td><td>${escapeHtml(formatNonCashTextDisplay(row[1]) || '') || '&nbsp;'}</td></tr>
                    `).join('');
            return `
                        <div class="preview-block" style="width:${widthPx}px; height:${finalBoxH}px; min-width:${widthPx}px; min-height:${finalBoxH}px; padding:${blockPadV}px ${blockPadH}px;">
                            <div class="preview-block-title" style="font-size:${isPortrait ? Math.max(6, Math.round(6.5 * scale)) : Math.max(7, Math.round(8 * scale))}px; line-height:${bottomTitleH}px;">${label}</div>
                            <table class="preview-money-table" style="height:${tableH}px; font-size:${isPortrait ? Math.max(5, smallFont - 1) : Math.max(6, smallFont - 1)}px;">
                                <colgroup>
                                    <col style="width:${headW}px;">
                                    <col style="width:${nameW}px;">
                                    <col style="width:${amtW}px;">
                                </colgroup>
                                <tbody>${tableRows}</tbody>
                            </table>
                        </div>
                    `;
        };

        const bottomChildren = [];
        if (showCostTotal && showOthers) {
            bottomChildren.push(renderMoneyBox('收支', md.costExpenses, halfW));
            bottomChildren.push(renderMoneyBox('其他', md.othersExpenses, halfW));
            stackHtml += `<div class="preview-bottom-row" style="width:${innerW}px; grid-template-columns:${halfW}px ${halfW}px; column-gap:${gapX}px;">${bottomChildren.join('')}</div>`;
        } else if (showCostTotal) {
            bottomChildren.push(renderMoneyBox('收支', md.costExpenses, fullW));
            stackHtml += `<div class="preview-bottom-row" style="width:${innerW}px; grid-template-columns:${fullW}px; column-gap:${gapX}px;">${bottomChildren.join('')}</div>`;
        } else if (showOthers) {
            bottomChildren.push(renderMoneyBox('其他', md.othersExpenses, fullW));
            stackHtml += `<div class="preview-bottom-row" style="width:${innerW}px; grid-template-columns:${fullW}px; column-gap:${gapX}px;">${bottomChildren.join('')}</div>`;
        }
    }

    content.innerHTML = `
                <div class="report-container" style="width:${frameW}px; height:${frameH}px; margin:0 auto; padding:${padY}px ${padX}px; gap:${gap}px;">
                    <div class="report-header" style="width:${summaryRowW}px; min-width:${summaryRowW}px; height:${titleH}px;">
                        <div class="report-title" style="width:${summaryRowW}px; font-size:${titleFont}px; line-height:${titleH}px;">${titleText}</div>
                    </div>
                    <div class="report-summary" style="width:${summaryRowW}px; min-width:${summaryRowW}px; gap:${gap}px;">
                        ${summaryHtml}
                    </div>
                    <div class="report-stack" style="width:${innerW}px; min-width:${innerW}px; gap:${gap}px;">
                        ${stackHtml}
                    </div>
                </div>
            `;
}

// 渲染单月打印预览详情页 HTML。
function renderOneMonthDetail(md, targetYear, monthIndex, selectedSet, orderedSelected, wrapW, wrapH, options) {
    const opts = options || {};
    const sb = md.salesBreakdown || {};
    const deliveryDetails = md.deliveryDetails || {};
    const cashTotal = (md.cashDays || []).reduce((a, b) => a + (Number(b) || 0), 0);
    const checkTotal = Number(sb.Check) || 0;
    const deliveryTotal = (Number(sb.uber) || 0) + (Number(sb.riceball) || 0) + (Number(sb.panda) || 0) + (Number(sb.bm) || 0);
    const othersTotal = Number(md.othersTotal) || 0;
    const expenseTotal = Number(md.expense) || 0;
    const costTotal = Number(md.costTotal) || 0;
    const total = cashTotal + checkTotal + deliveryTotal + othersTotal - expenseTotal - costTotal;
    const dayCount = new Date(Number(targetYear), monthIndex + 1, 0).getDate();
    const summaryMap = { cash: cashTotal, check: checkTotal, delivery: deliveryTotal, others: othersTotal, expense: expenseTotal, costTotal };

    const isPortrait = printPaperOrientation !== 'landscape';
    const safeWrapH = Math.max(120, Number(wrapH) || 554);
    const blockRatios = [
        { key: 'cash', ratio: 74 },
        { key: 'check', ratio: 138 },
        { key: 'delivery', ratio: 112 },
        { key: 'expense', ratio: 90 },
        { key: 'bottom', ratio: 78 },
    ];
    const fullStackRatio = 492;
    const designH = Math.max(120, Math.round(34 + 520));
    const scale = Math.min(wrapW / 392, safeWrapH / designH);
    const gap = Math.max(1, Math.round(2 * scale));
    const padY = 0;
    const padX = 0;
    const widthNudge = Math.max(0, Number(opts.widthNudge) || 0);
    const innerW = Math.max(80, wrapW - padX * 2 - widthNudge);
    const titleH = Math.max(14, Math.round(16 * scale));
    const summaryH = Math.max(16, Math.round(18 * scale));
    const blockPadV = Math.max(1, Math.round(1.5 * scale));
    const blockPadH = Math.max(2, Math.round(3 * scale));
    const blockTitleH = Math.max(8, Math.round(9 * scale));
    const blockTitleGap = Math.max(1, Math.round(2 * scale));
    const blockInnerSlack = 0;
    const labelFont = 11;
    const contentFont = 10;
    const titleFont = Math.max(9, Math.round(9 * scale));
    const summaryLabelFont = 11;
    const summaryValueFont = 11;
    const totalRatio = fullStackRatio;
    const remainingH = Math.max(40, safeWrapH - titleH - summaryH - gap * (blockRatios.length + 1) - 2);
    const heights = {};
    let usedH = 0;
    blockRatios.forEach((item, index) => {
        const h = index === blockRatios.length - 1
            ? (remainingH - usedH)
            : Math.max(32, Math.floor(remainingH * item.ratio / totalRatio));
        heights[item.key] = h;
        usedH += h;
    });

    const moduleSummaryMetas = getPrintModuleSummaryMetas();
    const summaryLayout = buildPrintSummaryRowLayout(innerW, gap, {
        moduleMetas: moduleSummaryMetas,
    });
    const summaryCatalogCats = summaryLayout.catalogCats;
    const summaryRowW = summaryLayout.summaryRowW;
    const summaryWidths = summaryLayout.widths;
    const catalogSlotOffset = summaryLayout.catalogSlotOffset || 1;

    const titleText = `${escapeHtml(String(targetYear))} ${escapeHtml(monthLabels[monthIndex] || '')}`;

    const summaryParts = [`
                <div class="report-summary-item total" style="width:${summaryWidths[0]}px; min-width:${summaryWidths[0]}px; max-width:${summaryWidths[0]}px; padding:1px 2px; gap:2px;">
                    <div class="label" style="font-size:${summaryLabelFont}px;">总计</div>
                    <div class="value" style="font-size:${summaryValueFont}px;">${escapeHtml(formatCategoryDisplay(total) || '')}</div>
                </div>
            `];
    moduleSummaryMetas.forEach((moduleSummaryMeta, moduleIndex) => {
        const moduleSlot = (summaryLayout.moduleSlotStart >= 0 ? summaryLayout.moduleSlotStart : 1) + moduleIndex;
        const moduleW = summaryWidths[moduleSlot];
        if (!moduleW) return;
        summaryParts.push(`
                    <div class="report-summary-item tr-module-summary-item" style="width:${moduleW}px; min-width:${moduleW}px; max-width:${moduleW}px; padding:1px 2px; gap:2px;">
                        <div class="label" style="font-size:${summaryLabelFont}px;">${escapeHtml(moduleSummaryMeta.title)}</div>
                        <div class="value" style="font-size:${summaryValueFont}px;">${escapeHtml(formatCategoryDisplay(moduleSummaryMeta.grandTotal) || '') || '&nbsp;'}</div>
                    </div>
                `);
    });
    summaryCatalogCats.forEach((cat, catIndex) => {
        if (!selectedSet.has(cat.key)) return;
        const slotW = summaryWidths[catIndex + catalogSlotOffset];
        summaryParts.push(`
                <div class="report-summary-item" style="width:${slotW}px; min-width:${slotW}px; max-width:${slotW}px; padding:1px 2px; gap:2px;">
                    <div class="label" style="font-size:${summaryLabelFont}px;">${escapeHtml(cat.label)}</div>
                    <div class="value" style="font-size:${summaryValueFont}px;">${escapeHtml(formatCategoryDisplay(summaryMap[cat.key]) || '') || '&nbsp;'}</div>
                </div>
            `);
    });
    const summaryHtml = summaryParts.join('');

    let stackHtml = '';
    const stackPlan = allocatePrintStackSlots(selectedSet, {
        moduleIds: printActiveModuleIds.slice(),
    });

    const blockContentW = innerW - blockPadH * 2;
    const blockContentEdgeSlack = Math.max(1, Math.round(1.5 * scale));
    const usableBlockContentW = blockContentW - blockContentEdgeSlack;
    const cashLayoutGap = Math.max(2, Math.round(3 * scale));
    const cashTotalLabelW = isPortrait
        ? Math.max(7, Math.round(9 * scale))
        : Math.max(12, Math.round(16 * scale));
    const cashTotalCellW = isPortrait
        ? Math.max(22, Math.round(28 * scale))
        : Math.max(34, Math.round(48 * scale));
    const cashDayAreaW = Math.max(192, usableBlockContentW - cashTotalLabelW - cashTotalCellW - cashLayoutGap * 17);
    const cashDayBoxWidths = buildPrintRowItemWidths(cashDayAreaW, 16, 0, 12);
    const cashRowW = cashDayBoxWidths.reduce((sum, width) => sum + width, 0)
        + cashLayoutGap * 17
        + cashTotalLabelW
        + cashTotalCellW;
    const blockContentRightInset = Math.max(blockContentEdgeSlack, blockContentW - cashRowW);

    const renderMoneyBoxInPit = (label, rows, widthPx, pitBoxH) => {
        const bottomTitleH = Math.max(8, Math.round(9 * scale));
        const titleLineH = Math.ceil(labelFont * 1.1);
        const bodyH = Math.max(10, pitBoxH - blockPadV * 2 - Math.max(bottomTitleH, titleLineH) - 1);
        const rowCount = previewGetTableDisplayRowCount(rows, 1);
        const items = previewBuildTableRows(rows, rowCount);
        const headW = Math.max(18, Math.round(22 * scale));
        const amtW = Math.max(32, Math.round(40 * scale));
        const innerBoxW = Math.max(40, widthPx - blockPadH * 2);
        const nameW = Math.max(28, innerBoxW - headW - amtW - 2);
        const normalRows = 5;
        const rH = Math.max(6, Math.floor(bodyH / normalRows));
        const rowH = rowCount > normalRows ? Math.max(4, Math.floor(bodyH / rowCount)) : rH;
        const tableH = rowCount * rowH;
        const moneyTableClass = 'preview-money-table';
        const tableRows = items.map((row, index) => `<tr style="height:${rowH}px;"><td style="font-size:${labelFont}px;">${index + 1}</td><td style="font-size:${contentFont}px;">${escapeHtml(row[0]) || '&nbsp;'}</td><td style="font-size:${contentFont}px;">${escapeHtml(formatNonCashTextDisplay(row[1]) || '') || '&nbsp;'}</td></tr>`).join('');
        return `<div class="preview-block" style="width:${widthPx}px; height:${pitBoxH}px; min-width:${widthPx}px; min-height:${pitBoxH}px; padding:${blockPadV}px ${blockPadH}px; box-sizing:border-box;"><div class="preview-block-title" style="font-size:${labelFont}px;">${label}</div><table class="${moneyTableClass}" style="height:${tableH}px; font-size:${contentFont}px;"><colgroup><col style="width:${headW}px;"><col style="width:${nameW}px;"><col style="width:${amtW}px;"></colgroup><tbody>${tableRows}</tbody></table></div>`;
    };

    const modulePrintContext = { year: Number(targetYear), month: Number(monthIndex) };

    const renderPublicPitItem = (itemKey, cellW, cellH) => {
        if (isPrintModuleOccupantKey(itemKey)) return renderPrintCustomModule(cellW, cellH, scale, parsePrintModuleKey(itemKey), modulePrintContext);
        if (itemKey === 'costTotal') return renderMoneyBoxInPit('收支', md.costExpenses, cellW, cellH);
        if (itemKey === 'others') return renderMoneyBoxInPit('其他', md.othersExpenses, cellW, cellH);
        return renderPrintExtensionPitBlock(itemKey, cellW, cellH, scale);
    };

    const renderNamedOccupant = (occupantKey, boxH) => {
        if (!occupantKey) return '';
        if (isPrintModuleOccupantKey(occupantKey)) {
            return renderPrintCustomModule(innerW, boxH, scale, parsePrintModuleKey(occupantKey), modulePrintContext);
        }
        if (occupantKey === 'cash') {
            const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
            const cashRows = previewBuildCashRows(md.cashDays, dayCount);
            const rowGap = cashRows.length > 1 ? Math.max(1, Math.round(2 * scale)) : 0;
            const cashInnerBottomSlack = Math.max(1, Math.round(1 * scale));
            const cashRowH = Math.max(10, Math.floor((bodyH - rowGap - cashInnerBottomSlack) / cashRows.length));
            const cellGap = Math.max(2, Math.round(3 * scale));
            const totalLabelW = cashTotalLabelW;
            const totalCellW = cashTotalCellW;
            const dayRowHtml = cashRows.map((row) => {
                const cells = row.cells.map((cell, cellIndex) => {
                    const dayBoxW = cashDayBoxWidths[cellIndex] || cashDayBoxWidths[0];
                    return `
                        <div class="preview-day-box${isPortrait ? ' portrait' : ''}${cell.hidden ? ' preview-hidden-slot' : ''}" style="width:${dayBoxW}px; min-width:${dayBoxW}px; height:${cashRowH}px; padding:1px 1px; column-gap:${Math.max(1, Math.round(1 * scale))}px; row-gap:1px;">
                            <span class="day" style="font-size:${labelFont}px; min-width:${Math.max(5, Math.round(7 * scale))}px;">${cell.hidden ? '&nbsp;' : escapeHtml(String(cell.day))}</span>
                            <strong class="amt" style="font-size:${contentFont}px;">${cell.hidden ? '&nbsp;' : escapeHtml(cell.value)}</strong>
                        </div>
                    `;
                }).join('');
                return `<div class="preview-cash-row" style="width:${cashRowW}px; min-width:${cashRowW}px; height:${cashRowH}px; gap:${cellGap}px;">${cells}<div class="preview-cash-total-label" style="width:${totalLabelW}px; min-width:${totalLabelW}px; font-size:${labelFont}px;">T</div><div class="preview-day-box" style="width:${totalCellW}px; min-width:${totalCellW}px; height:${cashRowH}px; padding:${isPortrait ? '0 2px' : '0 4px'}; display:flex; align-items:center; justify-content:center;"><strong class="amt" style="font-size:${contentFont}px;">${escapeHtml(row.total)}</strong></div></div>`;
            }).join('');
            return `<div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;"><div class="preview-block-title" style="font-size:${labelFont}px;">现金</div><div class="preview-cash-grid" style="gap:${rowGap}px; height:${bodyH}px; padding-bottom:${cashInnerBottomSlack}px; box-sizing:border-box;">${dayRowHtml}</div></div>`;
        }
        if (occupantKey === 'check') {
            const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
            const records = previewBuildDineinRecords(deliveryDetails.dinein);
            const cols = 6;
            const rowsNeeded = 5;
            const checkInnerSlack = Math.max(1, Math.round(0.75 * scale));
            const checkRowW = usableBlockContentW - checkInnerSlack;
            const cellGapX = Math.max(2, Math.round(3 * scale));
            const cellGapY = Math.max(3, Math.round(4 * scale));
            const checkCellWidths = buildPrintRowItemWidths(checkRowW, cols, cellGapX, 34);
            const cellH = Math.max(10, Math.floor((bodyH - cellGapY * (rowsNeeded - 1)) / rowsNeeded) - 1);
            const rowsHtml = Array.from({ length: rowsNeeded }, (_, rowIndex) => {
                const cells = Array.from({ length: cols }, (_, colIndex) => {
                    const item = records[rowIndex * cols + colIndex] || { date: '', amount: '' };
                    const isEmpty = !item.date && !item.amount;
                    const cellW = checkCellWidths[colIndex] || checkCellWidths[0];
                    return `<div class="preview-check-cell${isEmpty ? ' preview-empty' : ''}" style="width:${cellW}px; min-width:${cellW}px; height:${cellH}px; column-gap:${Math.max(2, Math.round(3 * scale))}px; font-size:${contentFont}px;"><span class="date" style="font-size:${labelFont}px;">${escapeHtml(item.date || '') || '&nbsp;'}</span><strong class="amt" style="font-size:${contentFont}px;">${escapeHtml(item.amount || '') || '&nbsp;'}</strong></div>`;
                }).join('');
                return `<div class="preview-check-row" style="width:${checkRowW}px; min-width:${checkRowW}px; height:${cellH}px; gap:${cellGapX}px; margin-bottom:${rowIndex === rowsNeeded - 1 ? 0 : cellGapY}px;">${cells}</div>`;
            }).join('');
            return `<div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;"><div class="preview-block-title" style="font-size:${labelFont}px;">刷卡</div><div class="preview-check-grid" style="width:${blockContentW}px; min-width:${blockContentW}px; height:${bodyH}px;">${rowsHtml}</div></div>`;
        }
        if (occupantKey === 'delivery') {
            const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
            const quadGapX = gap;
            const quadGapY = gap;
            const deliveryRowW = usableBlockContentW;
            const quadLayout = buildPrintSummaryLayout(deliveryRowW, 2, quadGapX);
            const quadWidths = quadLayout.widths;
            const quadH = Math.max(18, Math.floor((bodyH - quadGapY) / 2));
            const deliveryCols = 4;
            const renderDeliveryBox = (label, items, boxW) => {
                const titleH2 = Math.max(12, Math.round(14 * scale));
                const bodyH2 = Math.max(8, quadH - titleH2 - 3);
                const itemGapX = Math.max(2, Math.round(3 * scale));
                const itemGapY = 0;
                const quadInnerW = Math.max(32, boxW - 8);
                const itemWidths = buildPrintRowItemWidths(quadInnerW, deliveryCols, itemGapX, 18);
                const itemCols = itemWidths.map((width) => `${width}px`).join(' ');
                const safeItems = previewBuildTextItems(items);
                const rowsN = 2;
                const itemH = Math.max(7, Math.floor((bodyH2 - itemGapY * (rowsN - 1)) / rowsN));
                const totalSlots = rowsN * deliveryCols;
                const paddedItems = safeItems.slice(0, totalSlots);
                while (paddedItems.length < totalSlots) paddedItems.push('');
                const itemHtml = paddedItems.map((item, itemIndex) => {
                    const itemW = itemWidths[itemIndex % deliveryCols] || itemWidths[0];
                    if (!item) {
                        return `<div class="preview-delivery-item preview-empty" style="width:${itemW}px; min-width:${itemW}px; height:${itemH}px; font-size:${contentFont}px; line-height:1.02;">&nbsp;</div>`;
                    }
                    const parsed = parseMiniDetailEntry(item);
                    const amountText = formatNonCashTextDisplay(parsed.amount || parsed.raw || '');
                    const inner = parsed.date ? `<span>${escapeHtml(parsed.date)}</span><strong>${escapeHtml(amountText) || '&nbsp;'}</strong>` : escapeHtml(amountText || item);
                    return `<div class="preview-delivery-item" style="width:${itemW}px; min-width:${itemW}px; height:${itemH}px; font-size:${contentFont}px; line-height:1.02;">${inner}</div>`;
                }).join('');
                return `<div class="preview-delivery-box" style="width:${boxW}px; height:${quadH}px; min-width:${boxW}px; min-height:${quadH}px;"><div class="preview-delivery-title" style="font-size:${labelFont}px;">${label}</div><div class="preview-delivery-items" style="width:${quadInnerW}px; min-width:${quadInnerW}px; grid-template-columns:${itemCols}; gap:${itemGapY}px ${itemGapX}px; height:${bodyH2}px;">${itemHtml}</div></div>`;
            };
            return `<div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;"><div class="preview-block-title" style="font-size:${labelFont}px;">外卖平台</div><div class="preview-delivery-grid" style="width:${blockContentW}px; min-width:${blockContentW}px; grid-template-columns:${quadWidths[0]}px ${quadWidths[1]}px; grid-auto-rows:${quadH}px; gap:${quadGapY}px ${quadGapX}px; height:${bodyH}px;">${renderDeliveryBox('Uber', deliveryDetails.uber, quadWidths[0])}${renderDeliveryBox('饭团', deliveryDetails.riceball, quadWidths[1])}${renderDeliveryBox('熊猫', deliveryDetails.panda, quadWidths[0])}${renderDeliveryBox('BM', deliveryDetails.bm, quadWidths[1])}</div></div>`;
        }
        if (occupantKey === 'expense') {
            const bodyH = Math.max(10, boxH - blockPadV * 2 - blockTitleH - blockTitleGap - blockInnerSlack);
            const salaryLayout = previewBuildSalaryMatrix(md.salaryRows, md.salarySectionFirstRows, md.salarySectionSecondRows);
            const leadW = Math.max(24, Math.round(34 * scale));
            const tailW = Math.max(24, Math.round(30 * scale));
            const personCount = Math.max(12, Number(salaryLayout.totalRows) || 12);
            const personW = Math.max(11, Math.floor((innerW - blockPadH * 2 - leadW - tailW) / personCount) - 1);
            const salaryTableH = Math.max(8, bodyH - 4);
            const rowH = Math.max(7, Math.floor((salaryTableH - 3) / 4));
            const fmt = (n) => escapeHtml(formatCategoryDisplay(n) || '') || '&nbsp;';
            const fmtCell = (value) => escapeHtml(formatNonCashTextDisplay(value) || '') || '&nbsp;';
            const personCols = Array.from({ length: personCount }, () => `<col style="width:${personW}px;">`).join('');
            const cellsText = (getter) => salaryLayout.visibleRows.map((row, index) => `<td style="font-size:${contentFont}px;">${escapeHtml(getter(row, index) || '') || '&nbsp;'}</td>`).join('');
            const cellsMoney = (getter) => salaryLayout.visibleRows.map((row, index) => `<td style="font-size:${contentFont}px;">${fmtCell(getter(row, index))}</td>`).join('');
            return `<div class="preview-block" style="width:${innerW}px; height:${boxH}px; min-height:${boxH}px; padding:${blockPadV}px ${blockPadH}px;"><div class="preview-block-title" style="font-size:${labelFont}px;">工资</div><div class="preview-salary-wrap" style="height:${salaryTableH}px; padding-bottom:3px;"><table class="preview-salary-table" style="height:${salaryTableH}px; font-size:${contentFont}px;"><colgroup><col style="width:${leadW}px;">${personCols}<col style="width:${tailW}px;"></colgroup><tbody><tr style="height:${rowH}px;"><th style="font-size:${labelFont}px;">name</th>${cellsText((row) => row[0])}<th style="font-size:${labelFont}px;">Total</th></tr><tr style="height:${rowH}px;"><th style="font-size:${labelFont}px;">上半月</th>${cellsMoney((row) => row[1])}<td style="font-size:${contentFont}px;">${fmt(salaryLayout.all.first)}</td></tr><tr style="height:${rowH}px;"><th style="font-size:${labelFont}px;">下半月</th>${cellsMoney((row) => row[2])}<td style="font-size:${contentFont}px;">${fmt(salaryLayout.all.second)}</td></tr><tr style="height:${rowH}px;"><th style="font-size:${labelFont}px;">备注</th>${cellsText(() => '')}<td style="font-size:${contentFont}px;">${fmt(salaryLayout.all.total)}</td></tr></tbody></table></div></div>`;
        }
        return renderPrintExtensionPitBlock(occupantKey, innerW, boxH, scale);
    };

    stackPlan.namedPits.forEach((pit, index) => {
        if (!pit.occupantKey) return;
        const pitBoxH = heights[PRINT_NAMED_PIT_HEIGHT_KEYS[index]] || 0;
        stackHtml += renderNamedOccupant(pit.occupantKey, pitBoxH);
    });

    const publicBoxH = heights.bottom || 0;
    if (stackPlan.publicItems.length > 0) {
        const publicLayouts = buildPublicPitCellLayouts(stackPlan.publicItems.length, innerW, publicBoxH, gap);
        const publicCellsHtml = stackPlan.publicItems.map((itemKey, itemIndex) => {
            const cell = publicLayouts[itemIndex];
            if (!cell) return '';
            return `<div class="preview-public-pit-cell" style="position:absolute;left:${cell.x}px;top:${cell.y}px;width:${cell.w}px;height:${cell.h}px;box-sizing:border-box;">${renderPublicPitItem(itemKey, cell.w, cell.h)}</div>`;
        }).join('');
        stackHtml += `<div class="preview-public-pit" style="position:relative;width:${innerW}px;height:${publicBoxH}px;min-height:${publicBoxH}px;flex-shrink:0;">${publicCellsHtml}</div>`;
    }

    const containerH = Math.max(120, safeWrapH);

    return `
                <div class="report-container" style="width:${wrapW}px; height:${containerH}px; padding:${padY}px ${padX}px; gap:${gap}px; box-sizing:border-box; background:#fff; overflow:hidden;">
                    <div class="report-header" style="width:${summaryRowW}px; min-width:${summaryRowW}px; height:${titleH}px;">
                        <div class="report-title" style="width:${summaryRowW}px; font-size:${titleFont}px; line-height:${titleH}px;">${titleText}</div>
                    </div>
                    <div class="report-summary" style="width:${summaryRowW}px; min-width:${summaryRowW}px; gap:${gap}px;">${summaryHtml}</div>
                    <div class="report-stack" style="width:${innerW}px; min-width:${innerW}px; gap:${gap}px;">${stackHtml}</div>
                </div>
            `;
}

// 计算年报模式每页月份数。
function getYearMonthsPerPage(selectedCount) {
    if (selectedCount >= 4) return 1;
    if (selectedCount === 3) return 2;
    return 3;
}

// 渲染年报模式分页预览内容。
function renderYearReportBatchPages(contentEl, monthEntries, selectedSet, orderedSelected) {
    const safeEntries = Array.isArray(monthEntries) ? monthEntries.slice() : [];

    if (safeEntries.length === 0) {
        contentEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">无数据</div>';
        return;
    }

    const selectedCount = selectedSet.size;
    const monthsPerPage = getYearMonthsPerPage(selectedCount);

    const totalPages = Math.ceil(safeEntries.length / monthsPerPage);

    if (printPreviewTotalPages !== totalPages || printPreviewCurrentPage > totalPages) {
        printPreviewTotalPages = totalPages;
        printPreviewCurrentPage = 1;
    }

    const pageIndex = Math.max(0, Math.min(printPreviewCurrentPage - 1, totalPages - 1));
    const startIdx = pageIndex * monthsPerPage;
    const monthsThisPage = safeEntries.slice(startIdx, startIdx + monthsPerPage);

    const pageSpec = getPrintA4PageSpec();
    const perMonthH = Math.floor(pageSpec.contentHeightPx / Math.max(1, monthsThisPage.length));
    const monthContentW = pageSpec.contentWidthPx;

    let stacked = '';
    for (let i = 0; i < monthsThisPage.length; i++) {
        const entry = monthsThisPage[i] || { year: Number(currentYear), month: 0, data: {} };
        const monthHtml = renderOneMonthDetail(entry.data || {}, entry.year, entry.month, selectedSet, orderedSelected, monthContentW, perMonthH);
        stacked += `<div style="width:${monthContentW}px; height:${perMonthH}px; min-height:${perMonthH}px; max-height:${perMonthH}px; overflow:hidden;">${monthHtml}</div>`;
    }

    const pageHtml = buildPrintA4PageHtml(`<div style="width:${monthContentW}px;height:${pageSpec.contentHeightPx}px;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;">${stacked}</div>`, pageSpec);
    contentEl.innerHTML = buildPrintA4PreviewHtml(contentEl, pageHtml, pageSpec);

    updatePrintPreviewPage(printPreviewCurrentPage, true);
}

// 初始化打印预览 A4 纸张框架与翻页控件。
function initPrintA4Preview() {
    const wrapper = document.getElementById('printPreviewWrapper');
    if (!wrapper) return;

    printPaperOrientation = 'portrait';
    printPreviewCurrentPage = 1;
    printPreviewTotalPages = 1;

    let sheet = wrapper.querySelector('.print-a4-sheet');
    const needCreate = !sheet;

    if (needCreate) {
        wrapper.innerHTML = `
                    <div class="print-a4-sheet" id="printPreviewSheet">
                        <div class="print-a4-content" id="printPreviewContent"></div>
                        <div class="print-page-indicator" id="printPageIndicator"></div>
                    </div>
                    <div class="print-preview-label">A4</div>
                `;
        sheet = wrapper.querySelector('.print-a4-sheet');
    }

    // 创建方向切换器（如果不存在）
    let oriSwitch = wrapper.querySelector('.print-orientation-switch');
    if (!oriSwitch) {
        oriSwitch = document.createElement('div');
        oriSwitch.className = 'print-orientation-switch';
        oriSwitch.innerHTML = `
                    <button type="button" class="ori-btn" data-ori="portrait">纵向</button>
                    <button type="button" class="ori-btn" data-ori="landscape">横向</button>
                `;
        wrapper.appendChild(oriSwitch);

        oriSwitch.querySelectorAll('.ori-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const newOri = btn.dataset.ori;
                if (newOri === printPaperOrientation) return;

                printPaperOrientation = newOri;
                oriSwitch.querySelectorAll('.ori-btn').forEach(b => b.classList.toggle('active', b.dataset.ori === newOri));
                applyMaxA4Size(wrapper, sheet);
                // 方向变化也实时更新预览内容
                updatePrintPreviewContent();
            });
        });
    }
    oriSwitch.querySelectorAll('.ori-btn').forEach(b => b.classList.toggle('active', b.dataset.ori === printPaperOrientation));

    // 创建翻页箭头（放在 A4 纸左右外侧）
    let prevBtn = wrapper.querySelector('.print-page-prev');
    let nextBtn = wrapper.querySelector('.print-page-next');
    if (!prevBtn || !nextBtn) {
        prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'print-page-nav print-page-prev';
        prevBtn.innerHTML = '◀';
        prevBtn.setAttribute('aria-label', '上一页');

        nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'print-page-nav print-page-next';
        nextBtn.innerHTML = '▶';
        nextBtn.setAttribute('aria-label', '下一页');

        wrapper.appendChild(prevBtn);
        wrapper.appendChild(nextBtn);

        prevBtn.addEventListener('click', () => {
            if (printPreviewCurrentPage > 1) {
                updatePrintPreviewPage(printPreviewCurrentPage - 1);
                showPageIndicatorTemporarily();
                if (printMode === 'year' || printMode === 'total') {
                    updatePrintPreviewContent();
                }
            }
        });
        nextBtn.addEventListener('click', () => {
            if (printPreviewCurrentPage < printPreviewTotalPages) {
                updatePrintPreviewPage(printPreviewCurrentPage + 1);
                showPageIndicatorTemporarily();
                if (printMode === 'year' || printMode === 'total') {
                    updatePrintPreviewContent();
                }
            }
        });
    }

    // 应用最大尺寸
    applyMaxA4Size(wrapper, sheet);

    // 更新当前页状态
    updatePrintPreviewPage(printPreviewCurrentPage);

    // 页码指示器默认隐藏（只有点击翻页时才临时显示2秒）
    const indicator = wrapper.querySelector('#printPageIndicator');
    if (indicator) indicator.style.display = 'none';
}

// 根据当前方向计算并应用最大的 A4 纸尺寸
function applyMaxA4Size(wrapper, sheet) {
    if (!wrapper || !sheet) return;

    const rect = wrapper.getBoundingClientRect();
    const isMultiPage = printPreviewTotalPages > 1;

    const extraSidePadding = isMultiPage ? 44 : 8;
    const pad = 8;

    const availW = Math.max(100, rect.width - pad * 2 - extraSidePadding * 2);
    const availH = Math.max(200, rect.height - pad * 2);

    const isLandscape = printPaperOrientation === 'landscape';
    const ratio = isLandscape ? (297 / 210) : (210 / 297);

    let h = availH;
    let w = h * ratio;

    if (w > availW) {
        w = availW;
        h = w / ratio;
    }

    sheet.style.width = w + 'px';
    sheet.style.height = h + 'px';
    sheet.style.maxWidth = 'none';
    sheet.style.maxHeight = 'none';
    sheet.style.flexShrink = '0';
}

// 临时显示页码指示器（点击翻页时调用，2秒后自动隐藏）
function showPageIndicatorTemporarily() {
    const wrapper = document.getElementById('printPreviewWrapper');
    if (!wrapper) return;

    const indicator = wrapper.querySelector('#printPageIndicator');
    if (!indicator || printPreviewTotalPages <= 1) return;

    if (printPageIndicatorHideTimer) {
        clearTimeout(printPageIndicatorHideTimer);
    }

    indicator.style.display = 'block';

    // 2秒后自动隐藏
    printPageIndicatorHideTimer = setTimeout(() => {
        if (indicator) indicator.style.display = 'none';
    }, 2000);
}

// 更新预览到指定页（只显示当前一页）
function updatePrintPreviewPage(page, isInitial = false) {
    const wrapper = document.getElementById('printPreviewWrapper');
    if (!wrapper) return;

    printPreviewCurrentPage = Math.max(1, Math.min(page, printPreviewTotalPages));

    const prevBtn = wrapper.querySelector('.print-page-prev');
    const nextBtn = wrapper.querySelector('.print-page-next');

    const indicator = wrapper.querySelector('#printPageIndicator');
    if (indicator && printPreviewTotalPages > 1) {
        indicator.textContent = `${printPreviewCurrentPage} / ${printPreviewTotalPages}`;
    }

    // 翻页箭头：多页时常驻显示，单页隐藏（永久显示，不自动隐藏）
    const showNav = printPreviewTotalPages > 1;
    if (prevBtn) prevBtn.style.display = (showNav && printPreviewCurrentPage > 1) ? 'flex' : 'none';
    if (nextBtn) nextBtn.style.display = (showNav && printPreviewCurrentPage < printPreviewTotalPages) ? 'flex' : 'none';
}

document.getElementById('openPrintBtn').addEventListener('click', async () => {
    await loadPrintPrefs();
    printMode = 'month';
    printPreviewYear = Number(currentYear);
    openOverlay('printLayer');
    populatePrintControls();
    setPrintMode('month');
    initPrintA4Preview();
    updatePrintPreviewContent();
});

document.getElementById('printCancelBtn').addEventListener('click', () => closeOverlay('printLayer'));
document.getElementById('printConfirmBtn').addEventListener('click', async () => {
    if (printMode === 'total') {
        const selections = await getPrintTotalTemplateSelections();
        if (!selections.length || !selections.every((item) => item.data)) return;
        const api = window.__yybbqCustomTable;
        const paginated = typeof api?.buildPaginatedPrintHtml === 'function'
            ? api.buildPaginatedPrintHtml(selections, { forPrint: true })
            : { pages: [selections.map((item) => item.renderPrintHtml(item.data, { title: item.title })).join('')], totalPages: 1 };
        const pages = Array.isArray(paginated.pages) ? paginated.pages : [String(paginated.pages || '')];
        const printTitle = selections.map((item) => item.title).join('、') || '自定义表格';
        const pageBreakCss = pages.length > 1
            ? '.tr-custom-print-a4-page{page-break-after:always;break-after:page;}.tr-custom-print-a4-page:last-child{page-break-after:auto;break-after:auto;}'
            : '';
        const phtml = pages.join('');
        const printWindow = window.open('', '_blank');
        if (!printWindow) return;
        const toneCss = typeof api?.getPrintHeaderToneCss === 'function' ? api.getPrintHeaderToneCss() : '';
        const pageSpec = typeof api?.getPrintPageSpec === 'function' ? api.getPrintPageSpec() : null;
        const isLandscapePrint = printPaperOrientation === 'landscape';
        const printPageW = pageSpec?.widthPx || Math.floor((isLandscapePrint ? 297 : 210) * (96 / 25.4) - 16 * (96 / 25.4));
        const printPageHmm = isLandscapePrint ? 194 : 277;
        const printPageSize = isLandscapePrint ? 'A4 landscape' : 'A4 portrait';
        printWindow.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(printTitle)}</title><style>@page{margin:8mm;size:${printPageSize};}*{box-sizing:border-box;}body{margin:0;padding:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;}${pageBreakCss}.tr-custom-print-a4-page{width:${printPageW}px;max-width:100%;height:${printPageHmm}mm;display:flex;flex-direction:column;gap:8px;padding:0;background:#fff;box-sizing:border-box;overflow:hidden;}.tr-custom-print-page{width:100%;display:flex;flex-direction:column;gap:6px;padding:0;background:#fff;box-sizing:border-box;flex-shrink:0;}.tr-custom-print-title{font-size:16px;font-weight:900;line-height:1.1;color:#111827;flex-shrink:0;min-height:20px;}.tr-custom-print-wrap{flex:0 0 auto;display:flex;overflow:visible;width:100%;}.tr-custom-print-table{width:100%;border-collapse:collapse;table-layout:fixed;background:#fff;}.tr-custom-print-table th,.tr-custom-print-table td{border:1.5px solid #2b2b2b;text-align:center;vertical-align:middle;font-weight:800;color:#111827;overflow:hidden;height:34px;max-height:34px;font-size:13px;line-height:1.1;padding:4px 2px;}${toneCss}</style></head><body>${phtml}</body></html>`);
        printWindow.document.close();
        setTimeout(() => { printWindow.print(); }, 300);
        closeOverlay('printLayer');
        return;
    }

    if (printMode === 'year') {
        const orderedSelected = PRINT_CATS.slice();
        const selectedSet = new Set(printSelectedCats);
        const monthEntries = await buildPrintYearMonthEntries();
        if (!monthEntries.length) return;

        const selectedCount = selectedSet.size;
        const monthsPerPage = getYearMonthsPerPage(selectedCount);

        const totalPages = Math.ceil(monthEntries.length / Math.max(1, monthsPerPage));

        const printSpec = getPrintA4PageSpec();
        const printW = printSpec.contentWidthPx;
        const printH = printSpec.contentHeightPx;
        const monthContentW = printW;

        let allPagesHtml = '';
        for (let pg = 0; pg < totalPages; pg++) {
            const pageMonths = monthEntries.slice(pg * monthsPerPage, (pg + 1) * monthsPerPage);
            const perMonthH = Math.floor(printH / Math.max(1, pageMonths.length));

            let pageContent = '';
            for (let i = 0; i < pageMonths.length; i++) {
                const entry = pageMonths[i] || { year: Number(currentYear), month: 0, data: {} };
                const monthHtml = renderOneMonthDetail(entry.data || {}, entry.year, entry.month, selectedSet, orderedSelected, monthContentW, perMonthH);
                pageContent += `<div style="display:flex; align-items:flex-start; justify-content:center; min-height:${perMonthH}px; max-height:${perMonthH}px; overflow:hidden;"><div style="width:${printW}px; height:${perMonthH}px; overflow:hidden;">${monthHtml}</div></div>`;
            }
            allPagesHtml += buildPrintA4PageHtml(`<div style="width:${printW}px;height:${printH}px;display:flex;flex-direction:column;overflow:hidden;">${pageContent}</div>`, printSpec, pg < totalPages - 1);
        }

        const printWindow = window.open('', '_blank');
        const targetYear = monthEntries[0]?.year || Number(currentYear);
        if (!printWindow) return;
        printWindow.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${targetYear} 年报</title><style>@page{margin:0;size:A4 portrait;}*{box-sizing:border-box;}body{margin:0;padding:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;}.print-page{width:210mm;height:297mm;page-break-after:always;overflow:hidden;}.report-container{display:flex;flex-direction:column;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#111;background:#fff;width:100%;height:100%;}.report-header{display:flex;justify-content:flex-start;align-items:flex-end;flex-shrink:0;}.report-title{font-weight:900;letter-spacing:0.2px;white-space:nowrap;overflow:visible;}.report-summary{display:flex;flex-wrap:nowrap;flex-shrink:0;align-items:stretch;}.report-summary-item{border:1.2px solid #111;border-radius:6px;display:flex;flex-direction:row;align-items:center;justify-content:space-between;background:#fff;overflow:hidden;}.report-summary-item .label{font-weight:800;color:#111;white-space:nowrap;flex:0 0 auto;}.report-summary-item .value{font-weight:900;line-height:1;text-align:right;white-space:nowrap;flex:1 1 auto;overflow:hidden;}.report-stack{display:flex;flex-direction:column;flex:0 0 auto;overflow:visible;}.preview-block{border:1.2px solid #111;border-radius:6px;box-sizing:border-box;display:flex;flex-direction:column;overflow:visible;background:#fff;}.preview-block-title{font-weight:800;line-height:1.1;flex-shrink:0;}.preview-cash-grid{display:flex;flex-direction:column;min-height:0;overflow:visible;}.preview-cash-row{display:flex;flex-wrap:nowrap;min-height:0;overflow:visible;align-items:stretch;}.preview-day-box{border:1px solid #111;border-radius:4px;background:#fff;overflow:hidden;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;}.preview-cash-row .preview-day-box{overflow:visible;}.preview-day-box .day{opacity:0.82;text-align:left;white-space:nowrap;overflow:hidden;}.preview-day-box .amt{text-align:center;font-weight:900;white-space:nowrap;overflow:hidden;}.preview-cash-total-label{display:flex;align-items:center;justify-content:center;font-weight:900;line-height:1;flex:0 0 auto;}.preview-check-grid{display:flex;flex-direction:column;flex-wrap:nowrap;min-height:0;overflow:hidden;}.preview-check-row{display:flex;align-items:stretch;}.preview-check-cell{display:grid;grid-template-columns:auto 1fr;align-items:center;border:1px solid #111;border-radius:4px;background:#fff;overflow:hidden;flex:0 0 auto;padding:0 3px;}.preview-check-cell .date{opacity:0.82;text-align:left;white-space:nowrap;overflow:hidden;}.preview-check-cell .amt{text-align:center;font-weight:900;white-space:nowrap;overflow:hidden;}.preview-delivery-grid{display:grid;align-content:start;justify-content:start;min-height:0;overflow:visible;}.preview-delivery-box{border:1px solid #111;border-radius:6px;padding:3px 4px;display:flex;flex-direction:column;min-height:0;overflow:visible;background:#fff;}.preview-delivery-title{font-weight:800;line-height:1.1;flex:0 0 auto;}.preview-delivery-items{display:grid;align-content:start;justify-content:start;min-height:0;overflow:hidden;}.preview-delivery-item{border-bottom:1px solid #111;padding:0 0 1px;line-height:1.12;display:flex;flex-direction:column;overflow:hidden;}.preview-salary-wrap{flex-shrink:0;overflow:hidden;}.preview-salary-table{width:100%;border-collapse:collapse;table-layout:fixed;}.preview-salary-table th,.preview-salary-table td{border:1px solid #111;text-align:center;vertical-align:middle;white-space:nowrap;overflow:hidden;padding:0 2px;}.preview-salary-table th{background:#f2f2f2;font-weight:800;}.preview-money-table{width:100%;border-collapse:collapse;table-layout:fixed;}.preview-money-table th,.preview-money-table td{border:1px solid #111;text-align:center;vertical-align:middle;white-space:nowrap;overflow:hidden;padding:0 2px;}.preview-money-table th{background:#f2f2f2;font-weight:800;}.preview-money-table td:nth-child(2){text-align:left;padding-left:2px;}.preview-bottom-row{display:grid;align-items:stretch;}.preview-empty{opacity:0.65;}.preview-hidden-slot{visibility:hidden;border-color:transparent;}</style></head><body>${allPagesHtml}</body></html>`);
        printWindow.document.head.insertAdjacentHTML('beforeend', `<style>@page{size:${printSpec.pageSize};}.print-page{width:${printSpec.pageWidthPx}px;height:${printSpec.pageHeightPx}px;}.print-page:last-child{page-break-after:auto;break-after:auto;}@media screen{body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px;background:#f1f5f9;}.print-page{flex:0 0 auto;border:2px solid #64748b;box-shadow:0 8px 24px rgb(0 0 0 / 20%);}}</style>`);
        printWindow.document.close();
        setTimeout(() => { printWindow.print(); }, 300);
        closeOverlay('printLayer');
        return;
    }
    const printYear = Number(document.getElementById('printYearSelect')?.value) || Number(currentYear);
    const printMonth = Number(document.getElementById('printMonthSelect')?.value) || 0;

    const printCats = PRINT_CATS.slice();
    const printSet = new Set(printSelectedCats);
    const pd = await fetchPrintPreviewYearData(printYear);
    const pmd = (Array.isArray(pd) && pd.length === 12) ? (pd[printMonth] || {}) : {};
    const pnmd = normalizePrintPreviewMonthData(pmd, printYear, printMonth);
    const printSpec = getPrintA4PageSpec();
    const monthHtml = renderOneMonthDetail(
        pnmd,
        printYear,
        printMonth,
        printSet,
        printCats,
        printSpec.contentWidthPx,
        printSpec.contentHeightPx
    );
    const phtml = buildPrintA4PageHtml(monthHtml, printSpec);
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${printYear} ${monthLabels[printMonth]} 月报</title><style>@page{margin:6mm;size:A4 portrait;}*{box-sizing:border-box;}body{margin:0;padding:0;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;}.report-container{display:flex;flex-direction:column;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#111;background:#fff;width:100%;height:100%;}.report-header{display:flex;justify-content:flex-start;align-items:flex-end;flex-shrink:0;}.report-title{font-weight:900;letter-spacing:0.2px;white-space:nowrap;}.report-summary{display:flex;flex-wrap:nowrap;flex-shrink:0;align-items:stretch;}.report-summary-item{border:1.2px solid #111;border-radius:6px;display:flex;flex-direction:row;align-items:center;justify-content:space-between;background:#fff;overflow:hidden;}.report-summary-item .label{font-weight:800;color:#111;white-space:nowrap;flex:0 0 auto;}.report-summary-item .value{font-weight:900;line-height:1;text-align:right;white-space:nowrap;flex:1 1 auto;}.report-stack{display:flex;flex-direction:column;flex:0 0 auto;}.preview-block{border:1.2px solid #111;border-radius:6px;box-sizing:border-box;display:flex;flex-direction:column;background:#fff;}.preview-block-title{font-weight:800;line-height:1.1;flex-shrink:0;}.preview-cash-grid{display:flex;flex-direction:column;overflow:visible;}.preview-cash-row{display:flex;flex-wrap:nowrap;align-items:stretch;overflow:visible;}.preview-day-box{border:1px solid #111;border-radius:4px;background:#fff;overflow:hidden;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;}.preview-cash-row .preview-day-box{overflow:visible;}.preview-day-box .day{opacity:0.82;white-space:nowrap;overflow:hidden;}.preview-day-box .amt{text-align:center;font-weight:900;white-space:nowrap;overflow:hidden;}.preview-cash-total-label{display:flex;align-items:center;justify-content:center;font-weight:900;flex:0 0 auto;}.preview-check-grid{display:flex;flex-direction:column;}.preview-check-row{display:flex;align-items:stretch;}.preview-check-cell{display:grid;grid-template-columns:auto 1fr;align-items:center;border:1px solid #111;border-radius:4px;background:#fff;overflow:hidden;flex:0 0 auto;padding:0 3px;}.preview-check-cell .date{opacity:0.82;white-space:nowrap;overflow:hidden;}.preview-check-cell .amt{text-align:center;font-weight:900;white-space:nowrap;overflow:hidden;}.preview-delivery-grid{display:grid;}.preview-delivery-box{border:1px solid #111;border-radius:6px;padding:3px 4px;display:flex;flex-direction:column;background:#fff;}.preview-delivery-title{font-weight:800;flex:0 0 auto;}.preview-delivery-items{display:grid;}.preview-delivery-item{border-bottom:1px solid #111;padding:0 0 1px;line-height:1.12;display:flex;flex-direction:column;overflow:hidden;}.preview-salary-table{width:100%;border-collapse:collapse;table-layout:fixed;}.preview-salary-table th,.preview-salary-table td{border:1px solid #111;text-align:center;vertical-align:middle;white-space:nowrap;padding:0 2px;}.preview-salary-table th{background:#f2f2f2;font-weight:800;}.preview-money-table{width:100%;border-collapse:collapse;table-layout:fixed;}.preview-money-table th,.preview-money-table td{border:1px solid #111;text-align:center;vertical-align:middle;white-space:nowrap;padding:0 2px;}.preview-money-table th{background:#f2f2f2;font-weight:800;}.preview-money-table td:nth-child(2){text-align:left;padding-left:2px;}.preview-bottom-row{display:grid;align-items:stretch;}.preview-empty{opacity:0.65;}.preview-hidden-slot{visibility:hidden;border-color:transparent;}</style></head><body>${phtml}</body></html>`);
    printWindow.document.head.insertAdjacentHTML('beforeend', `<style>@page{margin:0;size:${printSpec.pageSize};}.print-page{width:${printSpec.pageWidthPx}px;height:${printSpec.pageHeightPx}px;page-break-after:auto;break-after:auto;}@media screen{body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px;background:#f1f5f9;}.print-page{flex:0 0 auto;border:2px solid #64748b;box-shadow:0 8px 24px rgb(0 0 0 / 20%);}}</style>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 300);
    closeOverlay('printLayer');
});

//#endregion

//#region 总报表
(function () {
    //#region 共用 · 设置与筛选
    const TR_CATS = [
        { key: 'cash', label: '现金' },
        { key: 'check', label: '刷卡' },
        { key: 'delivery', label: '外卖' },
        { key: 'others', label: '其他' },
        { key: 'expense', label: '工资' },
        { key: 'costTotal', label: '收支' },
    ];
    const TR_FRONT_KEYS = ['cash', 'check', 'delivery'];
    const TR_MIDDLE_KEYS = ['expense', 'costTotal'];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let trMode = 'year';
    let trReportCats = TR_CATS.map(c => c.key);
    let trReportYears = [];
    let trReportShowTotal = true;
    let trCustomYears = [];
    let trCustomCats = [];
    let trCustomShowTotal = false;
    let trSelectedCats = TR_CATS.map(c => c.key);
    let trSelectedYears = [];
    let trShowTotal = true;

    // 检测是否为移动端视口
    function trIsMobile() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    // 将当前筛选状态写入对应模式槽位
    function trSaveActiveToMode() {
        if (trMode === 'custom') {
            trCustomYears = trSelectedYears.slice();
            trCustomCats = trSelectedCats.slice();
            trCustomShowTotal = trShowTotal;
        } else {
            trReportYears = trSelectedYears.slice();
            trReportCats = trSelectedCats.slice();
            trReportShowTotal = trShowTotal;
        }
    }

    // 从当前模式槽位恢复筛选状态
    function trSyncActiveFromMode() {
        if (trMode === 'custom') {
            trSelectedYears = trCustomYears.slice();
            trSelectedCats = trCustomCats.slice();
            trShowTotal = trCustomShowTotal;
        } else {
            trSelectedYears = trReportYears.slice();
            trSelectedCats = trReportCats.slice();
            trShowTotal = trReportShowTotal;
        }
    }
    const TR_CUSTOM_API_BASE = `${LEDGER_API_BASE}/custom-table`;
    const TR_CUSTOM_DEFAULT_ROWS = 8;
    const TR_CUSTOM_DEFAULT_COLS = 6;
    const TR_CUSTOM_MONTH_BATCH_ROWS = 6;
    const TR_CUSTOM_MONTH_BATCH_COLS = 14;
    const TR_CUSTOM_MIN_ROWS = 2;
    const TR_CUSTOM_MIN_COLS = 2;
    const TR_CUSTOM_MAX_ROWS = 60;
    const TR_CUSTOM_MAX_COLS = 32;
    const TR_CUSTOM_DESKTOP_FIT_COLS = 14;
    const TR_CUSTOM_DESKTOP_FONT_MAX = 20;
    const TR_CUSTOM_DESKTOP_FONT_MIN = 12;
    const TR_CUSTOM_MOBILE_FONT_CAP = 20;
    const TR_CUSTOM_MOBILE_FONT_MIN = 8;
    const TR_CUSTOM_MIN_SECTION_COUNT = 1;
    const TR_CUSTOM_MAX_SECTION_COUNT = 20;
    let trCustomTemplates = [];
    let trCustomLoaded = false;
    let trCustomLoadingPromise = null;
    let trCustomCurrentId = null;
    let trCustomDraft = null;
    const TR_CUSTOM_STATUS_FLASH_MS = 5000;
    const TR_CUSTOM_STATUS_ERROR_MS = 8000;
    const TR_CUSTOM_GUIDES = {
        create: '已创建新报表。左侧「报表」切换不同报表；「新建」里点确定可追加表格；(1)(2) 选择当前表格；布局与第二行仅作用于选中表格。',
        edit: '正在修改报表。左侧切换报表；「新建」追加表格；(1)(2) 选择表格；布局与第二行仅作用于当前选中表格。',
        addTable: (params) => `已添加表格 ${params.index || ''}。布局、插入与第二行操作仅作用于当前选中的表格。`,
        yearLayout: '第二行已全选年份；当前选中表格第一行已连续添加全部年份。',
        monthLayout: (params) => `已批量新建 ${params.count || 0} 个月表（14列6行：年份+12个月+总额）。`,
        clearData: '数据已清空（未保存）。可重新编辑后保存。',
        clearReset: '表格已重置（未保存）。请重新设置结构后保存。',
        selectYears: '请先在页面上方选择年份，再使用布局。',
    };
    let trCustomStatus = { guideKey: '', guideText: '', tone: '' };
    let trCustomStatusHideTimer = null;
    let trCustomToolbarExpanded = false;
    let trCustomPendingDraft = false;
    let trCustomBeforeCreateId = null;
    let trCustomSavedSnapshot = null;
    let trCustomConfirmResolver = null;
    let trCustomConfirmBound = false;
    let trCustomManageOpen = false;
    let trCustomManageTargetKind = 'table';
    let trCustomManageTargetId = null;
    let trCustomManageTargetPending = false;
    let trCustomLayoutCustomInputOpen = false;
    let trCustomLayoutCustomCount = 2;
    let trCustomRowColMode = 'insert';
    let trCustomInsertPosition = 3;
    let trCustomNewTableRows = TR_CUSTOM_DEFAULT_ROWS;
    let trCustomNewTableCols = TR_CUSTOM_DEFAULT_COLS;
    let trCustomActiveTableIndex = 0;
    let trCustomScrollToTableOnRender = null;
    let trCustomSelectorKind = null;
    let trCustomContentKind = null;
    let trPrintSettingsMode = false;
    let trPrintSettingsDraftTableIds = new Set();
    let trPrintSettingsDraftModuleIds = new Set();
    let trCustomFontFitObserver = null;
    let trCustomFontFitAllTimer = null;

    // 持久化总结/详细报表偏好
    function saveTrPrefs() {
        trSaveActiveToMode();
        queueAppPrefSave(APP_PREF_KEYS.TR_REPORT, {
            mode: trMode === 'all' ? 'all' : 'year',
            cats: trReportCats,
            showTotal: trReportShowTotal,
            years: trReportYears,
        });
    }

    // 应用已加载的报表偏好到内存状态
    function trApplyReportPrefs(prefs) {
        if (!prefs || typeof prefs !== 'object') {
            trMode = 'year';
            trReportCats = TR_CATS.map(c => c.key);
            trReportShowTotal = true;
            trReportYears = trGetAllYears();
        } else {
            trMode = prefs.mode === 'all' ? 'all' : 'year';
            const cats = Array.isArray(prefs.cats) ? prefs.cats.filter((k) => TR_CATS.some((c) => c.key === k)) : [];
            trReportCats = cats.length ? cats : TR_CATS.map((c) => c.key);
            trReportShowTotal = (typeof prefs.showTotal === 'boolean') ? prefs.showTotal : true;
            if (Array.isArray(prefs.years)) {
                trReportYears = prefs.years.map((y) => Number(y)).filter((y) => y >= 2000);
            } else {
                trReportYears = trGetAllYears();
            }
        }
        trCustomYears = [];
        trCustomCats = [];
        trCustomShowTotal = false;
        trSyncActiveFromMode();
    }

    // 从后端加载报表偏好
    async function loadTrPrefs() {
        const prefs = await loadAppPref(APP_PREF_KEYS.TR_REPORT);
        trApplyReportPrefs(prefs);
    }

    loadTrPrefs();
    trCustomDraft = trCreateDefaultCustomTemplate();
    const trYearCache = {};
    let trLoaded = false;
    let trLoading = false;
    let trRenderQueued = false;

    // 汇总账本中所有可用年份
    function trGetAllYears() {
        return Array.from(new Set([...ledgerYears, currentYear]))
            .map(Number)
            .filter((y) => y >= 2000)
            .sort((a, b) => a - b);
    }

    // 剔除已失效的已选年份
    function trNormalizeSelectedYears(allYears) {
        const list = Array.isArray(allYears) ? allYears : [];
        trSelectedYears = trSelectedYears.filter((y) => list.includes(y));
    }

    // 渲染年份筛选按钮组
    function trRenderYearFilter(allYears) {
        const wrap = document.getElementById('trYearFilter');
        if (!wrap) return;
        trNormalizeSelectedYears(allYears);
        wrap.innerHTML = '';
        for (const year of allYears) {
            const tone = trGetYearTone(year);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `tr-year-filter-btn ${tone}` + (trSelectedYears.includes(year) ? ' active' : '');
            btn.textContent = String(year);
            btn.dataset.year = String(year);
            btn.addEventListener('click', async () => {
                const exists = trSelectedYears.includes(year);
                if (exists) {
                    trSelectedYears = trSelectedYears.filter((y) => y !== year);
                } else {
                    trSelectedYears.push(year);
                    trSelectedYears.sort((a, b) => a - b);
                }

                saveTrPrefs();
                trRenderYearFilter(allYears);

                if (!trYearCache[year]) {
                    await trEnsureYear(year);
                }
                if (trMode === 'custom') {
                    await trCustomOnSelectionChanged();
                }
                trQueueRenderDOM();
            });
            wrap.appendChild(btn);
        }
    }

    // 按年份返回色调 class 名
    function trGetYearTone(year) {
        const yearTones = ['tr-tone-1', 'tr-tone-2', 'tr-tone-3', 'tr-tone-4', 'tr-tone-5', 'tr-tone-6', 'tr-tone-7', 'tr-tone-8', 'tr-tone-9'];
        return yearTones[Math.abs(Number(year)) % yearTones.length];
    }
    //#endregion

    //#region 自定义表 · 表格结构
    // 将数值限制在指定区间并取整
    function trCustomClamp(value, min, max, fallback) {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(min, Math.min(max, Math.round(num)));
    }

    // 返回合计行索引（末行）
    function trCustomGetTotalRowIndex(rows) {
        return Math.max(0, Math.trunc(rows) - 1);
    }

    // 判断是否为合计行
    function trCustomIsTotalRow(rowIndex, rows) {
        return rowIndex === trCustomGetTotalRowIndex(rows);
    }

    // 新建单元格的默认占位文本
    function trCustomDefaultCellValue(rowIndex, colIndex, totalRows = TR_CUSTOM_DEFAULT_ROWS) {
        const safeRows = trCustomClamp(totalRows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, TR_CUSTOM_DEFAULT_ROWS);
        const totalRow = trCustomGetTotalRowIndex(safeRows);
        if (rowIndex === 0 && colIndex === 0) return 'Table 1';
        if (rowIndex === totalRow && colIndex === 0) return 'Total';
        return '';
    }

    // 规范化合计行标签与空单元格
    function trCustomApplyTotalRowCells(cells, rows, cols) {
        if (!Array.isArray(cells) || rows < 1 || cols < 1) return;
        const totalRow = trCustomGetTotalRowIndex(rows);
        for (let r = 0; r < rows; r += 1) {
            if (!Array.isArray(cells[r])) continue;
            if (r === totalRow) continue;
            if (String(cells[r][0] || '').trim() === 'Total') {
                cells[r][0] = '';
            }
            for (let c = 1; c < cols; c += 1) {
                if (cells[r][c] == null) cells[r][c] = '';
            }
        }
        if (!Array.isArray(cells[totalRow])) return;
        cells[totalRow][0] = 'Total';
        for (let c = 1; c < cols; c += 1) {
            cells[totalRow][c] = '';
        }
    }

    // 从源矩阵构建规范化单元格数组
    function trCustomBuildCells(rows, cols, source) {
        return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
            const row = Array.isArray(source[r]) ? source[r] : [];
            const value = row[c];
            return value == null ? trCustomDefaultCellValue(r, c, rows) : String(value);
        }));
    }

    // 创建空白自定义表格模板
    function trCreateDefaultCustomTemplate(rows = TR_CUSTOM_DEFAULT_ROWS, cols = TR_CUSTOM_DEFAULT_COLS) {
        const safeRows = trCustomClamp(rows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, TR_CUSTOM_DEFAULT_ROWS);
        const safeCols = trCustomClamp(cols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, TR_CUSTOM_DEFAULT_COLS);
        const cells = Array.from({ length: safeRows }, (_, r) => Array.from({ length: safeCols }, (_, c) => trCustomDefaultCellValue(r, c, safeRows)));
        trCustomApplyTotalRowCells(cells, safeRows, safeCols);
        return { layout: 'single', rows: safeRows, cols: safeCols, cells, sections: [] };
    }

    // 规范化单个表格分区结构
    function trCustomNormalizeSection(raw, fallbackRows, fallbackCols) {
        const rows = trCustomClamp(raw && raw.rows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, fallbackRows);
        const cols = trCustomClamp(raw && raw.cols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, fallbackCols);
        const source = Array.isArray(raw && raw.cells) ? raw.cells : [];
        const cells = trCustomBuildCells(rows, cols, source);
        trCustomApplyTotalRowCells(cells, rows, cols);
        return {
            title: String((raw && raw.title) || ''),
            rows,
            cols,
            cells,
        };
    }

    // 规范化完整报表模板（含多表分区）
    function trCustomNormalizeTemplate(raw) {
        const base = trCreateDefaultCustomTemplate();
        if (!raw || typeof raw !== 'object') return base;
        const rows = trCustomClamp(raw.rows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, base.rows);
        const cols = trCustomClamp(raw.cols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, base.cols);
        const source = Array.isArray(raw.cells) ? raw.cells : [];
        const cells = trCustomBuildCells(rows, cols, source);
        trCustomApplyTotalRowCells(cells, rows, cols);
        const layout = ['single', 'year', 'month', 'custom'].includes(raw.layout) ? raw.layout : 'single';
        const sections = Array.isArray(raw.sections)
            ? raw.sections.map((section) => trCustomNormalizeSection(section, rows, cols))
            : [];
        return { layout, rows, cols, cells, sections };
    }

    // 判断模板是否含多个表格分区
    function trCustomIsMultiLayout(template) {
        const safe = trCustomNormalizeTemplate(template);
        return safe.sections.length > 0;
    }

    // 确保草稿始终有 sections 多表结构
    function trCustomEnsureReportTables(draft) {
        if (!draft) return draft;
        const safe = trCustomNormalizeTemplate(draft);
        if (safe.sections.length > 0) {
            draft.sections = safe.sections.map((section, index) => ({
                ...trCustomNormalizeSection(section, safe.rows, safe.cols),
                title: String(section.title || `表格 ${index + 1}`),
            }));
            draft.layout = draft.layout || 'custom';
            trCustomClampActiveTableIndex(draft);
            return draft;
        }
        draft.sections = [{
            title: '表格 1',
            rows: safe.rows,
            cols: safe.cols,
            cells: safe.cells.map((row) => row.slice()),
        }];
        draft.layout = 'custom';
        draft.rows = safe.rows;
        draft.cols = safe.cols;
        draft.cells = safe.cells.map((row) => row.slice());
        trCustomActiveTableIndex = 0;
        return draft;
    }

    // 将当前表格索引限制在有效范围
    function trCustomClampActiveTableIndex(draft = trCustomDraft) {
        const count = draft?.sections?.length || 0;
        if (!count) {
            trCustomActiveTableIndex = 0;
            return 0;
        }
        trCustomActiveTableIndex = Math.max(0, Math.min(trCustomActiveTableIndex, count - 1));
        return trCustomActiveTableIndex;
    }

    // 获取当前选中表格索引
    function trCustomGetActiveTableIndex(draft = trCustomDraft) {
        trCustomEnsureReportTables(draft);
        return trCustomClampActiveTableIndex(draft);
    }

    // 获取当前选中表格分区数据
    function trCustomGetActiveSection(draft = trCustomDraft) {
        if (!draft) return null;
        const safe = trCustomNormalizeTemplate(draft);
        if (!safe.sections.length) {
            return { title: '表格 1', rows: safe.rows, cols: safe.cols, cells: safe.cells };
        }
        const idx = trCustomGetActiveTableIndex(safe);
        return trCustomNormalizeSection(safe.sections[idx], safe.rows, safe.cols);
    }

    // 将选中分区同步到草稿主网格字段
    function trCustomSyncPrimaryFromSection(sectionIndex = trCustomActiveTableIndex) {
        if (!trCustomDraft?.sections?.[sectionIndex]) return;
        const section = trCustomDraft.sections[sectionIndex];
        trCustomDraft.rows = section.rows;
        trCustomDraft.cols = section.cols;
        trCustomDraft.cells = section.cells.map((row) => row.slice());
    }

    // 对当前选中分区执行变更并写回草稿
    function trCustomUpdateActiveSection(mutator) {
        if (!trCustomDraft) return false;
        trCustomEnsureReportTables(trCustomDraft);
        const idx = trCustomGetActiveTableIndex(trCustomDraft);
        const section = trCustomNormalizeSection(trCustomDraft.sections[idx], trCustomDraft.rows, trCustomDraft.cols);
        const next = mutator(section);
        if (!next) return false;
        trCustomDraft.sections[idx] = next;
        trCustomSyncPrimaryFromSection(idx);
        return true;
    }

    // 向草稿追加一个新表格分区
    function trCustomAddReportTable(rows, cols) {
        if (!trCustomDraft) return false;
        trCustomEnsureReportTables(trCustomDraft);
        const nextRows = trCustomClamp(rows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, TR_CUSTOM_DEFAULT_ROWS);
        const nextCols = trCustomClamp(cols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, TR_CUSTOM_DEFAULT_COLS);
        const created = trCreateDefaultCustomTemplate(nextRows, nextCols);
        const section = trCustomNormalizeSection({
            title: `表格 ${trCustomDraft.sections.length + 1}`,
            rows: created.rows,
            cols: created.cols,
            cells: created.cells,
        }, nextRows, nextCols);
        trCustomDraft.sections.push(section);
        trCustomActiveTableIndex = trCustomDraft.sections.length - 1;
        trCustomDraft.layout = 'custom';
        trCustomSyncPrimaryFromSection(trCustomActiveTableIndex);
        return true;
    }

    // 移除当前选中表格（至少保留一个）
    async function trCustomRemoveActiveTable() {
        if (!trCustomDraft?.sections || trCustomDraft.sections.length <= 1) {
            trCustomSetError('至少保留一个表格');
            return false;
        }
        if (!(await trCustomConfirm('是否移除当前选中的表格？'))) return false;
        const idx = trCustomGetActiveTableIndex(trCustomDraft);
        trCustomDraft.sections.splice(idx, 1);
        trCustomDraft.sections.forEach((section, index) => {
            section.title = `表格 ${index + 1}`;
        });
        trCustomActiveTableIndex = Math.min(idx, trCustomDraft.sections.length - 1);
        trCustomSyncPrimaryFromSection(trCustomActiveTableIndex);
        return true;
    }

    // 获取用于布局复制的原型网格
    function trCustomGetPrototypeGrid(template = trCustomDraft) {
        const safe = trCustomNormalizeTemplate(template);
        if (trCustomIsMultiLayout(safe) && safe.sections[0]) {
            return trCustomNormalizeSection(safe.sections[0], safe.rows, safe.cols);
        }
        return {
            title: '',
            rows: safe.rows,
            cols: safe.cols,
            cells: safe.cells,
        };
    }

    // 复制分区结构并清空数据区
    function trCustomCloneSectionStructure(section) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        const cells = safe.cells.map((row, rowIndex) => row.map((value, colIndex) => {
            if (trCustomIsTotalRow(rowIndex, safe.rows)) {
                return colIndex === 0 ? 'Total' : '';
            }
            if (rowIndex === 0 || colIndex === 0) return value;
            return '';
        }));
        return { title: safe.title, rows: safe.rows, cols: safe.cols, cells };
    }

    // 深拷贝规范化后的模板
    function trCustomCloneTemplate(raw) {
        return JSON.parse(JSON.stringify(trCustomNormalizeTemplate(raw)));
    }

    // 调整草稿整体行列尺寸
    function trCustomResizeDraft(rows, cols) {
        const nextRows = trCustomClamp(rows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, trCustomDraft?.rows || TR_CUSTOM_DEFAULT_ROWS);
        const nextCols = trCustomClamp(cols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, trCustomDraft?.cols || TR_CUSTOM_DEFAULT_COLS);
        const current = trCustomCloneTemplate(trCustomDraft);
        if (trCustomIsMultiLayout(current) && current.sections.length) {
            current.sections = current.sections.map((section) => trCustomResizeSection(section, nextRows, nextCols));
            current.rows = nextRows;
            current.cols = nextCols;
            current.cells = current.sections[0].cells.map((row) => row.slice());
            trCustomApplyTotalRowCells(current.cells, nextRows, nextCols);
            trCustomDraft = current;
            return;
        }
        const cells = Array.from({ length: nextRows }, (_, r) => Array.from({ length: nextCols }, (_, c) => {
            if (r < current.rows && c < current.cols) return current.cells[r][c] || '';
            return trCustomDefaultCellValue(r, c, nextRows);
        }));
        trCustomApplyTotalRowCells(cells, nextRows, nextCols);
        trCustomDraft = { ...current, rows: nextRows, cols: nextCols, cells };
    }

    // 查找行内最后一个有内容的列
    function trCustomFindLastFilledColInRow(template, row, minCol = 1) {
        const safe = trCustomNormalizeTemplate(template);
        let last = minCol - 1;
        for (let c = minCol; c < safe.cols; c += 1) {
            if (trCustomCellHasContent(safe.cells[row][c])) last = c;
        }
        return last;
    }

    // 查找列内最后一个有内容的行（不含合计行）
    function trCustomFindLastFilledRowInCol(template, col, minRow = 1) {
        const safe = trCustomNormalizeTemplate(template);
        const maxRow = Math.max(minRow - 1, safe.rows - 2);
        let last = minRow - 1;
        for (let r = minRow; r <= maxRow; r += 1) {
            if (trCustomCellHasContent(safe.cells[r][col])) last = r;
        }
        return last;
    }

    // 查找行内第一个空列（含总额列之后）
    function trCustomFindFirstEmptyColInRow(grid, row, minCol = 1) {
        if (!grid?.cells) return -1;
        const scanEnd = trCustomGetHeaderScanEnd(grid);
        for (let c = minCol; c < scanEnd; c += 1) {
            if (!trCustomCellHasContent(grid.cells[row]?.[c])) return c;
        }
        for (let c = scanEnd; c < grid.cols; c += 1) {
            if (!trCustomCellHasContent(grid.cells[row]?.[c])) return c;
        }
        return -1;
    }

    // 查找列内第一个空行（不含合计行）
    function trCustomFindFirstEmptyRowInCol(grid, col, minRow = 1) {
        if (!grid?.cells) return -1;
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        for (let r = minRow; r < totalRow; r += 1) {
            if (!trCustomCellHasContent(grid.cells[r]?.[col])) return r;
        }
        return -1;
    }

    // 尝试在表头空隙填入年份或分类标签
    function trCustomTryFillGapSlot(grid, axis, label) {
        if (axis === 'col') {
            const gap = trCustomFindFirstEmptyColInRow(grid, 0, 1);
            if (gap < 0) return false;
            grid.cells[0][gap] = String(label);
            return true;
        }
        const gap = trCustomFindFirstEmptyRowInCol(grid, 0, 1);
        if (gap < 0) return false;
        grid.cells[gap][0] = String(label);
        return true;
    }

    // 按目标尺寸扩展单元格矩阵并保留已有数据
    function trCustomResizeCells(safeCells, safeRows, safeCols, nextRows, nextCols) {
        const cells = Array.from({ length: nextRows }, (_, r) => Array.from({ length: nextCols }, (_, c) => {
            if (r < safeRows && c < safeCols) return safeCells[r][c] || '';
            return trCustomDefaultCellValue(r, c, nextRows);
        }));
        trCustomApplyTotalRowCells(cells, nextRows, nextCols);
        return cells;
    }

    // 确保模板尺寸不低于指定下限
    function trCustomEnsureDraftSize(template, minRows, minCols) {
        const safe = trCustomNormalizeTemplate(template);
        const nextRows = Math.min(TR_CUSTOM_MAX_ROWS, Math.max(safe.rows, minRows));
        const nextCols = Math.min(TR_CUSTOM_MAX_COLS, Math.max(safe.cols, minCols));
        if (nextRows === safe.rows && nextCols === safe.cols) return safe;
        const cells = trCustomResizeCells(safe.cells, safe.rows, safe.cols, nextRows, nextCols);
        return { rows: nextRows, cols: nextCols, cells };
    }

    // 仅在目标单元格为空时写入值
    function trCustomSafeSetCell(template, row, col, value) {
        if (!template || !Array.isArray(template.cells)) return;
        if (row < 0 || col < 0 || row >= template.rows || col >= template.cols) return;
        if (trCustomCellHasContent(template.cells[row][col])) return;
        template.cells[row][col] = String(value);
    }

    // 判断缩小尺寸是否会丢失非空单元格
    function trCustomWillResizeLoseData(nextRows, nextCols) {
        const safe = trCustomNormalizeTemplate(trCustomDraft);
        const rows = trCustomClamp(nextRows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, safe.rows);
        const cols = trCustomClamp(nextCols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, safe.cols);
        const grids = trCustomIsMultiLayout(safe)
            ? safe.sections
            : [{ rows: safe.rows, cols: safe.cols, cells: safe.cells }];
        for (const grid of grids) {
            if (rows >= grid.rows && cols >= grid.cols) continue;
            for (let r = 0; r < grid.rows; r += 1) {
                for (let c = 0; c < grid.cols; c += 1) {
                    if ((r >= rows || c >= cols) && trCustomCellHasContent(grid.cells[r][c])) return true;
                }
            }
        }
        return false;
    }

    // 关闭自定义布局数量输入面板
    function trCustomCloseLayoutCustomInput() {
        trCustomLayoutCustomInputOpen = false;
    }

    //#endregion

    //#region 自定义表 · 增删行列
    // 调整单个分区的行列尺寸
    function trCustomResizeSection(section, rows, cols) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        const nextRows = trCustomClamp(rows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, safe.rows);
        const nextCols = trCustomClamp(cols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, safe.cols);
        const cells = trCustomResizeCells(safe.cells, safe.rows, safe.cols, nextRows, nextCols);
        return { title: safe.title, rows: nextRows, cols: nextCols, cells };
    }

    // 在分区内插入一行
    function trCustomInsertRowInSection(section, oneBasedRow) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        if (safe.rows >= TR_CUSTOM_MAX_ROWS) return null;
        const totalRow = trCustomGetTotalRowIndex(safe.rows);
        const pos = trCustomClamp(oneBasedRow, 2, safe.rows, 2);
        if (pos < 2) return null;
        let insertIndex = pos - 1;
        if (insertIndex > totalRow) insertIndex = totalRow;
        const nextRows = safe.rows + 1;
        const cells = safe.cells.map((row) => row.slice());
        cells.splice(insertIndex, 0, Array.from({ length: safe.cols }, () => ''));
        trCustomApplyTotalRowCells(cells, nextRows, safe.cols);
        return { title: safe.title, rows: nextRows, cols: safe.cols, cells };
    }

    // 在分区内插入一列
    function trCustomInsertColInSection(section, oneBasedCol) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        if (safe.cols >= TR_CUSTOM_MAX_COLS) return null;
        const pos = trCustomClamp(oneBasedCol, 2, safe.cols, 2);
        if (pos < 2) return null;
        const insertIndex = pos - 1;
        const nextCols = safe.cols + 1;
        const cells = safe.cells.map((row) => {
            const next = row.slice();
            next.splice(insertIndex, 0, '');
            return next;
        });
        trCustomApplyTotalRowCells(cells, safe.rows, nextCols);
        return { title: safe.title, rows: safe.rows, cols: nextCols, cells };
    }

    // 向当前草稿插入行
    function trCustomInsertDraftRow(oneBasedRow) {
        return trCustomUpdateActiveSection((section) => trCustomInsertRowInSection(section, oneBasedRow));
    }

    // 向当前草稿插入列
    function trCustomInsertDraftCol(oneBasedCol) {
        return trCustomUpdateActiveSection((section) => trCustomInsertColInSection(section, oneBasedCol));
    }

    // 从分区删除一行（保护表头与合计行）
    function trCustomDeleteRowInSection(section, oneBasedRow) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        if (safe.rows <= TR_CUSTOM_MIN_ROWS) return null;
        const totalRow = trCustomGetTotalRowIndex(safe.rows);
        const pos = trCustomClamp(oneBasedRow, 1, safe.rows, 1);
        const deleteIndex = pos - 1;
        if (deleteIndex === 0 || deleteIndex === totalRow) return null;
        const nextRows = safe.rows - 1;
        const cells = safe.cells.map((row) => row.slice());
        cells.splice(deleteIndex, 1);
        trCustomApplyTotalRowCells(cells, nextRows, safe.cols);
        return { title: safe.title, rows: nextRows, cols: safe.cols, cells };
    }

    // 从分区删除一列（保护首列）
    function trCustomDeleteColInSection(section, oneBasedCol) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        if (safe.cols <= TR_CUSTOM_MIN_COLS) return null;
        const pos = trCustomClamp(oneBasedCol, 1, safe.cols, 1);
        const deleteIndex = pos - 1;
        if (deleteIndex === 0) return null;
        const nextCols = safe.cols - 1;
        const cells = safe.cells.map((row) => {
            const next = row.slice();
            next.splice(deleteIndex, 1);
            return next;
        });
        trCustomApplyTotalRowCells(cells, safe.rows, nextCols);
        return { title: safe.title, rows: safe.rows, cols: nextCols, cells };
    }

    // 从当前草稿删除行
    function trCustomDeleteDraftRow(oneBasedRow) {
        return trCustomUpdateActiveSection((section) => trCustomDeleteRowInSection(section, oneBasedRow));
    }

    // 从当前草稿删除列
    function trCustomDeleteDraftCol(oneBasedCol) {
        return trCustomUpdateActiveSection((section) => trCustomDeleteColInSection(section, oneBasedCol));
    }

    // 判断外壳筛选是否至少选中一项
    function trCustomHasShellSelection() {
        return trSelectedYears.length > 0 || trSelectedCats.length > 0 || trShowTotal;
    }

    // 在网格指定位置插入列
    function trCustomInsertColumnAtGrid(grid, insertCol, fillFn) {
        if (!grid?.cells || grid.cols >= TR_CUSTOM_MAX_COLS) return false;
        const col = Math.max(1, Math.min(insertCol, grid.cols));
        grid.cells = grid.cells.map((row, r) => {
            const next = row.slice();
            next.splice(col, 0, fillFn(r, col));
            return next;
        });
        grid.cols += 1;
        trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        return true;
    }

    // 从网格删除指定列
    function trCustomRemoveColumnAtGrid(grid, col) {
        if (!grid?.cells || col < 1 || col >= grid.cols) return false;
        grid.cells.forEach((row) => row.splice(col, 1));
        grid.cols -= 1;
        trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        return true;
    }

    // 从网格删除指定行并维护合计行
    function trCustomRemoveRowAtGrid(grid, row) {
        if (!grid?.cells || row < 1 || row >= grid.rows) return false;
        grid.cells.splice(row, 1);
        grid.rows -= 1;
        trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        return true;
    }

    // 在网格指定位置插入行
    function trCustomInsertRowAtGrid(grid, insertRow, fillFn) {
        if (!grid?.cells || grid.rows >= TR_CUSTOM_MAX_ROWS) return false;
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        const row = Math.max(1, Math.min(insertRow, totalRow));
        const newRow = Array.from({ length: grid.cols }, (_, c) => fillFn(row, c));
        grid.cells.splice(row, 0, newRow);
        grid.rows += 1;
        trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        return true;
    }

    //#endregion

    //#region 自定义表 · 对齐年份分类
    // 返回表头扫描截止列（总额列之前）
    function trCustomGetHeaderScanEnd(grid) {
        const totalCol = trCustomGetTotalColIndex(grid);
        return totalCol > 0 ? totalCol : grid.cols;
    }

    // 判断文本是否为已知分类标签
    function trCustomIsCategoryLabel(label) {
        const text = String(label || '').trim();
        return TR_CATS.some((cat) => cat.label === text);
    }

    // 收集桌面端表头年份列索引
    function trCustomCollectYearSlotIndices(grid) {
        const end = trCustomGetHeaderScanEnd(grid);
        const indices = [];
        for (let c = 1; c < end; c += 1) {
            if (/^\d{4}$/.test(String(grid.cells[0]?.[c] || '').trim())) indices.push(c);
        }
        return indices;
    }

    // 收集移动端表头年份行索引
    function trCustomCollectYearSlotRows(grid) {
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        const indices = [];
        for (let r = 1; r < totalRow; r += 1) {
            if (/^\d{4}$/.test(String(grid.cells[r]?.[0] || '').trim())) indices.push(r);
        }
        return indices;
    }

    // 收集桌面端分类行索引
    function trCustomCollectCategorySlotRows(grid) {
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        const indices = [];
        for (let r = 1; r < totalRow; r += 1) {
            if (trCustomIsCategoryLabel(grid.cells[r]?.[0])) indices.push(r);
        }
        return indices;
    }

    // 收集移动端分类列索引
    function trCustomCollectCategorySlotCols(grid) {
        const end = trCustomGetHeaderScanEnd(grid);
        const indices = [];
        for (let c = 1; c < end; c += 1) {
            if (trCustomIsCategoryLabel(grid.cells[0]?.[c])) indices.push(c);
        }
        return indices;
    }

    // 计算受管槽位的新增插入位置
    function trCustomFindManagedSlotInsertIndex(slotIndices, orderIndex, grid, axis) {
        if (orderIndex < slotIndices.length) return slotIndices[orderIndex];
        return axis === 'col'
            ? trCustomFindLastFilledColInRow(grid, 0, 1) + 1
            : trCustomFindLastFilledRowInCol(grid, 0, 1) + 1;
    }

    // 桌面端写入年份列标题
    function trCustomAssignYearSlotsDesktop(grid, slotIndices, targetYears) {
        targetYears.forEach((year, index) => {
            const col = slotIndices[index];
            if (col == null) return;
            grid.cells[0][col] = String(year);
        });
    }

    // 移动端写入年份行标题
    function trCustomAssignYearSlotsMobile(grid, slotRows, targetYears) {
        targetYears.forEach((year, index) => {
            const row = slotRows[index];
            if (row == null) return;
            grid.cells[row][0] = String(year);
        });
    }

    // 桌面端同步网格年份列与筛选一致
    function trCustomSyncGridYearsDesktop(grid, targetYears) {
        let slotIndices = trCustomCollectYearSlotIndices(grid);
        for (let i = slotIndices.length - 1; i >= 0; i -= 1) {
            const col = slotIndices[i];
            const year = Number(String(grid.cells[0]?.[col] || '').trim());
            if (!targetYears.includes(year)) trCustomRemoveColumnAtGrid(grid, col);
        }

        slotIndices = trCustomCollectYearSlotIndices(grid);
        let currentYears = slotIndices.map((col) => Number(String(grid.cells[0][col]).trim()));
        targetYears.forEach((year) => {
            if (currentYears.includes(year)) return;
            slotIndices = trCustomCollectYearSlotIndices(grid);
            const orderIndex = targetYears.indexOf(year);
            const isAppend = orderIndex >= slotIndices.length;
            if (isAppend && trCustomTryFillGapSlot(grid, 'col', year)) {
                slotIndices = trCustomCollectYearSlotIndices(grid);
                currentYears = slotIndices.map((col) => Number(String(grid.cells[0][col]).trim()));
                return;
            }
            const insertCol = trCustomFindManagedSlotInsertIndex(slotIndices, orderIndex, grid, 'col');
            trCustomInsertColumnAtGrid(grid, insertCol, (r) => (r === 0 ? String(year) : ''));
            slotIndices = trCustomCollectYearSlotIndices(grid);
            currentYears = slotIndices.map((col) => Number(String(grid.cells[0][col]).trim()));
        });

        slotIndices = trCustomCollectYearSlotIndices(grid);
        while (slotIndices.length > targetYears.length) {
            trCustomRemoveColumnAtGrid(grid, slotIndices[slotIndices.length - 1]);
            slotIndices = trCustomCollectYearSlotIndices(grid);
        }

        slotIndices = trCustomCollectYearSlotIndices(grid);
        trCustomAssignYearSlotsDesktop(grid, slotIndices, targetYears);
    }

    // 移动端同步网格年份行与筛选一致
    function trCustomSyncGridYearsMobile(grid, targetYears) {
        let slotRows = trCustomCollectYearSlotRows(grid);
        for (let i = slotRows.length - 1; i >= 0; i -= 1) {
            const row = slotRows[i];
            const year = Number(String(grid.cells[row]?.[0] || '').trim());
            if (!targetYears.includes(year)) trCustomRemoveRowAtGrid(grid, row);
        }

        slotRows = trCustomCollectYearSlotRows(grid);
        let currentYears = slotRows.map((row) => Number(String(grid.cells[row][0]).trim()));
        targetYears.forEach((year) => {
            if (currentYears.includes(year)) return;
            slotRows = trCustomCollectYearSlotRows(grid);
            const orderIndex = targetYears.indexOf(year);
            const isAppend = orderIndex >= slotRows.length;
            if (isAppend && trCustomTryFillGapSlot(grid, 'row', year)) {
                slotRows = trCustomCollectYearSlotRows(grid);
                currentYears = slotRows.map((row) => Number(String(grid.cells[row][0]).trim()));
                return;
            }
            const insertRow = trCustomFindManagedSlotInsertIndex(slotRows, orderIndex, grid, 'row');
            trCustomInsertRowAtGrid(grid, insertRow, (r, c) => (c === 0 ? String(year) : ''));
            slotRows = trCustomCollectYearSlotRows(grid);
            currentYears = slotRows.map((row) => Number(String(grid.cells[row][0]).trim()));
        });

        slotRows = trCustomCollectYearSlotRows(grid);
        while (slotRows.length > targetYears.length) {
            trCustomRemoveRowAtGrid(grid, slotRows[slotRows.length - 1]);
            slotRows = trCustomCollectYearSlotRows(grid);
        }

        slotRows = trCustomCollectYearSlotRows(grid);
        trCustomAssignYearSlotsMobile(grid, slotRows, targetYears);
    }

    // 桌面端写入分类行标题
    function trCustomAssignCategorySlotsDesktop(grid, slotRows, orderedCats) {
        orderedCats.forEach((cat, index) => {
            const row = slotRows[index];
            if (row == null) return;
            grid.cells[row][0] = cat.label;
        });
    }

    // 移动端写入分类列标题
    function trCustomAssignCategorySlotsMobile(grid, slotCols, orderedCats) {
        orderedCats.forEach((cat, index) => {
            const col = slotCols[index];
            if (col == null) return;
            grid.cells[0][col] = cat.label;
        });
    }

    // 桌面端同步网格分类行与筛选一致
    function trCustomSyncGridCatsDesktop(grid, orderedCats) {
        const targetLabels = orderedCats.map((cat) => cat.label);
        let slotRows = trCustomCollectCategorySlotRows(grid);
        for (let i = slotRows.length - 1; i >= 0; i -= 1) {
            const row = slotRows[i];
            const label = String(grid.cells[row]?.[0] || '').trim();
            if (!targetLabels.includes(label)) trCustomRemoveRowAtGrid(grid, row);
        }

        slotRows = trCustomCollectCategorySlotRows(grid);
        let currentLabels = slotRows.map((row) => String(grid.cells[row][0]).trim());
        orderedCats.forEach((cat, orderIndex) => {
            if (currentLabels.includes(cat.label)) return;
            slotRows = trCustomCollectCategorySlotRows(grid);
            const isAppend = orderIndex >= slotRows.length;
            if (isAppend && trCustomTryFillGapSlot(grid, 'row', cat.label)) {
                slotRows = trCustomCollectCategorySlotRows(grid);
                currentLabels = slotRows.map((row) => String(grid.cells[row][0]).trim());
                return;
            }
            const insertRow = trCustomFindManagedSlotInsertIndex(slotRows, orderIndex, grid, 'row');
            trCustomInsertRowAtGrid(grid, insertRow, (r, c) => (c === 0 ? cat.label : ''));
            slotRows = trCustomCollectCategorySlotRows(grid);
            currentLabels = slotRows.map((row) => String(grid.cells[row][0]).trim());
        });

        slotRows = trCustomCollectCategorySlotRows(grid);
        while (slotRows.length > targetLabels.length) {
            trCustomRemoveRowAtGrid(grid, slotRows[slotRows.length - 1]);
            slotRows = trCustomCollectCategorySlotRows(grid);
        }

        slotRows = trCustomCollectCategorySlotRows(grid);
        trCustomAssignCategorySlotsDesktop(grid, slotRows, orderedCats);
    }

    // 移动端同步网格分类列与筛选一致
    function trCustomSyncGridCatsMobile(grid, orderedCats) {
        const targetLabels = orderedCats.map((cat) => cat.label);
        let slotCols = trCustomCollectCategorySlotCols(grid);
        for (let i = slotCols.length - 1; i >= 0; i -= 1) {
            const col = slotCols[i];
            const label = String(grid.cells[0]?.[col] || '').trim();
            if (!targetLabels.includes(label)) trCustomRemoveColumnAtGrid(grid, col);
        }

        slotCols = trCustomCollectCategorySlotCols(grid);
        let currentLabels = slotCols.map((col) => String(grid.cells[0][col]).trim());
        orderedCats.forEach((cat, orderIndex) => {
            if (currentLabels.includes(cat.label)) return;
            slotCols = trCustomCollectCategorySlotCols(grid);
            const isAppend = orderIndex >= slotCols.length;
            if (isAppend && trCustomTryFillGapSlot(grid, 'col', cat.label)) {
                slotCols = trCustomCollectCategorySlotCols(grid);
                currentLabels = slotCols.map((col) => String(grid.cells[0][col]).trim());
                return;
            }
            const insertCol = trCustomFindManagedSlotInsertIndex(slotCols, orderIndex, grid, 'col');
            trCustomInsertColumnAtGrid(grid, insertCol, (r) => (r === 0 ? cat.label : ''));
            slotCols = trCustomCollectCategorySlotCols(grid);
            currentLabels = slotCols.map((col) => String(grid.cells[0][col]).trim());
        });

        slotCols = trCustomCollectCategorySlotCols(grid);
        while (slotCols.length > targetLabels.length) {
            trCustomRemoveColumnAtGrid(grid, slotCols[slotCols.length - 1]);
            slotCols = trCustomCollectCategorySlotCols(grid);
        }

        slotCols = trCustomCollectCategorySlotCols(grid);
        trCustomAssignCategorySlotsMobile(grid, slotCols, orderedCats);
    }

    // 根据矩阵尺寸解析总额列索引
    function trCustomResolveTotalColIndex(rows, cols, cells) {
        const lastCol = Math.max(0, Math.trunc(cols) - 1);
        return cols >= 2 && String(cells?.[0]?.[lastCol] || '').trim() === '总额' ? lastCol : -1;
    }

    // 返回网格末列总额列索引
    function trCustomGetTotalColIndex(grid) {
        if (!grid?.cells || grid.cols < 2) return -1;
        return trCustomResolveTotalColIndex(grid.rows, grid.cols, grid.cells);
    }

    // 判断单元格是否为自动合计格（不可编辑）
    function trCustomIsComputedSumCell(row, col, rows, cols, cells) {
        const totalCol = trCustomResolveTotalColIndex(rows, cols, cells);
        if (totalCol < 1) return false;
        const totalRow = trCustomGetTotalRowIndex(rows);
        if (row === totalRow && col > 0) return true;
        if (col === totalCol && row > 0 && row < totalRow) return true;
        return false;
    }

    // 判断是否为受保护的「总额」表头格
    function trCustomIsProtectedTotalLabelCell(row, col, rows, cols, cells) {
        const totalCol = trCustomResolveTotalColIndex(rows, cols, cells);
        return totalCol >= 0 && row === 0 && col === totalCol;
    }

    // 重算网格内行列合计与总计
    function trCustomApplyComputedSums(grid) {
        if (!grid?.cells) return grid;
        const totalCol = trCustomGetTotalColIndex(grid);
        if (totalCol < 1) return grid;
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        const rows = grid.rows;
        const cols = grid.cols;

        for (let c = 1; c < totalCol; c += 1) {
            let colSum = 0;
            for (let r = 1; r < totalRow; r += 1) {
                colSum += trCustomParseNumeric(grid.cells[r]?.[c]);
            }
            if (!Array.isArray(grid.cells[totalRow])) grid.cells[totalRow] = [];
            grid.cells[totalRow][c] = trFmt(formatCategoryDisplay(colSum));
        }

        for (let r = 1; r < totalRow; r += 1) {
            let rowSum = 0;
            for (let c = 1; c < totalCol; c += 1) {
                rowSum += trCustomParseNumeric(grid.cells[r]?.[c]);
            }
            if (!Array.isArray(grid.cells[r])) grid.cells[r] = [];
            grid.cells[r][totalCol] = trFmt(formatCategoryDisplay(rowSum));
        }

        let grand = 0;
        for (let r = 1; r < totalRow; r += 1) {
            for (let c = 1; c < totalCol; c += 1) {
                grand += trCustomParseNumeric(grid.cells[r]?.[c]);
            }
        }
        if (!Array.isArray(grid.cells[totalRow])) grid.cells[totalRow] = [];
        grid.cells[totalRow][totalCol] = trFmt(formatCategoryDisplay(grand));
        return grid;
    }

    // 按开关显示或隐藏总额列并重算合计
    function trCustomSyncTotalColumn(grid, showTotal) {
        let changed = false;
        let totalCol = trCustomFindTotalCol(grid, 0);
        if (!showTotal) {
            if (totalCol > 0) return trCustomRemoveColumnAtGrid(grid, totalCol);
            return false;
        }

        if (totalCol >= 0 && totalCol !== grid.cols - 1) {
            trCustomRemoveColumnAtGrid(grid, totalCol);
            changed = true;
            totalCol = -1;
        }

        if (trCustomGetTotalColIndex(grid) < 0) {
            if (grid.cols >= TR_CUSTOM_MAX_COLS) return changed;
            trCustomInsertColumnAtGrid(grid, grid.cols, (r) => (r === 0 ? '总额' : ''));
            changed = true;
        }

        grid.cells[0][grid.cols - 1] = '总额';
        trCustomApplyComputedSums(grid);
        return true;
    }

    // 按当前视口同步网格年份轴
    function trCustomSyncGridYears(grid, selectedYears) {
        const targetYears = selectedYears.slice().sort((a, b) => a - b);
        if (trIsMobile()) trCustomSyncGridYearsMobile(grid, targetYears);
        else trCustomSyncGridYearsDesktop(grid, targetYears);
    }

    // 按当前视口同步网格分类轴
    function trCustomSyncGridCats(grid, cats) {
        const orderedCats = cats.slice();
        if (trIsMobile()) trCustomSyncGridCatsMobile(grid, orderedCats);
        else trCustomSyncGridCatsDesktop(grid, orderedCats);
    }
    //#endregion

    //#region 自定义表 · 排版与填数
    // 将外壳筛选增量同步到当前活动表格
    function trCustomSyncSummarySelectionIncremental() {
        if (!trCustomDraft) return false;
        trCustomEnsureReportTables(trCustomDraft);
        const cats = getTrDisplayCats();
        const idx = trCustomGetActiveTableIndex(trCustomDraft);
        const section = trCustomNormalizeSection(trCustomDraft.sections[idx], trCustomDraft.rows, trCustomDraft.cols);
        trCustomSyncGridYears(section, trSelectedYears);
        trCustomSyncGridCats(section, cats);
        trCustomSyncTotalColumn(section, trShowTotal);
        trCustomDraft.sections[idx] = section;
        trCustomSyncPrimaryFromSection(idx);
        return true;
    }

    // 外壳筛选变更时刷新自定义表格
    async function trCustomOnSelectionChanged() {
        if (!trCustomDraft || trMode !== 'custom') return;
        trSaveActiveToMode();
        if (!trCustomHasShellSelection()) return;
        trCustomSyncSummarySelectionIncremental();
        await trCustomFillDraftIntersections();
    }

    // 从表格结构反推年份、分类与总额开关
    function trCustomInferSelectionFromSection(section) {
        const grid = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        const years = new Set();
        const corner = String(grid.cells[0]?.[0] || '').trim();
        if (/^\d{4}$/.test(corner)) years.add(Number(corner));

        if (trIsMobile()) {
            trCustomCollectYearSlotRows(grid).forEach((rowIndex) => {
                const year = Number(String(grid.cells[rowIndex]?.[0] || '').trim());
                if (year >= 2000) years.add(year);
            });
        } else {
            trCustomCollectYearSlotIndices(grid).forEach((colIndex) => {
                const year = Number(String(grid.cells[0]?.[colIndex] || '').trim());
                if (year >= 2000) years.add(year);
            });
        }

        const catKeys = [];
        if (trIsMobile()) {
            trCustomCollectCategorySlotCols(grid).forEach((colIndex) => {
                const cat = trCustomFindCatByLabel(String(grid.cells[0]?.[colIndex] || '').trim());
                if (cat && !catKeys.includes(cat.key)) catKeys.push(cat.key);
            });
        } else {
            trCustomCollectCategorySlotRows(grid).forEach((rowIndex) => {
                const cat = trCustomFindCatByLabel(String(grid.cells[rowIndex]?.[0] || '').trim());
                if (cat && !catKeys.includes(cat.key)) catKeys.push(cat.key);
            });
        }

        const cats = TR_CATS.map((cat) => cat.key).filter((key) => catKeys.includes(key));
        return {
            years: [...years].sort((a, b) => a - b),
            cats,
            showTotal: trCustomGetTotalColIndex(grid) > 0,
        };
    }

    // 用活动表格结构回写外壳筛选状态
    function trCustomSyncShellFromActiveTable() {
        if (trMode !== 'custom' || !trCustomDraft) return false;
        trCustomEnsureReportTables(trCustomDraft);
        const idx = trCustomGetActiveTableIndex(trCustomDraft);
        const section = trCustomDraft.sections[idx];
        if (!section) return false;
        const inferred = trCustomInferSelectionFromSection(section);
        trSelectedYears = inferred.years.slice();
        trSelectedCats = inferred.cats.slice();
        trShowTotal = inferred.showTotal;
        trSaveActiveToMode();
        return true;
    }

    // 将首表分区同步到草稿顶层 cells 字段
    function trCustomSyncDraftPrimaryGrid() {
        if (!trCustomDraft) return;
        const safe = trCustomNormalizeTemplate(trCustomDraft);
        if (trCustomIsMultiLayout(safe) && safe.sections[0]) {
            trCustomDraft.rows = safe.sections[0].rows;
            trCustomDraft.cols = safe.sections[0].cols;
            trCustomDraft.cells = safe.sections[0].cells.map((row) => row.slice());
        }
    }

    // 判断标签是否为四位年份
    function trCustomIsYearHeaderLabel(label) {
        return /^\d{4}$/.test(String(label || '').trim());
    }

    // 判断标签是否为月份缩写
    function trCustomIsMonthHeaderLabel(label) {
        return trCustomParseMonthHeader(label) >= 0;
    }

    // 桌面端移除表头中的年份或月份列
    function trCustomStripHeaderPeriodColumns(grid, removeYears, removeMonths) {
        if (!grid?.cells) return;
        let end = trCustomGetHeaderScanEnd(grid);
        for (let c = end - 1; c >= 1; c -= 1) {
            const label = String(grid.cells[0]?.[c] || '').trim();
            const isYear = trCustomIsYearHeaderLabel(label);
            const isMonth = trCustomIsMonthHeaderLabel(label);
            if ((removeYears && isYear) || (removeMonths && isMonth)) {
                trCustomRemoveColumnAtGrid(grid, c);
                end = trCustomGetHeaderScanEnd(grid);
            }
        }
    }

    // 移动端移除表头中的年份或月份行
    function trCustomStripHeaderPeriodRows(grid, removeYears, removeMonths) {
        if (!grid?.cells) return;
        let totalRow = trCustomGetTotalRowIndex(grid.rows);
        for (let r = totalRow - 1; r >= 1; r -= 1) {
            const label = String(grid.cells[r]?.[0] || '').trim();
            const isYear = trCustomIsYearHeaderLabel(label);
            const isMonth = trCustomIsMonthHeaderLabel(label);
            if ((removeYears && isYear) || (removeMonths && isMonth)) {
                trCustomRemoveRowAtGrid(grid, r);
                totalRow = trCustomGetTotalRowIndex(grid.rows);
            }
        }
    }

    // 按视口移除表头周期标签（年/月）
    function trCustomStripHeaderPeriods(grid, removeYears, removeMonths) {
        if (trIsMobile()) trCustomStripHeaderPeriodRows(grid, removeYears, removeMonths);
        else trCustomStripHeaderPeriodColumns(grid, removeYears, removeMonths);
    }

    // 原地扩展网格至最小行列数
    function trCustomEnsureGridSize(grid, minRows, minCols) {
        const nextRows = Math.min(TR_CUSTOM_MAX_ROWS, Math.max(grid.rows, minRows));
        const nextCols = Math.min(TR_CUSTOM_MAX_COLS, Math.max(grid.cols, minCols));
        if (nextRows === grid.rows && nextCols === grid.cols) return grid;
        const sized = trCustomEnsureDraftSize(grid, nextRows, nextCols);
        grid.rows = sized.rows;
        grid.cols = sized.cols;
        grid.cells = sized.cells;
        return grid;
    }

    // 收集表头已有周期标签的规范化键
    function trCustomCollectExistingHeaderPeriodKeys(grid) {
        const keys = new Set();
        if (trIsMobile()) {
            const totalRow = trCustomGetTotalRowIndex(grid.rows);
            for (let r = 1; r < totalRow; r += 1) {
                const label = String(grid.cells[r]?.[0] || '').trim();
                if (label) keys.add(trCustomNormalizePeriodLabel(label));
            }
            return keys;
        }
        for (let c = 1; c < grid.cols; c += 1) {
            const label = String(grid.cells[0]?.[c] || '').trim();
            if (label && label !== '总额') keys.add(trCustomNormalizePeriodLabel(label));
        }
        return keys;
    }

    // 追加表头中缺失的周期标签
    function trCustomAppendMissingHeaderPeriods(grid, labels) {
        const list = (Array.isArray(labels) ? labels : []).map((label) => String(label));
        if (!list.length) return grid;
        const existing = trCustomCollectExistingHeaderPeriodKeys(grid);
        const toAdd = list.filter((label) => !existing.has(trCustomNormalizePeriodLabel(label)));
        if (!toAdd.length) return grid;
        if (trIsMobile()) {
            const startRow = trCustomFindLastFilledRowInCol(grid, 0, 1) + 1;
            return trCustomWriteContinuousHeaderRows(grid, toAdd, startRow);
        }
        const startCol = trCustomFindLastFilledColInRow(grid, 0, 1) + 1;
        return trCustomWriteContinuousHeaderColumns(grid, toAdd, startCol);
    }

    // 从指定列起连续写入表头列标签
    function trCustomWriteContinuousHeaderColumns(grid, labels, startCol) {
        const list = Array.isArray(labels) ? labels : [];
        if (!list.length) return grid;
        const needCols = startCol + list.length;
        trCustomEnsureGridSize(grid, grid.rows, needCols);
        list.forEach((label, index) => {
            grid.cells[0][startCol + index] = String(label);
        });
        return grid;
    }

    // 从指定行起连续写入表头行标签
    function trCustomWriteContinuousHeaderRows(grid, labels, startRow) {
        const list = Array.isArray(labels) ? labels : [];
        if (!list.length) return grid;
        const needRows = startRow + list.length + 1;
        trCustomEnsureGridSize(grid, needRows, grid.cols);
        list.forEach((label, index) => {
            grid.cells[startRow + index][0] = String(label);
        });
        trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        return grid;
    }

    // 按视口连续追加周期表头（年/月）
    function trCustomWriteContinuousPeriodHeaders(grid, labels) {
        if (trIsMobile()) {
            const startRow = trCustomFindLastFilledRowInCol(grid, 0, 1) + 1;
            return trCustomWriteContinuousHeaderRows(grid, labels, startRow);
        }
        const startCol = trCustomFindLastFilledColInRow(grid, 0, 1) + 1;
        return trCustomWriteContinuousHeaderColumns(grid, labels, startCol);
    }

    // 将多表草稿折叠为单表结构
    function trCustomCollapseToSingleGrid(draft) {
        const safe = trCustomCloneTemplate(draft);
        if (trCustomIsMultiLayout(safe) && safe.sections[0]) {
            const first = trCustomNormalizeSection(safe.sections[0], safe.rows, safe.cols);
            return {
                layout: 'single',
                rows: first.rows,
                cols: first.cols,
                cells: first.cells.map((row) => row.slice()),
                sections: [],
            };
        }
        return { ...safe, sections: [] };
    }

    // 清除左上角误放的周期标签
    function trCustomClearPeriodLabelFromCorner(grid) {
        if (!grid?.cells) return;
        const corner = String(grid.cells[0]?.[0] || '').trim();
        if (trCustomIsYearHeaderLabel(corner) || trCustomIsMonthHeaderLabel(corner)) {
            grid.cells[0][0] = trCustomDefaultCellValue(0, 0, grid.rows);
        }
    }

    // 将网格表头设为指定年份加十二个月
    function trCustomApplyMonthHeadersToGrid(grid, year) {
        if (!grid?.cells) return grid;
        trCustomStripHeaderPeriods(grid, true, true);
        grid.cells[0][0] = String(year);
        if (trIsMobile()) {
            trCustomWriteContinuousHeaderRows(grid, MON, 1);
        } else {
            trCustomWriteContinuousHeaderColumns(grid, MON, 1);
        }
        return grid;
    }

    // 构建标准月报批量分区（14列6行）
    function trCustomBuildMonthBatchSection(year) {
        const rows = TR_CUSTOM_MONTH_BATCH_ROWS;
        const cols = TR_CUSTOM_MONTH_BATCH_COLS;
        const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, () => ''));
        cells[0][0] = String(year);
        MON.forEach((label, index) => {
            cells[0][index + 1] = label;
        });
        cells[0][cols - 1] = '总额';
        trCustomApplyTotalRowCells(cells, rows, cols);
        return trCustomNormalizeSection({
            title: String(year),
            rows,
            cols,
            cells,
        }, rows, cols);
    }

    // 加载账本数据并填充分区交叉单元格
    async function trCustomFillSectionIntersections(section) {
        const normalized = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        const cornerYear = Number(String(normalized.cells[0]?.[0] || '').trim());
        const sectionYear = Number.isFinite(cornerYear) && /^\d{4}$/.test(String(normalized.cells[0]?.[0] || '').trim())
            ? cornerYear
            : NaN;
        const yearsToLoad = trCustomCollectYearsReferencedByGrid(normalized, sectionYear);
        await Promise.all(yearsToLoad.map((y) => trEnsureYear(y)));
        trCustomFillGridIntersections(normalized, { sectionYear });
        return normalized;
    }

    // 登记下次渲染后滚动到的表格索引
    function trCustomQueueScrollToTable(index) {
        if (!Number.isInteger(index) || index < 0) return;
        trCustomScrollToTableOnRender = index;
    }

    // 将表格容器滚动到指定分区居中
    function trCustomPerformScrollToTable(index) {
        const wrap = document.getElementById('trCustomTableWrap');
        const target = document.querySelector(`.tr-custom-section[data-table-index="${index}"]`);
        if (!wrap || !target) return;
        const wrapRect = wrap.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop = targetRect.top - wrapRect.top + wrap.scrollTop - (wrap.clientHeight / 2) + (targetRect.height / 2);
        wrap.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
    }

    // 基于原型构建单月布局分区
    function trCustomBuildMonthLayoutSection(prototype, year, sizeCount) {
        const safeProto = trCustomNormalizeSection(prototype, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        if (trIsMobile()) {
            const colCount = trCustomClamp(sizeCount, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, safeProto.cols);
            let section = {
                title: String(year),
                rows: safeProto.rows,
                cols: Math.max(colCount, MON.length + 1),
                cells: Array.from({ length: safeProto.rows }, (_, r) => Array.from({ length: Math.max(colCount, MON.length + 1) }, (_, c) => {
                    if (r < safeProto.rows && c < safeProto.cols) return safeProto.cells[r][c] || '';
                    return trCustomDefaultCellValue(r, c, safeProto.rows);
                })),
            };
            section = trCustomNormalizeSection(section, safeProto.rows, Math.max(colCount, MON.length + 1));
            trCustomApplyMonthHeadersToGrid(section, year);
            section.title = String(year);
            return section;
        }

        const rowCount = trCustomClamp(sizeCount, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, safeProto.rows);
        let section = {
            title: String(year),
            rows: rowCount,
            cols: Math.max(safeProto.cols, MON.length + 1),
            cells: Array.from({ length: rowCount }, (_, r) => Array.from({ length: Math.max(safeProto.cols, MON.length + 1) }, (_, c) => {
                if (r < safeProto.rows && c < safeProto.cols) return safeProto.cells[r][c] || '';
                return trCustomDefaultCellValue(r, c, rowCount);
            })),
        };
        section = trCustomNormalizeSection(section, rowCount, Math.max(safeProto.cols, MON.length + 1));
        trCustomApplyMonthHeadersToGrid(section, year);
        section.title = String(year);
        return section;
    }

    // 应用年份布局：表头铺满全部年份
    async function trCustomApplyYearLayout() {
        const allYears = trGetAllYears();
        if (!allYears.length) return false;

        trSelectedYears = allYears.slice();
        saveTrPrefs();
        trRenderYearFilter(allYears);

        trCustomEnsureReportTables(trCustomDraft);
        const idx = trCustomGetActiveTableIndex(trCustomDraft);
        const section = trCustomNormalizeSection(trCustomDraft.sections[idx], trCustomDraft.rows, trCustomDraft.cols);
        trCustomStripHeaderPeriods(section, false, true);
        trCustomClearPeriodLabelFromCorner(section);
        const sortedYears = allYears.slice().sort((a, b) => a - b).map((year) => String(year));
        trCustomAppendMissingHeaderPeriods(section, sortedYears);
        trCustomDraft.sections[idx] = section;
        trCustomDraft.layout = 'year';
        trCustomSyncPrimaryFromSection(idx);
        await trCustomFillDraftIntersections();
        return true;
    }

    // 应用月份布局：为每个选中年份追加月表
    async function trCustomApplyMonthLayout() {
        const years = await trCustomEnsureSelectedYearsLoaded();
        if (!years.length) return false;

        trCustomEnsureReportTables(trCustomDraft);
        const sortedYears = years.slice().sort((a, b) => a - b);
        const firstNewIndex = trCustomDraft.sections.length;

        for (const year of sortedYears) {
            let section = trCustomBuildMonthBatchSection(year);
            section.title = `表格 ${trCustomDraft.sections.length + 1}`;
            section = await trCustomFillSectionIntersections(section);
            trCustomDraft.sections.push(section);
        }

        trCustomDraft.layout = 'month';
        trCustomActiveTableIndex = firstNewIndex;
        trCustomSyncPrimaryFromSection(firstNewIndex);
        trCustomQueueScrollToTable(firstNewIndex);
        return true;
    }

    // 应用自定义布局：复制原型生成多表
    function trCustomApplyCustomLayout(count = trCustomLayoutCustomCount) {
        const tableCount = trCustomClamp(count, TR_CUSTOM_MIN_SECTION_COUNT, TR_CUSTOM_MAX_SECTION_COUNT, 2);
        const prototype = trCustomGetPrototypeGrid(trCustomDraft);
        const sections = Array.from({ length: tableCount }, (_, index) => {
            const section = trCustomCloneSectionStructure(prototype);
            section.title = `表格 ${index + 1}`;
            return section;
        });
        const first = sections[0];
        trCustomDraft = {
            layout: 'custom',
            rows: first.rows,
            cols: first.cols,
            cells: first.cells.map((row) => row.slice()),
            sections,
        };
        trCustomLayoutCustomCount = tableCount;
        return true;
    }
    //#endregion

    //#region 自定义表 · 保存与载入
    // 解析单元格文本为数值（支持简单算式）
    function trCustomParseNumeric(value) {
        const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
        if (!raw) return 0;
        if (/^[\d+\-*/().\s]+$/.test(raw) && /[+\-*/()]/.test(raw)) {
            try {
                const result = Function(`"use strict"; return (${raw});`)();
                return Number.isFinite(result) ? Number(result) : 0;
            } catch (_) {
                return 0;
            }
        }
        const cleaned = raw.replace(/,/g, '');
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : 0;
    }

    // 计算模板各列数据合计
    function trCustomComputeColumnSums(template) {
        const safe = trCustomNormalizeTemplate(template);
        return trCustomComputeColumnSumsFromGrid(safe.cells, safe.rows, safe.cols);
    }

    // 序列化草稿用于脏检查与保存
    function trCustomSerializeDraft(template, templateId = trCustomCurrentId) {
        return JSON.stringify({
            id: templateId || null,
            data: trCustomNormalizeTemplate(template),
        });
    }

    // 标记草稿为已保存状态
    function trCustomMarkClean(template = trCustomDraft, templateId = trCustomCurrentId) {
        if (!template) {
            trCustomSavedSnapshot = null;
            return;
        }
        trCustomSavedSnapshot = trCustomSerializeDraft(template, templateId);
        trCustomRefreshStatus();
    }

    // 判断草稿相对上次保存是否有改动
    function trCustomIsDirty() {
        if (!trCustomDraft || trCustomSavedSnapshot === null) return false;
        return trCustomSerializeDraft(trCustomDraft, trCustomCurrentId) !== trCustomSavedSnapshot;
    }

    // 解析操作引导文案
    function trCustomResolveGuide(key, params = {}) {
        const entry = TR_CUSTOM_GUIDES[key];
        if (!entry) return '';
        return typeof entry === 'function' ? entry(params) : entry;
    }

    // 返回当前场景的基础引导键
    function trCustomGetBaseGuideKey() {
        return trCustomPendingDraft && trCustomCurrentId === null ? 'create' : 'edit';
    }

    // 清除状态栏自动隐藏定时器
    function trCustomClearStatusTimer() {
        if (trCustomStatusHideTimer) {
            clearTimeout(trCustomStatusHideTimer);
            trCustomStatusHideTimer = null;
        }
    }

    // 清空工具栏状态提示
    function trCustomClearStatus() {
        trCustomClearStatusTimer();
        trCustomStatus = { guideKey: '', guideText: '', tone: '' };
        trCustomRefreshStatus();
    }

    // 设置工具栏引导文案
    function trCustomSetGuide(key, refresh = true) {
        trCustomClearStatusTimer();
        trCustomStatus.guideKey = key;
        trCustomStatus.guideText = trCustomResolveGuide(key);
        if (trCustomStatus.tone !== 'error') {
            trCustomStatus.tone = '';
        }
        if (refresh) trCustomRefreshStatus();
    }

    // 恢复默认引导或清空状态栏
    function trCustomRestoreBaseGuide() {
        if (!trCustomToolbarExpanded) {
            trCustomClearStatus();
            return;
        }
        trCustomSetGuide(trCustomGetBaseGuideKey(), false);
        trCustomStatus.tone = '';
    }

    // 短暂显示操作反馈后恢复引导
    function trCustomArmStatusFlash(key, params = {}, ms = TR_CUSTOM_STATUS_FLASH_MS) {
        trCustomSetGuide(key, false);
        trCustomStatus.guideText = trCustomResolveGuide(key, params);
        trCustomStatus.tone = '';
        trCustomClearStatusTimer();
        trCustomStatusHideTimer = setTimeout(() => {
            trCustomStatusHideTimer = null;
            trCustomRestoreBaseGuide();
            trCustomRefreshStatus();
        }, ms);
        trCustomRefreshStatus();
    }

    // 在工具栏显示错误提示
    function trCustomSetError(message, hintKey = '') {
        if (!trCustomToolbarExpanded) return;
        const hint = hintKey ? trCustomResolveGuide(hintKey) : '';
        trCustomStatus.guideText = hint ? `${message} ${hint}` : String(message || '操作失败');
        trCustomStatus.tone = 'error';
        trCustomClearStatusTimer();
        trCustomStatusHideTimer = setTimeout(() => {
            trCustomStatusHideTimer = null;
            trCustomRestoreBaseGuide();
            trCustomRefreshStatus();
        }, TR_CUSTOM_STATUS_ERROR_MS);
        trCustomRefreshStatus();
    }

    // 组装状态栏展示文本与色调
    function trCustomGetDisplayStatus() {
        if (!trCustomToolbarExpanded) {
            return { text: '', tone: '', show: false };
        }
        const bits = [];
        const label = trCustomCurrentId ? `表格 ${trCustomGetTemplateButtonLabel(trCustomCurrentId)}` : '新表格';
        bits.push(label);
        const guideText = trCustomStatus.guideText || trCustomResolveGuide(trCustomGetBaseGuideKey());
        if (guideText) bits.push(guideText);
        if (trCustomIsDirty() && trCustomStatus.tone !== 'error') {
            bits.push('有未保存修改');
        }
        const tone = trCustomStatus.tone || (trCustomIsDirty() ? 'dirty' : '');
        return { text: bits.join(' · '), tone, show: true };
    }

    // 刷新工具栏状态栏 DOM
    function trCustomRefreshStatus() {
        const statusRow = document.querySelector('.tr-custom-status-row');
        const statusEl = document.getElementById('trCustomStatusText');
        const display = trCustomGetDisplayStatus();
        if (statusRow) {
            statusRow.style.display = display.show ? 'flex' : 'none';
        }
        if (!statusEl) return;
        statusEl.textContent = display.text;
        statusEl.dataset.tone = display.tone || '';
    }

    // 隐藏自定义确认弹层
    function trCustomHideConfirm() {
        hideConfirmLayer(document.getElementById('trCustomConfirmLayer'));
    }

    // 结束确认弹层并回调结果
    function trCustomResolveConfirm(result) {
        trCustomHideConfirm();
        if (!trCustomConfirmResolver) return;
        const resolver = trCustomConfirmResolver;
        trCustomConfirmResolver = null;
        resolver(result);
    }

    // 显示确认弹层（无 DOM 时降级 confirm）
    function trCustomConfirm(message) {
        return new Promise((resolve) => {
            const layer = document.getElementById('trCustomConfirmLayer');
            const textEl = document.getElementById('trCustomConfirmText');
            if (!layer || !textEl) {
                resolve(window.confirm(message));
                return;
            }
            if (trCustomConfirmResolver) {
                trCustomResolveConfirm(false);
            }
            trCustomConfirmResolver = resolve;
            textEl.textContent = message;
            showConfirmLayer(layer);
        });
    }

    // 绑定确认弹层按钮事件（仅一次）
    function trCustomEnsureConfirmBound() {
        if (trCustomConfirmBound) return;
        trCustomConfirmBound = true;
        const layer = document.getElementById('trCustomConfirmLayer');
        const confirmBtn = document.getElementById('trCustomConfirmBtn');
        const cancelBtn = document.getElementById('trCustomConfirmCancelBtn');
        if (confirmBtn) confirmBtn.addEventListener('click', () => trCustomResolveConfirm(true));
        if (cancelBtn) cancelBtn.addEventListener('click', () => trCustomResolveConfirm(false));
        if (layer) {
            layer.addEventListener('click', (event) => {
                if (event.target === layer) trCustomResolveConfirm(false);
            });
        }
    }

    // 脏数据时先确认再执行任务
    async function trCustomRunIfAllowed(message, task, options = {}) {
        const alwaysConfirm = Boolean(options && options.alwaysConfirm);
        if (!alwaysConfirm && !trCustomIsDirty()) {
            await task();
            return true;
        }
        if (!(await trCustomConfirm(message))) return false;
        await task();
        return true;
    }

    // 广播自定义表格列表已更新
    function trCustomEmitUpdate() {
        document.dispatchEvent(new CustomEvent('yybbq-custom-table-updated'));
    }

    // 应用服务端返回的模板列表
    function trCustomApplyTemplateList(list) {
        const safeList = Array.isArray(list) ? list : [];
        trCustomTemplates = safeList
            .map((item) => {
                const data = trCustomCloneTemplate(item && item.data);
                trCustomEnsureReportTables(data);
                return {
                    id: Number(item && item.id) || 0,
                    position: Number(item && item.position) || 0,
                    updated: String((item && item.updated) || ''),
                    data,
                };
            })
            .filter((item) => item.id > 0)
            .sort((a, b) => (a.position - b.position) || (a.id - b.id));
        if (trCustomCurrentId && !trCustomTemplates.some((item) => item.id === trCustomCurrentId)) {
            trCustomCurrentId = null;
        }
        if (!trCustomTemplates.length && !trCustomDraft && !trCustomPendingDraft) {
            trCustomDraft = null;
        }
        trCustomMarkClean();
        trCustomEmitUpdate();
    }

    // 确保自定义表格列表已从 API 加载
    async function trCustomEnsureLoaded(force = false) {
        if (trCustomLoaded && !force) return trCustomTemplates;
        if (trCustomLoadingPromise && !force) return trCustomLoadingPromise;
        trCustomLoadingPromise = (async () => {
            const json = await fetchJsonSafe(`${TR_CUSTOM_API_BASE}/list`);
            if (json && json.ok) {
                trCustomApplyTemplateList(json.data);
                trCustomLoaded = true;
                return trCustomTemplates;
            }
            throw new Error((json && json.error) || 'load custom tables failed');
        })();
        try {
            return await trCustomLoadingPromise;
        } finally {
            trCustomLoadingPromise = null;
        }
    }

    // 预加载当前选中年份的账本数据
    async function trCustomEnsureSelectedYearsLoaded() {
        const allYears = trGetAllYears();
        const years = allYears.filter((year) => trSelectedYears.includes(year));
        await Promise.all(years.map((year) => trEnsureYear(year)));
        return years;
    }
    //#endregion

    //#region 自定义表 · 交叉录入
    // 解析表头月份标签为 0-11 索引
    function trCustomParseMonthHeader(label) {
        const raw = String(label || '').trim();
        if (!raw || raw === '总额') return -1;

        const yearSplit = raw.match(/^(\d{4})[-/](.+)$/);
        const text = yearSplit ? yearSplit[2].trim() : raw;

        const monIndex = MON.findIndex((mon) => mon.toLowerCase() === text.toLowerCase());
        if (monIndex >= 0) return monIndex;

        const zhMonth = text.match(/^(\d{1,2})月$/);
        if (zhMonth) {
            const monthNo = Number(zhMonth[1]);
            if (monthNo >= 1 && monthNo <= 12) return monthNo - 1;
        }

        if (/^\d{1,2}$/.test(text)) {
            const monthNo = Number(text);
            if (monthNo >= 1 && monthNo <= 12) return monthNo - 1;
        }

        return -1;
    }

    // 将周期标签规范化为比较用键
    function trCustomNormalizePeriodLabel(label) {
        const raw = String(label || '').trim();
        const yearMatch = raw.match(/^(\d{4})[-/]/);
        const year = yearMatch ? yearMatch[1] : '';
        const monthIndex = trCustomParseMonthHeader(raw);
        if (monthIndex >= 0) return year ? `${year}-${monthIndex}` : `m-${monthIndex}`;
        if (/^\d{4}$/.test(raw)) return `y-${raw}`;
        return raw.toLowerCase();
    }

    // 收集表头周期列与规范化键的映射
    function trCustomCollectPeriodColMap(grid, headerRow = 0) {
        const map = new Map();
        for (let c = 1; c < grid.cols; c += 1) {
            const label = String(grid.cells[headerRow]?.[c] || '').trim();
            if (!label || label === '总额') continue;
            const key = trCustomNormalizePeriodLabel(label);
            if (!map.has(key)) map.set(key, c);
        }
        return map;
    }

    // 强制写入数据格（跳过合计行）
    function trCustomForceSetCell(grid, row, col, value) {
        if (!grid?.cells || row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return;
        if (trCustomIsTotalRow(row, grid.rows)) return;
        grid.cells[row][col] = String(value);
    }

    // 扫描网格查找「总额」列（任意位置）
    function trCustomFindTotalCol(grid, headerRow = 0) {
        for (let c = 1; c < grid.cols; c += 1) {
            if (String(grid.cells[headerRow]?.[c] || '').trim() === '总额') return c;
        }
        return -1;
    }

    // 按标签查找分类行索引
    function trCustomFindCategoryRow(grid, label) {
        const want = String(label || '').trim();
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        for (let r = 1; r < totalRow; r += 1) {
            if (String(grid.cells[r]?.[0] || '').trim() === want) return r;
        }
        return -1;
    }

    // 查找或新增分类行
    function trCustomFindOrCreateCategoryRow(grid, label) {
        const existing = trCustomFindCategoryRow(grid, label);
        if (existing >= 0) return existing;
        const want = String(label || '').trim();
        const totalRow = trCustomGetTotalRowIndex(grid.rows);
        for (let r = 1; r < totalRow; r += 1) {
            if (!trCustomCellHasContent(grid.cells[r]?.[0])) {
                grid.cells[r][0] = want;
                return r;
            }
        }
        const nextRows = Math.min(TR_CUSTOM_MAX_ROWS, grid.rows + 1);
        const resized = trCustomResizeSection(grid, nextRows, grid.cols);
        grid.rows = resized.rows;
        grid.cols = resized.cols;
        grid.cells = resized.cells;
        const newTotalRow = trCustomGetTotalRowIndex(grid.rows);
        grid.cells[newTotalRow - 1][0] = want;
        return newTotalRow - 1;
    }

    // 从周期键与表头解析年份和月份
    function trCustomResolvePeriodData(periodKey, years, headerLabel = '') {
        const raw = String(headerLabel || '').trim();
        const monthIndex = trCustomParseMonthHeader(raw);
        if (monthIndex >= 0) {
            const yearMatch = raw.match(/^(\d{4})[-/]/);
            const year = yearMatch ? Number(yearMatch[1]) : (years.length === 1 ? Number(years[0]) : NaN);
            if (Number.isFinite(year)) return { year, monthIndex };
        }
        if (String(periodKey || '').startsWith('y-')) {
            const year = Number(String(periodKey).slice(2));
            if (Number.isFinite(year)) return { year, monthIndex: -1 };
        }
        const mixed = String(periodKey || '').match(/^(\d{4})-(\d{1,2})$/);
        if (mixed) {
            return { year: Number(mixed[1]), monthIndex: Number(mixed[2]) };
        }
        const plainMonth = String(periodKey || '').match(/^m-(\d{1,2})$/);
        if (plainMonth && years.length === 1) {
            return { year: Number(years[0]), monthIndex: Number(plainMonth[1]) };
        }
        return { year: NaN, monthIndex: -1 };
    }

    // 按中文标签查找分类定义
    function trCustomFindCatByLabel(label) {
        const text = String(label || '').trim();
        return TR_CATS.find((cat) => cat.label === text) || null;
    }

    // 收集网格表头引用的所有年份
    function trCustomCollectYearsReferencedByGrid(grid, sectionYear = NaN) {
        const years = new Set();
        if (Number.isFinite(sectionYear)) years.add(sectionYear);
        if (!grid?.cells) return [...years];

        const cornerYear = String(grid.cells[0]?.[0] || '').trim();
        if (/^\d{4}$/.test(cornerYear)) years.add(Number(cornerYear));

        if (trIsMobile()) {
            const totalRow = trCustomGetTotalRowIndex(grid.rows);
            const contextYears = Number.isFinite(sectionYear) ? [sectionYear] : [];
            for (let r = 1; r < totalRow; r += 1) {
                const label = String(grid.cells[r]?.[0] || '').trim();
                if (!label) continue;
                if (/^\d{4}$/.test(label)) {
                    years.add(Number(label));
                    continue;
                }
                const resolved = trCustomResolvePeriodData(trCustomNormalizePeriodLabel(label), contextYears, label);
                if (Number.isFinite(resolved.year)) years.add(resolved.year);
            }
            return [...years];
        }

        const contextYears = Number.isFinite(sectionYear) ? [sectionYear] : [];
        for (let c = 1; c < grid.cols; c += 1) {
            const label = String(grid.cells[0]?.[c] || '').trim();
            if (!label || label === '总额') continue;
            if (/^\d{4}$/.test(label)) {
                years.add(Number(label));
                continue;
            }
            const resolved = trCustomResolvePeriodData(trCustomNormalizePeriodLabel(label), contextYears, label);
            if (Number.isFinite(resolved.year)) years.add(resolved.year);
        }
        return [...years];
    }

    // 从账本缓存取分类与周期的交叉值
    function trCustomGetIntersectionValue(resolved, cat) {
        if (!cat || !resolved) return null;
        const { year, monthIndex } = resolved;
        if (!Number.isFinite(year)) return null;
        const data12 = trYearCache[year];
        if (!Array.isArray(data12) || !data12.length) return null;
        if (monthIndex < 0) {
            return data12.reduce((sum, md) => sum + trGetVal(md, cat.key), 0);
        }
        return trGetVal(data12[monthIndex] || {}, cat.key);
    }

    // 将账本数据填入网格分类×周期交叉格
    function trCustomFillGridIntersections(grid, options = {}) {
        if (!grid?.cells) return false;
        const sectionYear = options.sectionYear;
        const contextYears = Number.isFinite(sectionYear)
            ? [sectionYear]
            : trCustomCollectYearsReferencedByGrid(grid);
        const totalCol = trCustomGetTotalColIndex(grid);
        const totalRow = trCustomGetTotalRowIndex(grid.rows);

        if (trIsMobile()) {
            const catColMap = new Map();
            for (let c = 1; c < grid.cols; c += 1) {
                const label = String(grid.cells[0]?.[c] || '').trim();
                if (!label || label === '总额') continue;
                const cat = trCustomFindCatByLabel(label);
                if (cat) catColMap.set(c, cat);
            }

            for (let r = 1; r < totalRow; r += 1) {
                const periodLabel = String(grid.cells[r]?.[0] || '').trim();
                if (!periodLabel) continue;
                const resolved = trCustomResolvePeriodData(
                    trCustomNormalizePeriodLabel(periodLabel),
                    contextYears,
                    periodLabel
                );
                if (!Number.isFinite(resolved.year) && resolved.monthIndex < 0) continue;

                let rowTotal = 0;
                catColMap.forEach((cat, col) => {
                    const value = trCustomGetIntersectionValue(resolved, cat);
                    if (value === null) return;
                    rowTotal += value;
                    trCustomForceSetCell(grid, r, col, trFmt(value));
                });
                if (totalCol > 0 && catColMap.size > 0) {
                    trCustomForceSetCell(grid, r, totalCol, trFmt(formatCategoryDisplay(rowTotal)));
                }
            }
            return true;
        }

        const periodCols = [];
        for (let c = 1; c < grid.cols; c += 1) {
            if (c === totalCol) continue;
            const label = String(grid.cells[0]?.[c] || '').trim();
            if (!label) continue;
            const resolved = trCustomResolvePeriodData(
                trCustomNormalizePeriodLabel(label),
                contextYears,
                label
            );
            if (!Number.isFinite(resolved.year) && resolved.monthIndex < 0) continue;
            periodCols.push({ col: c, resolved });
        }

        for (let r = 1; r < totalRow; r += 1) {
            const label = String(grid.cells[r]?.[0] || '').trim();
            if (!label) continue;
            const cat = trCustomFindCatByLabel(label);
            if (!cat) continue;

            let rowTotal = 0;
            periodCols.forEach(({ col, resolved }) => {
                const value = trCustomGetIntersectionValue(resolved, cat);
                if (value === null) return;
                rowTotal += value;
                trCustomForceSetCell(grid, r, col, trFmt(value));
            });
            if (totalCol > 0 && periodCols.length > 0) {
                trCustomForceSetCell(grid, r, totalCol, trFmt(formatCategoryDisplay(rowTotal)));
            }
        }
        if (totalCol > 0) trCustomApplyComputedSums(grid);
        return true;
    }

    // 填充当前草稿活动表格的交叉数据格
    async function trCustomFillDraftIntersections() {
        if (!trCustomDraft) return false;
        trCustomEnsureReportTables(trCustomDraft);
        const idx = trCustomGetActiveTableIndex(trCustomDraft);
        const section = trCustomNormalizeSection(trCustomDraft.sections[idx], trCustomDraft.rows, trCustomDraft.cols);
        const cornerYear = Number(String(section.cells[0]?.[0] || '').trim());
        const sectionYear = Number.isFinite(cornerYear) && /^\d{4}$/.test(String(section.cells[0]?.[0] || '').trim())
            ? cornerYear
            : NaN;
        const yearsToLoad = trCustomCollectYearsReferencedByGrid(section, sectionYear);
        await Promise.all(yearsToLoad.map((year) => trEnsureYear(year)));
        trCustomFillGridIntersections(section, { sectionYear });
        trCustomDraft.sections[idx] = section;
        trCustomSyncPrimaryFromSection(idx);
        return true;
    }

    //#endregion

    //#region 总结报表 · 取数与计算
    // 从 monthData 单月取对应分类值
    function trGetVal(md, key) {
        if (!md) return 0;
        const sb = md.salesBreakdown || {};
        if (key === 'cash') return Number(sb.cash) || 0;
        if (key === 'check') return Number(sb.Check) || 0;
        if (key === 'delivery') return (Number(sb.uber) || 0) + (Number(sb.riceball) || 0) + (Number(sb.panda) || 0) + (Number(sb.bm) || 0);
        if (key === 'others') return Number(md.othersTotal) || 0;
        if (key === 'expense') return Number(md.expense) || 0;
        if (key === 'costTotal') return Number(md.costTotal) || 0;
        return 0;
    }

    // 按固定分组顺序返回当前选中的分类列表
    function getTrDisplayCats() {
        const orderedKeys = [
            ...trSelectedCats.filter((key) => TR_FRONT_KEYS.includes(key)),
            ...trSelectedCats.filter((key) => TR_MIDDLE_KEYS.includes(key)),
            ...(trSelectedCats.includes('others') ? ['others'] : []),
        ];
        return orderedKeys
            .map(key => TR_CATS.find(c => c.key === key))
            .filter(Boolean);
    }

    // 格式化报表数值（零显示为空）
    function trFmt(v) {
        const n = Number(v);
        return n === 0 ? '' : formatDisplayNumber(n);
    }

    // 按分类键与数值返回正负样式类名
    function trValueClassByKey(key, value) {
        const n = Number(value) || 0;
        const isFirstFour = key === 'cash' || key === 'check' || key === 'delivery' || key === 'others';
        if (isFirstFour) return n < 0 ? 'tr-v-in-neg' : 'tr-v-in-pos';
        return n < 0 ? 'tr-v-out-neg' : 'tr-v-out-pos';
    }

    // 按选中分类汇总单月净额
    function trSelectedPeriodTotal(md, cats) {
        const list = Array.isArray(cats) ? cats : [];
        return list.reduce((sum, cat) => {
            const key = cat && cat.key ? cat.key : '';
            const val = trGetVal(md, key);
            if (key === 'expense' || key === 'costTotal') return sum - val;
            if (key === 'others') return sum;
            return sum + val;
        }, 0);
    }

    //#endregion

    //#region 总结报表 · 拼表格块
    // 加载一年数据（有缓存直接返回）
    async function trEnsureYear(year) {
        if (trYearCache[year]) return;
        if (year === currentYear) { trYearCache[year] = monthData; return; }
        try {
            const json = await fetchJsonSafe(`${LEDGER_API_BASE}/ledger/load?year=${encodeURIComponent(year)}`);
            if (json && json.ok && Array.isArray(json.data) && json.data.length === 12) {
                trYearCache[year] = json.data;
            }
        } catch (_) { }
    }

    // 构建 colgroup：列1=行标题, 列2=总额, 其余为数据列
    function trColgroup(colCount, firstWidth) {
        const firstColWidth = Number(firstWidth) || 84;
        let cg = `<colgroup><col style="width:${firstColWidth}px">`;
        cg += '<col style="width:76px">';
        for (let i = 2; i < colCount; i++) cg += '<col style="width:76px">';
        cg += '</colgroup>';
        return cg;
    }

    // 构建一行数据 td（行标题 + 各值 + 总额）
    function trDataRow(label, total, vals, rowKey = 'cash') {
        const sumCls = trValueClassByKey(rowKey, total);
        let row = `<tr class="tr-row-${rowKey}"><td>${label}</td>`;
        for (const v of vals) row += `<td>${trFmt(v)}</td>`;
        row += `<td class="tr-sum ${sumCls}">${trFmt(total)}</td>`;
        row += '</tr>';
        return row;
    }

    // 构建带分类样式的一行数据 td
    function trDataRowWithKeys(label, total, vals, keys, labelCls) {
        const sumKey = Array.isArray(keys) && keys.length ? keys[0] : '';
        const sumCls = trValueClassByKey(sumKey, total);
        const rowKey = sumKey || 'cash';
        const labelClassName = labelCls ? labelCls : `tr-cat-hd tr-row-${rowKey}`;
        const labelAttr = labelClassName ? ` class="${labelClassName}"` : '';
        let row = `<tr class="tr-row-${rowKey}"><td${labelAttr}>${label}</td>`;
        for (let i = 0; i < vals.length; i++) {
            const v = vals[i];
            const key = keys && keys[i] ? keys[i] : '';
            const cls = trValueClassByKey(key, v);
            row += `<td class="${cls}">${trFmt(v)}</td>`;
        }
        row += `<td class="tr-sum ${sumCls}">${trFmt(total)}</td>`;
        row += '</tr>';
        return row;
    }

    // 返回总额列正负样式类名
    function trSignedTotalClass(value) {
        return (Number(value) || 0) < 0 ? 'tr-v-in-neg' : 'tr-v-in-pos';
    }

    // 计算移动端转置表的列宽百分比布局
    function trMobileTransposedColLayout(catCount) {
        const firstColWidthPercent = (34 / 436) * 100;
        const dataColCount = Math.max(1, catCount + 1);
        const dataColWidthPercent = (100 - firstColWidthPercent) / dataColCount;
        return { firstColWidthPercent, dataColCount, dataColWidthPercent };
    }

    // 构建移动端「仅显示年」转置表 HTML
    function trBuildMobileYearTable(yearsData, cats) {
        const { firstColWidthPercent, dataColCount, dataColWidthPercent } = trMobileTransposedColLayout(cats.length);
        let html = '<div class="tr-table-wrap"><table class="tr-table tr-mobile-transposed" style="width:100%">';
        html += `<colgroup><col style="width:${firstColWidthPercent}%">`;
        for (let i = 0; i < dataColCount; i++) html += `<col style="width:${dataColWidthPercent}%">`;
        html += '</colgroup><thead><tr>';
        html += '<th><button class="tr-settings-trigger icon-only" id="trSettingsBtn" aria-label="显示设置" title="显示设置">⚙</button></th>';
        for (const cat of cats) {
            html += `<th class="tr-cat-hd tr-row-${cat.key}">${cat.label}</th>`;
        }
        html += '<th class="tr-total-col">总额</th>';
        html += '</tr></thead><tbody>';
        for (const yd of yearsData) {
            const vals = cats.map((cat) => yd.data12.reduce((sum, md) => sum + trGetVal(md, cat.key), 0));
            const total = yd.data12.reduce((sum, md) => sum + trSelectedPeriodTotal(md, cats), 0);
            const tone = trGetYearTone(yd.year);
            html += `<tr><td class="tr-year-col ${tone}">${yd.year}</td>`;
            for (let i = 0; i < vals.length; i++) {
                const value = vals[i];
                const key = cats[i] && cats[i].key ? cats[i].key : '';
                html += `<td class="tr-cell-${key} ${trValueClassByKey(key, value)}">${trFmt(value)}</td>`;
            }
            html += `<td class="tr-sum ${trSignedTotalClass(total)}">${trFmt(total)}</td></tr>`;
        }
        const catTotals = cats.map((cat) => yearsData.reduce((sum, yd) => sum + yd.data12.reduce((acc, md) => acc + trGetVal(md, cat.key), 0), 0));
        html += `</tbody>${trShowTotal ? `<tfoot>${trTotalRow(catTotals, cats.map((cat) => cat.key))}</tfoot>` : ''}</table></div>`;
        return html;
    }

    // 构建移动端单年详细转置表 HTML
    function trBuildMobileAllTable(yd, isFirst, cats) {
        const { firstColWidthPercent, dataColCount, dataColWidthPercent } = trMobileTransposedColLayout(cats.length);
        let html = `<div class="tr-year-block"><div class="tr-year-label">${yd.year}</div>`;
        html += '<div class="tr-table-wrap"><table class="tr-table tr-mobile-transposed" style="width:100%">';
        html += `<colgroup><col style="width:${firstColWidthPercent}%">`;
        for (let i = 0; i < dataColCount; i++) html += `<col style="width:${dataColWidthPercent}%">`;
        html += '</colgroup><thead><tr>';
        if (isFirst) {
            html += '<th><button class="tr-settings-trigger icon-only" id="trSettingsBtn" aria-label="显示设置" title="显示设置">⚙</button></th>';
        } else {
            html += '<th></th>';
        }
        for (const cat of cats) {
            html += `<th class="tr-cat-hd tr-row-${cat.key}">${cat.label}</th>`;
        }
        html += '<th class="tr-total-col">总额</th>';
        html += '</tr></thead><tbody>';
        for (let i = 0; i < 12; i++) {
            const vals = cats.map((cat) => trGetVal(yd.data12[i], cat.key));
            const total = trSelectedPeriodTotal(yd.data12[i], cats);
            html += `<tr><td class="tr-month-hd m-${i + 1}">${MON[i]}</td>`;
            for (let j = 0; j < vals.length; j++) {
                const value = vals[j];
                const key = cats[j] && cats[j].key ? cats[j].key : '';
                html += `<td class="${trValueClassByKey(key, value)}">${trFmt(value)}</td>`;
            }
            html += `<td class="tr-sum ${trSignedTotalClass(total)}">${trFmt(total)}</td></tr>`;
        }
        const catTotals = cats.map((cat) => yd.data12.reduce((sum, md) => sum + trGetVal(md, cat.key), 0));
        html += `</tbody>${trShowTotal ? `<tfoot>${trTotalRow(catTotals, cats.map((cat) => cat.key))}</tfoot>` : ''}</table></div></div>`;
        return html;
    }

    // 构建表脚总计合计行 HTML
    function trTotalRow(periodTotals, keys) {
        const totals = Array.isArray(periodTotals) ? periodTotals.map((v) => Number(v) || 0) : [];
        const classKeys = Array.isArray(keys) ? keys : [];
        const grandTotal = classKeys.length === totals.length && classKeys.length > 0
            ? totals.reduce((sum, total, i) => {
                const key = classKeys[i];
                const val = Number(total) || 0;
                if (key === 'expense' || key === 'costTotal') return sum - val;
                if (key === 'others') return sum;
                return sum + val;
            }, 0)
            : totals.reduce((a, b) => a + b, 0);
        let row = `<tr class="tr-total-row"><td>总计</td>`;
        for (let i = 0; i < totals.length; i++) {
            const total = totals[i];
            const vc = total < 0 ? 'tr-v-in-neg' : 'tr-v-in-pos';
            const keyCls = classKeys[i] ? ` tr-cell-${classKeys[i]}` : '';
            row += `<td class="tr-sum ${vc}${keyCls}">${trFmt(total)}</td>`;
        }
        const gvc = grandTotal < 0 ? 'tr-v-in-neg' : 'tr-v-in-pos';
        row += `<td class="tr-sum tr-cell-grand-total ${gvc}">${trFmt(grandTotal)}</td>`;
        row += '</tr>';
        return row;
    }

    //#endregion

    //#region 自定义表 · 模板管理
    // 按模板 ID 查找在列表中的索引
    function trCustomGetTemplateIndex(templateId) {
        return trCustomTemplates.findIndex((item) => item.id === Number(templateId));
    }

    // 获取模板按钮显示编号
    function trCustomGetTemplateButtonLabel(templateId) {
        const index = trCustomGetTemplateIndex(templateId);
        return index > -1 ? String(index + 1) : '新';
    }

    // 关闭自定义表格管理面板并重置目标
    function trCustomCloseManagePanel() {
        trCustomManageOpen = false;
        trCustomManageTargetKind = 'table';
        trCustomManageTargetId = null;
        trCustomManageTargetPending = false;
    }

    // 判断当前是否可显示管理控件
    function trCustomCanShowManage() {
        if (trCustomSelectorKind === 'module') {
            return Boolean(trModuleCurrentId) || trModulePendingDraft;
        }
        if (trCustomSelectorKind === 'table') {
            return Boolean(trCustomCurrentId) || trCustomPendingDraft;
        }
        return false;
    }

    // 构建管理面板或扳手按钮 HTML
    function trCustomBuildManageControlsHtml() {
        if (!trCustomCanShowManage()) return '';
        if (trCustomManageOpen) {
            return `
                        <div class="tr-custom-manage-panel">
                            <button type="button" class="tr-custom-action-btn" id="trCustomManageEditBtn">修改</button>
                            <button type="button" class="tr-custom-action-btn" id="trCustomManageClearBtn">清空</button>
                            <button type="button" class="tr-custom-action-btn" id="trCustomManageRemoveBtn">移除</button>
                        </div>
                    `;
        }
        return `
                    <button type="button" class="tr-custom-wrench-btn" id="trCustomWrenchBtn" aria-label="管理">
                        <svg class="tr-custom-more-icon" viewBox="0 0 4 14" aria-hidden="true">
                            <circle cx="2" cy="2" r="1.45" fill="currentColor"></circle>
                            <circle cx="2" cy="7" r="1.45" fill="currentColor"></circle>
                            <circle cx="2" cy="12" r="1.45" fill="currentColor"></circle>
                        </svg>
                    </button>
                `;
    }

    // 绑定管理面板按钮事件
    function trCustomBindManageHandlers(scope) {
        const root = scope || document;
        const wrenchBtn = root.querySelector('#trCustomWrenchBtn');
        const manageEditBtn = root.querySelector('#trCustomManageEditBtn');
        const manageClearBtn = root.querySelector('#trCustomManageClearBtn');
        const manageRemoveBtn = root.querySelector('#trCustomManageRemoveBtn');
        if (wrenchBtn) {
            wrenchBtn.addEventListener('click', () => {
                trCustomOpenManagePanel();
                trQueueRenderDOM();
            });
        }
        if (manageEditBtn) {
            manageEditBtn.addEventListener('click', async () => {
                const ok = await trCustomManageEdit();
                if (ok) trQueueRenderDOM();
            });
        }
        if (manageClearBtn) {
            manageClearBtn.addEventListener('click', async () => {
                const ok = await trCustomManageClear();
                if (ok) trQueueRenderDOM();
            });
        }
        if (manageRemoveBtn) {
            manageRemoveBtn.addEventListener('click', async () => {
                const ok = await trCustomManageRemove();
                if (ok) trQueueRenderDOM();
            });
        }
    }

    // 打开管理面板并记录当前操作目标
    function trCustomOpenManagePanel() {
        if (trCustomSelectorKind === 'module') {
            trCustomManageTargetKind = 'module';
            trCustomManageTargetId = trModuleCurrentId;
            trCustomManageTargetPending = Boolean(trModulePendingDraft && !trModuleCurrentId);
        } else {
            trCustomManageTargetKind = 'table';
            trCustomManageTargetId = trCustomCurrentId;
            trCustomManageTargetPending = Boolean(trCustomPendingDraft && !trCustomCurrentId);
        }
        trCustomManageOpen = true;
    }

    // 获取管理操作目标的显示名称
    function trCustomGetManageTargetLabel() {
        if (trCustomManageTargetKind === 'module') {
            if (trCustomManageTargetPending) return '新模块';
            if (trCustomManageTargetId) {
                const match = trModuleTemplates.find((item) => item.id === trCustomManageTargetId);
                const title = match && match.data ? String(match.data.title || '').trim() : '';
                return title || `模块 ${trModuleTemplates.findIndex((item) => item.id === trCustomManageTargetId) + 1}`;
            }
            return '模块';
        }
        if (trCustomManageTargetPending) return '新表格';
        if (trCustomManageTargetId) return `表格 ${trCustomGetTemplateButtonLabel(trCustomManageTargetId)}`;
        return '表格';
    }

    // 切换并激活管理面板选中的目标
    async function trCustomEnsureManageTargetActive() {
        if (trCustomManageTargetKind === 'module') {
            if (trCustomManageTargetPending) {
                return Boolean(trModulePendingDraft && trModuleCurrentId === null);
            }
            if (!trCustomManageTargetId) return false;
            if (trCustomManageTargetId === trModuleCurrentId) {
                trCustomSelectorKind = 'module';
                trCustomContentKind = 'module';
                return true;
            }
            if (trCustomContentKind === 'module' && trModuleIsDirty()) {
                if (!(await trCustomConfirm('当前模块有未保存的修改，切换模块将丢失，是否继续？'))) return false;
            }
            trCustomSelectorKind = 'module';
            trCustomContentKind = 'module';
            trModuleSelectTemplate(trCustomManageTargetId);
            return true;
        }
        if (trCustomManageTargetPending) {
            return Boolean(trCustomPendingDraft && trCustomCurrentId === null);
        }
        if (!trCustomManageTargetId) return false;
        if (trCustomManageTargetId === trCustomCurrentId) return true;
        return trCustomRunIfAllowed('当前表格有未保存的修改，切换表格将丢失，是否继续？', () => {
            trCustomSelectTemplate(trCustomManageTargetId);
        });
    }

    // 判断单元格是否有非空内容
    function trCustomCellHasContent(value) {
        return String(value || '').replace(/\u00a0/g, '').trim() !== '';
    }

    // 判断模板除表头外是否已有数据
    function trCustomHasDataBeyondOrigin(template) {
        const safe = trCustomNormalizeTemplate(template);
        const grids = trCustomIsMultiLayout(safe)
            ? safe.sections
            : [{ rows: safe.rows, cols: safe.cols, cells: safe.cells }];
        for (const grid of grids) {
            for (let r = 1; r < grid.rows; r += 1) {
                if (trCustomIsTotalRow(r, grid.rows)) continue;
                for (let c = 1; c < grid.cols; c += 1) {
                    if (trCustomCellHasContent(grid.cells[r][c])) return true;
                }
            }
        }
        return false;
    }

    // 根据数据情况返回清空方案（仅数据或整表）
    function trCustomGetClearPlan(template) {
        const safe = trCustomNormalizeTemplate(template);
        if (trCustomHasDataBeyondOrigin(safe)) {
            return { message: '是否清空数据？', mode: 'data' };
        }
        return { message: '是否清空表格？', mode: 'table' };
    }

    // 获取管理操作目标对应的模板数据
    function trCustomGetManageTargetTemplate() {
        if (trCustomManageTargetKind === 'module') {
            if (trCustomManageTargetPending) return trModuleDraft;
            if (trCustomManageTargetId) {
                const match = trModuleTemplates.find((item) => item.id === trCustomManageTargetId);
                if (match) return match.data;
            }
            return trModuleDraft;
        }
        if (trCustomManageTargetPending) return trCustomDraft;
        if (trCustomManageTargetId) {
            const match = trCustomTemplates.find((item) => item.id === trCustomManageTargetId);
            if (match) return match.data;
        }
        return trCustomDraft;
    }

    // 清空草稿数据格但保留表头结构
    function trCustomClearDraftCells(template = trCustomDraft) {
        const safe = trCustomCloneTemplate(template);
        const clearGrid = (grid) => {
            for (let r = 0; r < grid.rows; r += 1) {
                for (let c = 0; c < grid.cols; c += 1) {
                    if (trCustomIsTotalRow(r, grid.rows)) {
                        if (c > 0) grid.cells[r][c] = '';
                        continue;
                    }
                    if (r === 0 || c === 0) continue;
                    grid.cells[r][c] = '';
                }
            }
            trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        };
        if (trCustomIsMultiLayout(safe) && safe.sections.length) {
            safe.sections = safe.sections.map((section) => {
                const next = trCustomNormalizeSection(section, safe.rows, safe.cols);
                clearGrid(next);
                return next;
            });
            safe.cells = safe.sections[0].cells.map((row) => row.slice());
        } else {
            clearGrid(safe);
        }
        return safe;
    }

    // 重置草稿为空白表格结构
    function trCustomResetWholeTable(template = trCustomDraft) {
        const safe = trCustomCloneTemplate(template);
        const resetGrid = (grid) => {
            for (let r = 0; r < grid.rows; r += 1) {
                for (let c = 0; c < grid.cols; c += 1) {
                    grid.cells[r][c] = (trCustomIsTotalRow(r, grid.rows) && c === 0) ? 'Total' : '';
                }
            }
            trCustomApplyTotalRowCells(grid.cells, grid.rows, grid.cols);
        };
        if (trCustomIsMultiLayout(safe) && safe.sections.length) {
            safe.sections = safe.sections.map((section) => {
                const next = trCustomNormalizeSection(section, safe.rows, safe.cols);
                resetGrid(next);
                return next;
            });
            safe.cells = safe.sections[0].cells.map((row) => row.slice());
        } else {
            resetGrid(safe);
        }
        return safe;
    }

    // 选中并加载已保存的自定义表格模板
    function trCustomSelectTemplate(templateId) {
        const match = trCustomTemplates.find((item) => item.id === Number(templateId));
        if (!match) return;
        trCustomCloseManagePanel();
        trCustomCurrentId = match.id;
        trCustomDraft = trCustomCloneTemplate(match.data);
        trCustomEnsureReportTables(trCustomDraft);
        trCustomActiveTableIndex = 0;
        trCustomSyncPrimaryFromSection(0);
        trCustomPendingDraft = false;
        trCustomBeforeCreateId = null;
        trCustomToolbarExpanded = false;
        trCustomMarkClean();
        trCustomEmitUpdate();
    }

    // 判断自定义表格工作区是否可编辑
    function trCustomIsWorkspaceEditable() {
        return !!trCustomToolbarExpanded;
    }

    // 创建新的空白自定义表格草稿
    function trCustomCreateNewTemplate() {
        trCustomCurrentId = null;
        trCustomDraft = trCreateDefaultCustomTemplate();
        trCustomEnsureReportTables(trCustomDraft);
        trCustomActiveTableIndex = 0;
        trCustomSyncPrimaryFromSection(0);
        trCustomMarkClean();
        trCustomEmitUpdate();
    }

    // 进入创建报表模式时重置选择器状态
    function trCustomResetSelectorOnModeEnter() {
        trCustomSelectorKind = null;
        trCustomContentKind = null;
    }

    // 开始新建自定义表格会话
    function trCustomBeginCreateSession() {
        trCustomCloseManagePanel();
        trCustomCloseLayoutCustomInput();
        trCustomSelectorKind = 'table';
        trCustomContentKind = 'table';
        trCustomBeforeCreateId = trCustomCurrentId;
        trCustomToolbarExpanded = true;
        trCustomNewTableRows = TR_CUSTOM_DEFAULT_ROWS;
        trCustomNewTableCols = TR_CUSTOM_DEFAULT_COLS;
        trCustomCreateNewTemplate();
        trCustomPendingDraft = true;
        trCustomYears = [];
        trCustomCats = [];
        trCustomShowTotal = false;
        if (trMode === 'custom') {
            trSelectedYears = [];
            trSelectedCats = [];
            trShowTotal = false;
        }
        trCustomSetGuide('create');
        trCustomEmitUpdate();
    }

    // 取消新建会话并恢复先前选中模板
    function trCustomCancelCreateSession() {
        trCustomCloseManagePanel();
        trCustomCloseLayoutCustomInput();
        trCustomPendingDraft = false;
        trCustomToolbarExpanded = false;
        trCustomClearStatus();
        if (trCustomBeforeCreateId && trCustomTemplates.some((item) => item.id === trCustomBeforeCreateId)) {
            trCustomSelectTemplate(trCustomBeforeCreateId);
            trCustomContentKind = 'table';
        } else {
            trCustomCurrentId = null;
            trCustomDraft = null;
            trCustomContentKind = null;
            trCustomMarkClean();
        }
        trCustomBeforeCreateId = null;
        trCustomEmitUpdate();
    }

    // 删除已保存的自定义表格模板
    async function trCustomDeleteTemplate(templateId) {
        const json = await fetchJsonSafe(`${TR_CUSTOM_API_BASE}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: templateId }),
        });
        if (!json || !json.ok) {
            throw new Error((json && json.error) || 'delete custom table failed');
        }
        trCustomTemplates = trCustomTemplates.filter((item) => item.id !== templateId);
        trCustomCloseManagePanel();
        trCustomCloseLayoutCustomInput();
        trCustomToolbarExpanded = false;
        trCustomClearStatus();
        if (trCustomCurrentId === templateId) {
            if (trCustomBeforeCreateId && trCustomTemplates.some((item) => item.id === trCustomBeforeCreateId)) {
                trCustomSelectTemplate(trCustomBeforeCreateId);
                trCustomContentKind = 'table';
            } else {
                trCustomCurrentId = null;
                trCustomPendingDraft = false;
                trCustomBeforeCreateId = null;
                trCustomDraft = null;
                trCustomContentKind = null;
                trCustomMarkClean();
                trCustomEmitUpdate();
            }
        } else {
            trCustomEmitUpdate();
        }
        trCustomLoaded = true;
        return json;
    }

    // 管理面板：进入编辑模式
    async function trCustomManageEdit() {
        const targetKind = trCustomManageTargetKind;
        const targetPending = trCustomManageTargetPending;
        const targetId = trCustomManageTargetId;
        trCustomCloseManagePanel();
        if (targetKind === 'module') {
            if (targetPending) {
                trCustomSelectorKind = 'module';
                trCustomContentKind = 'module';
                trModuleToolbarExpanded = true;
                trModuleWorkspaceEditMode = true;
                return true;
            }
            if (!targetId) return false;
            const active = await trCustomEnsureManageTargetActive();
            if (!active) return false;
            trCustomSelectorKind = 'module';
            trCustomContentKind = 'module';
            trModulePendingDraft = false;
            trModuleBeforeCreateId = null;
            trModuleActiveVariableKey = null;
            if (trModuleDraft) {
                trModuleNewTitle = String(trModuleDraft.title || '').trim();
                trModuleNewRows = trModuleDraft.rows;
                trModuleNewCols = trModuleDraft.cols;
                const draftFlags = trModuleResolveTotalFlags(trModuleDraft);
                trModuleNewShowTotalCol = draftFlags.showTotalCol;
                trModuleNewShowTotalRow = draftFlags.showTotalRow;
            }
            trModuleToolbarExpanded = true;
            trModuleWorkspaceEditMode = true;
            return true;
        }
        if (targetPending) {
            trCustomToolbarExpanded = true;
            trCustomSetGuide('edit');
            return true;
        }
        if (!targetId) return false;
        if (targetId !== trCustomCurrentId) {
            const ok = await trCustomRunIfAllowed('当前表格有未保存的修改，切换表格将丢失，是否继续？', () => {
                trCustomSelectTemplate(targetId);
            });
            if (!ok) return false;
        }
        trCustomPendingDraft = false;
        trCustomBeforeCreateId = null;
        const match = trCustomTemplates.find((item) => item.id === targetId);
        if (match) {
            trCustomCurrentId = match.id;
            trCustomDraft = trCustomCloneTemplate(match.data);
            trCustomEnsureReportTables(trCustomDraft);
            trCustomActiveTableIndex = 0;
            trCustomSyncPrimaryFromSection(0);
            trCustomMarkClean();
        }
        trCustomToolbarExpanded = true;
        trCustomSetGuide('edit');
        return true;
    }

    // 管理面板：清空数据或整表
    async function trCustomManageClear() {
        if (trCustomManageTargetKind === 'module') {
            const clearPlan = trModuleGetClearPlan(trCustomGetManageTargetTemplate());
            const ok = await trModuleRunIfAllowed(clearPlan.message, async () => {
                const active = await trCustomEnsureManageTargetActive();
                if (!active) return;
                trCustomSelectorKind = 'module';
                trCustomContentKind = 'module';
                if (!trModuleDraft) return;
                trModuleActiveVariableKey = null;
                trModuleDraft = clearPlan.mode === 'data'
                    ? trModuleClearDraftCells(trModuleDraft)
                    : trModuleResetWholeModule(trModuleDraft);
                trModulePreviewReady = true;
                trModuleToolbarExpanded = false;
                trModuleWorkspaceEditMode = false;
                trModuleEmitUpdate();
            }, { alwaysConfirm: true });
            trCustomCloseManagePanel();
            return ok;
        }
        const clearPlan = trCustomGetClearPlan(trCustomGetManageTargetTemplate());
        const ok = await trCustomRunIfAllowed(clearPlan.message, async () => {
            const active = await trCustomEnsureManageTargetActive();
            if (!active) return;
            trCustomDraft = clearPlan.mode === 'data'
                ? trCustomClearDraftCells(trCustomDraft)
                : trCustomResetWholeTable(trCustomDraft);
            trCustomArmStatusFlash(clearPlan.mode === 'data' ? 'clearData' : 'clearReset');
        }, { alwaysConfirm: true });
        trCustomCloseManagePanel();
        return ok;
    }

    // 管理面板：删除表格或模块
    async function trCustomManageRemove() {
        if (trCustomManageTargetKind === 'module') {
            if (!(await trCustomConfirm('是否删除模块？'))) {
                trCustomCloseManagePanel();
                return false;
            }
            if (trCustomManageTargetPending) {
                trModuleCancelCreateSession();
                trCustomCloseManagePanel();
                return true;
            }
            if (!trCustomManageTargetId) {
                trCustomCloseManagePanel();
                return false;
            }
            try {
                await trModuleDeleteTemplate(trCustomManageTargetId);
                trCustomClearStatus();
                return true;
            } catch (error) {
                trCustomSetError(error && error.message ? error.message : '删除失败');
                trCustomCloseManagePanel();
                return false;
            }
        }
        if (!(await trCustomConfirm('是否删除表格？'))) {
            trCustomCloseManagePanel();
            return false;
        }
        if (trCustomManageTargetPending) {
            trCustomCancelCreateSession();
            trCustomCloseManagePanel();
            return true;
        }
        if (!trCustomManageTargetId) {
            trCustomCloseManagePanel();
            return false;
        }
        try {
            await trCustomDeleteTemplate(trCustomManageTargetId);
            trCustomClearStatus();
            return true;
        } catch (error) {
            trCustomSetError(error && error.message ? error.message : '删除失败');
            trCustomCloseManagePanel();
            return false;
        }
    }

    // 构建已保存表格模板切换按钮 HTML
    function trCustomBuildTemplateButtonsHtml() {
        const parts = trCustomTemplates.map((item, index) => {
            const slot = Math.min(3, index + 1);
            const active = trCustomContentKind === 'table' && item.id === trCustomCurrentId ? ' active' : '';
            return `<button type="button" class="tr-custom-template-btn tr-custom-template-slot-${slot}${active}" data-template-id="${item.id}">${index + 1}</button>`;
        });
        if (trCustomContentKind === 'table' && trCustomPendingDraft && trCustomCurrentId === null) {
            parts.push('<button type="button" class="tr-custom-template-btn pending active" data-template-id="pending" aria-label="未保存报表"></button>');
        }
        return parts.join('');
    }

    // 构建多表工作区子表切换按钮 HTML
    function trCustomBuildSheetButtonsHtml() {
        if (!trCustomDraft) return '';
        trCustomEnsureReportTables(trCustomDraft);
        const parts = trCustomDraft.sections.map((_, index) => (
            `<button type="button" class="tr-custom-sheet-btn${index === trCustomActiveTableIndex ? ' active' : ''}" data-sheet-index="${index}">${index + 1}</button>`
        ));
        parts.push('<button type="button" class="tr-custom-sheet-remove-btn" id="trCustomRemoveTableBtn" aria-label="移除表格">−</button>');
        return parts.join('');
    }

    // 保存当前自定义表格草稿到服务端
    async function trCustomSaveCurrent() {
        const payload = trCustomCloneTemplate(trCustomDraft);
        const json = await fetchJsonSafe(`${TR_CUSTOM_API_BASE}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trCustomCurrentId, data: payload }),
        });
        if (!json || !json.ok) {
            throw new Error((json && json.error) || 'save custom table failed');
        }
        const savedId = Number(json.id) || 0;
        const savedTemplate = {
            id: savedId,
            position: Number(json.position) || (trCustomTemplates.length + 1),
            updated: String(json.updated || ''),
            data: trCustomCloneTemplate(json.data),
        };
        const existingIndex = trCustomTemplates.findIndex((item) => item.id === savedId);
        if (existingIndex > -1) {
            trCustomTemplates.splice(existingIndex, 1, savedTemplate);
        } else {
            trCustomTemplates.push(savedTemplate);
        }
        trCustomTemplates.sort((a, b) => (a.position - b.position) || (a.id - b.id));
        trCustomCurrentId = savedId;
        trCustomDraft = trCustomCloneTemplate(savedTemplate.data);
        trCustomEnsureReportTables(trCustomDraft);
        trCustomClampActiveTableIndex(trCustomDraft);
        trCustomSyncPrimaryFromSection(trCustomActiveTableIndex);
        trCustomPendingDraft = false;
        trCustomBeforeCreateId = null;
        trCustomToolbarExpanded = false;
        trCustomSelectorKind = 'table';
        trCustomContentKind = 'table';
        trCustomCloseLayoutCustomInput();
        trCustomCloseManagePanel();
        trCustomMarkClean();
        trCustomClearStatus();
        trCustomLoaded = true;
        trCustomEmitUpdate();
        if (typeof window.yybbqEnsurePrintEnabledItem === 'function') {
            window.yybbqEnsurePrintEnabledItem('table', savedId);
        }
        return savedTemplate;
    }

    //#endregion

    //#region 自定义表 · 画出界面
    // 返回桌面端列数对应的表格容器类名
    function trCustomGetDesktopColsClass(cols) {
        if (trIsMobile()) return '';
        const safeCols = Math.max(1, Number(cols) || 1);
        return safeCols <= TR_CUSTOM_DESKTOP_FIT_COLS ? 'tr-custom-cols-fit' : 'tr-custom-cols-scroll';
    }

    // 返回桌面端宽表的内联样式属性
    function trCustomGetDesktopColsStyle(cols) {
        if (trIsMobile()) return '';
        const safeCols = Math.max(1, Number(cols) || 1);
        if (safeCols <= TR_CUSTOM_DESKTOP_FIT_COLS) return '';
        return ` style="--tr-custom-cols:${safeCols}"`;
    }

    const TR_CUSTOM_ROW_HD_CYCLE_KEYS = ['cash', 'check', 'delivery', 'others', 'expense', 'costTotal'];

    // 返回左上角表头单元格样式类名
    function trCustomGetCornerHeaderClass(label) {
        const raw = String(label || '').trim();
        if (/^\d{4}$/.test(raw)) return `tr-year-col ${trGetYearTone(Number(raw))}`;
        return 'tr-custom-corner-hd';
    }

    // 返回列表头单元格样式类名
    function trCustomGetColHeaderClass(label, colIndex) {
        const raw = String(label || '').trim();
        if (raw === '总额' || raw === 'Total') return 'tr-custom-total-hd';
        if (/^\d{4}$/.test(raw)) return `tr-year-col ${trGetYearTone(Number(raw))}`;
        const monthIndex = trCustomParseMonthHeader(raw);
        if (monthIndex >= 0) return `tr-month-hd m-${monthIndex + 1}`;
        const cat = trCustomFindCatByLabel(raw);
        if (cat) return `tr-cat-hd tr-row-${cat.key}`;
        return `tr-month-hd m-${((Math.max(1, colIndex) - 1) % 12) + 1}`;
    }

    // 返回行表头单元格样式类名
    function trCustomGetRowHeaderClass(label, rowIndex) {
        const raw = String(label || '').trim();
        if (/^\d{4}$/.test(raw)) return `tr-year-col ${trGetYearTone(Number(raw))}`;
        const monthIndex = trCustomParseMonthHeader(raw);
        if (monthIndex >= 0) return `tr-month-hd m-${monthIndex + 1}`;
        const cat = trCustomFindCatByLabel(raw);
        if (cat) return `tr-cat-hd tr-row-${cat.key}`;
        const cycleKey = TR_CUSTOM_ROW_HD_CYCLE_KEYS[(Math.max(1, rowIndex) - 1) % TR_CUSTOM_ROW_HD_CYCLE_KEYS.length];
        return `tr-cat-hd tr-row-${cycleKey}`;
    }

    // 返回自定义表格打印表头配色 CSS 片段
    function trCustomGetPrintHeaderToneCss() {
        return '.tr-custom-print-table th.tr-custom-corner-hd{background:linear-gradient(135deg,#f8fafc,#e2e8f0)!important;color:#334155!important}'
            + '.tr-custom-print-table th.tr-custom-total-hd{background:linear-gradient(135deg,#fff7ed,#fdba74)!important;color:#9a3412!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-1{background:linear-gradient(135deg,#8aff86 0%,#ddff62 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-2{background:linear-gradient(135deg,#e0f2fe,#7dd3fc)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-3{background:linear-gradient(135deg,#fef9c3,#facc15)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-4{background:linear-gradient(135deg,#fde68a,#fb923c)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-5{background:linear-gradient(135deg,#fae8ff,#d946ef)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-6{background:linear-gradient(135deg,#ffedd5,#fb923c)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-7{background:linear-gradient(135deg,#e0e7ff,#6366f1)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-8{background:linear-gradient(135deg,#2af598 0%,#009efd 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-year-col.tr-tone-9{background:linear-gradient(135deg,#fffefb,#ff6fe3)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-1{background:linear-gradient(135deg,#8aff86 0%,#ddff62 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-2{background:linear-gradient(135deg,#e0f2fe,#7dd3fc)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-3{background:linear-gradient(135deg,#fef9c3,#facc15)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-4{background:linear-gradient(135deg,#dcfce7,#4ade80)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-5{background:linear-gradient(135deg,#fae8ff,#d946ef)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-6{background:linear-gradient(135deg,#ffedd5,#fb923c)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-7{background:linear-gradient(135deg,#e0e7ff,#6366f1)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-8{background:linear-gradient(135deg,#2af598 0%,#009efd 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-9{background:linear-gradient(135deg,#ccfbf1,#2dd4bf)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-10{background:linear-gradient(135deg,#f6d365 0%,#fda085 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-11{background:linear-gradient(135deg,#0ba360 0%,#3cba92 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-month-hd.m-12{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)!important;color:#111!important}'
            + '.tr-custom-print-table th.tr-cat-hd.tr-row-cash{background:linear-gradient(135deg,#dbeafe,#93c5fd)!important;color:#0e8200!important}'
            + '.tr-custom-print-table th.tr-cat-hd.tr-row-check{background:linear-gradient(135deg,#fee2e2,#fca5a5)!important;color:#2811e7!important}'
            + '.tr-custom-print-table th.tr-cat-hd.tr-row-delivery{background:linear-gradient(135deg,#d1fae5,#86efac)!important;color:#14b8a6!important}'
            + '.tr-custom-print-table th.tr-cat-hd.tr-row-others{background:linear-gradient(135deg,#ede9fe,#c4b5fd)!important;color:#a855f7!important}'
            + '.tr-custom-print-table th.tr-cat-hd.tr-row-expense{background:linear-gradient(135deg,#fef3c7,#fcd34d)!important;color:#d88800!important}'
            + '.tr-custom-print-table th.tr-cat-hd.tr-row-costTotal{background:linear-gradient(135deg,#ffedd5,#fdba74)!important;color:#6b55cf!important}'
            + '.tr-custom-print-table tfoot td{background:rgba(255,237,213,.88);font-weight:900}'
            + '.tr-custom-print-table tfoot td:first-child{background:rgba(255,237,213,.96)!important;color:#9a3412!important}';
    }

    // 构建自定义表格 colgroup HTML
    function trCustomBuildColgroupHtml(cols) {
        const safeCols = Math.max(1, Number(cols) || 1);
        if (trIsMobile()) {
            const colWidth = `${Math.max(72, Math.floor(1000 / Math.max(2, safeCols)))}px`;
            return Array.from({ length: safeCols }, () => `<col style="width:${colWidth}">`).join('');
        }
        const colPercent = (100 / safeCols).toFixed(4);
        return Array.from({ length: safeCols }, () => `<col style="width:${colPercent}%">`).join('');
    }

    // 构建可编辑或静态单元格 span HTML
    function trCustomBuildEditableCellHtml(value, attrs, editable) {
        const content = escapeHtml(value || '');
        if (editable) {
            return `<span class="tr-custom-editable"${attrs} tabindex="0">${content}</span>`;
        }
        return `<span class="tr-custom-static-cell">${content || '&nbsp;'}</span>`;
    }

    // 构建单个分区的可编辑表格 HTML
    function trCustomBuildSingleEditableTableHtml(section, options = {}) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        const totalCol = trCustomGetTotalColIndex(safe);
        const sums = trCustomComputeColumnSumsFromGrid(safe.cells, safe.rows, safe.cols);
        const sectionIndex = Number(options.sectionIndex);
        const sectionAttr = Number.isInteger(sectionIndex) && sectionIndex >= 0 ? ` data-section="${sectionIndex}"` : '';
        const editable = typeof options.editable === 'boolean' ? options.editable : trCustomIsWorkspaceEditable();
        let html = `<table class="tr-custom-table"><colgroup>${trCustomBuildColgroupHtml(safe.cols)}</colgroup><thead><tr>`;
        for (let c = 0; c < safe.cols; c += 1) {
            const headerClass = c === 0
                ? trCustomGetCornerHeaderClass(safe.cells[0][c] || '')
                : trCustomGetColHeaderClass(safe.cells[0][c] || '', c);
            const headerEditable = editable && !(totalCol > 0 && c === totalCol);
            html += `<th class="${headerClass}">${trCustomBuildEditableCellHtml(safe.cells[0][c] || '', `${sectionAttr} data-row="0" data-col="${c}"`, headerEditable)}</th>`;
        }
        html += '</tr></thead><tbody>';
        const totalRow = trCustomGetTotalRowIndex(safe.rows);
        for (let r = 1; r < totalRow; r += 1) {
            html += '<tr>';
            for (let c = 0; c < safe.cols; c += 1) {
                if (c === 0) {
                    const rowHeaderClass = trCustomGetRowHeaderClass(safe.cells[r][c] || '', r);
                    html += `<th scope="row" class="${rowHeaderClass}">${trCustomBuildEditableCellHtml(safe.cells[r][c] || '', `${sectionAttr} data-row="${r}" data-col="${c}"`, editable)}</th>`;
                } else if (totalCol > 0 && c === totalCol) {
                    const rowSum = String(safe.cells[r]?.[c] || '').trim();
                    html += `<td><span class="tr-custom-sum-cell"${sectionAttr} data-sum-row="${r}" data-sum-col="${c}">${rowSum ? escapeHtml(rowSum) : '&nbsp;'}</span></td>`;
                } else {
                    html += `<td>${trCustomBuildEditableCellHtml(safe.cells[r][c] || '', `${sectionAttr} data-row="${r}" data-col="${c}"`, editable)}</td>`;
                }
            }
            html += '</tr>';
        }
        html += '<tfoot><tr>';
        for (let c = 0; c < safe.cols; c += 1) {
            if (c === 0) {
                html += `<td${sectionAttr ? ` data-section="${sectionIndex}"` : ''}>${escapeHtml(safe.cells[totalRow][c] || 'Total')}</td>`;
            } else {
                html += `<td class="tr-custom-sum-cell"${sectionAttr} data-sum-col="${c}">${escapeHtml(trFmt(formatCategoryDisplay(sums[c])))}</td>`;
            }
        }
        html += '</tr></tfoot></table>';
        return html;
    }

    // 确保模板各分区合计行已计算
    function trCustomEnsureComputedSums(template) {
        if (!template) return template;
        const isMulti = Array.isArray(template.sections) && template.sections.length > 0;
        if (isMulti) {
            template.sections.forEach((section) => {
                if (trCustomGetTotalColIndex(section) > 0) trCustomApplyComputedSums(section);
            });
        } else if (trCustomGetTotalColIndex(template) > 0) {
            trCustomApplyComputedSums(template);
        }
        return template;
    }

    // 构建完整可编辑表格（含多表堆叠）HTML
    function trCustomBuildEditableTableHtml(template) {
        trCustomEnsureComputedSums(template);
        const safe = trCustomNormalizeTemplate(template);
        const editable = trCustomIsWorkspaceEditable();
        if (trCustomIsMultiLayout(safe)) {
            const tablesHtml = safe.sections.map((section, index) => {
                const sectionSafe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
                const colsClass = trCustomGetDesktopColsClass(sectionSafe.cols);
                const colsStyle = trCustomGetDesktopColsStyle(sectionSafe.cols);
                const activeClass = index === trCustomActiveTableIndex ? ' is-active-table' : '';
                return `<div class="tr-custom-section${activeClass}" data-table-index="${index}">
                            <div class="tr-custom-section-table${colsClass ? ` ${colsClass}` : ''}"${colsStyle}>${trCustomBuildSingleEditableTableHtml(section, { sectionIndex: index, editable })}</div>
                        </div>`;
            }).join('');
            return `<div class="tr-custom-table-stack">${tablesHtml}</div>`;
        }
        return trCustomBuildSingleEditableTableHtml(safe, { editable });
    }

    const TR_CUSTOM_PRINT_MM_TO_PX = 96 / 25.4;
    const TR_CUSTOM_PRINT_MARGIN_MM = 8;
    const TR_CUSTOM_PRINT_PAGE_WIDTH_PX = Math.floor((210 - TR_CUSTOM_PRINT_MARGIN_MM * 2) * TR_CUSTOM_PRINT_MM_TO_PX);
    const TR_CUSTOM_PRINT_PAGE_HEIGHT_PX = Math.floor((297 - TR_CUSTOM_PRINT_MARGIN_MM * 2) * TR_CUSTOM_PRINT_MM_TO_PX);
    const TR_CUSTOM_PRINT_ROW_H = 34;
    const TR_CUSTOM_PRINT_FONT_SIZE = 13;
    const TR_CUSTOM_PRINT_CELL_PAD_V = 4;
    const TR_CUSTOM_PRINT_CELL_PAD_H = 2;
    const TR_CUSTOM_PRINT_TITLE_H = 20;
    const TR_CUSTOM_PRINT_BLOCK_GAP = 8;

    // 返回自定义表格 A4 打印页尺寸规格
    function trCustomGetPrintPageSpec() {
        const rowH = TR_CUSTOM_PRINT_ROW_H;
        const isLandscape = typeof printPaperOrientation === 'string' && printPaperOrientation === 'landscape';
        const pageW = isLandscape ? TR_CUSTOM_PRINT_PAGE_HEIGHT_PX : TR_CUSTOM_PRINT_PAGE_WIDTH_PX;
        const pageH = isLandscape ? TR_CUSTOM_PRINT_PAGE_WIDTH_PX : TR_CUSTOM_PRINT_PAGE_HEIGHT_PX;
        const usableH = pageH;
        const overhead = TR_CUSTOM_PRINT_TITLE_H + TR_CUSTOM_PRINT_BLOCK_GAP;
        const maxRowsPerPage = Math.max(1, Math.floor((usableH - overhead) / rowH));
        return {
            widthPx: pageW,
            heightPx: pageH,
            rowHeightPx: rowH,
            fontSizePx: TR_CUSTOM_PRINT_FONT_SIZE,
            titleHeightPx: TR_CUSTOM_PRINT_TITLE_H,
            blockGapPx: TR_CUSTOM_PRINT_BLOCK_GAP,
            maxRowsPerPage,
            marginMm: TR_CUSTOM_PRINT_MARGIN_MM,
            orientation: isLandscape ? 'landscape' : 'portrait',
        };
    }

    // 解析模板用于显示的标题文本
    function trCustomGetTemplateDisplayTitle(templateId) {
        const match = trCustomTemplates.find((item) => item.id === Number(templateId));
        if (!match) return `表格 ${trCustomGetTemplateButtonLabel(templateId)}`;
        const raw = match.data && typeof match.data === 'object' ? match.data : {};
        const reportTitle = String(raw.title || '').trim();
        if (reportTitle) return reportTitle;
        if (Array.isArray(raw.sections) && raw.sections.length > 0) {
            const firstTitle = String(raw.sections[0]?.title || '').trim();
            if (firstTitle) return firstTitle;
            return `报表 ${trCustomGetTemplateButtonLabel(templateId)}`;
        }
        return `表格 ${trCustomGetTemplateButtonLabel(templateId)}`;
    }

    // 返回打印行高与字号等指标
    function trCustomGetPrintRowMetrics(_cols, options = {}) {
        return {
            rowHeight: Number(options.rowHeight) > 0 ? Number(options.rowHeight) : TR_CUSTOM_PRINT_ROW_H,
            fontSize: TR_CUSTOM_PRINT_FONT_SIZE,
            titleSize: 16,
            cellPaddingV: TR_CUSTOM_PRINT_CELL_PAD_V,
            cellPaddingH: TR_CUSTOM_PRINT_CELL_PAD_H,
        };
    }

    // 从打印选中项收集待排版区块列表
    function trCustomCollectPrintBlocksFromSelections(selections) {
        const blocks = [];
        (Array.isArray(selections) ? selections : []).forEach((selection) => {
            const template = selection && selection.data ? trCustomNormalizeTemplate(selection.data) : null;
            if (!template) return;
            const reportTitle = String(selection.title || trCustomGetTemplateDisplayTitle(selection.meta?.id)).trim() || '自定义表格';
            if (trCustomIsMultiLayout(template)) {
                template.sections.forEach((section, index) => {
                    blocks.push({
                        title: String(section.title || `${reportTitle} ${index + 1}`).trim() || reportTitle,
                        section: trCustomNormalizeSection(section, template.rows, template.cols),
                    });
                });
                return;
            }
            blocks.push({
                title: reportTitle,
                section: trCustomNormalizeSection(template, template.rows, template.cols),
            });
        });
        return blocks;
    }

    // 估算单个打印区块占用高度
    function trCustomMeasurePrintBlockHeight(block, metrics, titleH = TR_CUSTOM_PRINT_TITLE_H, gap = TR_CUSTOM_PRINT_BLOCK_GAP) {
        const rows = Math.max(1, Number(block.section?.rows) || 1);
        return titleH + rows * metrics.rowHeight + gap;
    }

    // 将打印区块分页组合
    function trCustomPaginatePrintBlocks(blocks, pageHeightPx, metrics) {
        const usableH = Math.max(120, Number(pageHeightPx) || 554);
        const pages = [];
        let current = [];
        let usedH = 0;
        blocks.forEach((block) => {
            const blockH = trCustomMeasurePrintBlockHeight(block, metrics);
            if (current.length > 0 && usedH + blockH > usableH) {
                pages.push(current);
                current = [];
                usedH = 0;
            }
            if (blockH > usableH && current.length > 0) {
                pages.push(current);
                current = [];
                usedH = 0;
            }
            current.push(block);
            usedH += blockH;
        });
        if (current.length) pages.push(current);
        return pages.length ? pages : [[]];
    }

    // 返回打印单元格内联样式字符串
    function trCustomGetPrintCellStyle(metrics) {
        return `height:${metrics.rowHeight}px;max-height:${metrics.rowHeight}px;font-size:${metrics.fontSize}px;line-height:1.1;padding:${metrics.cellPaddingV}px ${metrics.cellPaddingH}px;box-sizing:border-box;`;
    }

    // 构建单个分区静态打印表 HTML
    function trCustomBuildStaticSingleTableHtml(section, options = {}) {
        const safe = trCustomNormalizeSection(section, TR_CUSTOM_DEFAULT_ROWS, TR_CUSTOM_DEFAULT_COLS);
        const sums = trCustomComputeColumnSumsFromGrid(safe.cells, safe.rows, safe.cols);
        const title = String(options.title || '自定义表格');
        const rows = safe.rows;
        const cols = safe.cols;
        const metrics = trCustomGetPrintRowMetrics(cols, options);
        const cellStyle = trCustomGetPrintCellStyle(metrics);
        let html = `<div class="tr-custom-print-page"><div class="tr-custom-print-title">${escapeHtml(title)}</div><div class="tr-custom-print-wrap"><table class="tr-custom-print-table" style="width:100%;">`;
        html += '<thead><tr>';
        for (let c = 0; c < cols; c += 1) {
            const headerClass = c === 0
                ? trCustomGetCornerHeaderClass(safe.cells[0][c] || '')
                : trCustomGetColHeaderClass(safe.cells[0][c] || '', c);
            html += `<th class="${headerClass}" style="${cellStyle}">${escapeHtml(safe.cells[0][c] || '')}</th>`;
        }
        html += '</tr></thead><tbody>';
        const totalRow = trCustomGetTotalRowIndex(rows);
        for (let r = 1; r < totalRow; r += 1) {
            html += '<tr>';
            for (let c = 0; c < cols; c += 1) {
                if (c === 0) {
                    const rowHeaderClass = trCustomGetRowHeaderClass(safe.cells[r][c] || '', r);
                    html += `<th scope="row" class="${rowHeaderClass}" style="${cellStyle}">${escapeHtml(safe.cells[r][c] || '') || '&nbsp;'}</th>`;
                } else {
                    html += `<td style="${cellStyle}">${escapeHtml(safe.cells[r][c] || '') || '&nbsp;'}</td>`;
                }
            }
            html += '</tr>';
        }
        html += '<tfoot><tr>';
        for (let c = 0; c < cols; c += 1) {
            html += c === 0
                ? `<td style="${cellStyle}">${escapeHtml(safe.cells[totalRow][c] || 'Total')}</td>`
                : `<td style="${cellStyle}">${escapeHtml(trFmt(formatCategoryDisplay(sums[c]))) || '&nbsp;'}</td>`;
        }
        html += '</tr></tfoot></table></div></div>';
        return html;
    }

    // 构建完整静态打印表 HTML
    function trCustomBuildStaticTableHtml(template, options = {}) {
        trCustomEnsureComputedSums(template);
        const safe = trCustomNormalizeTemplate(template);
        if (trCustomIsMultiLayout(safe)) {
            return safe.sections.map((section, index) => (
                trCustomBuildStaticSingleTableHtml(section, {
                    title: section.title || `${String(options.title || '自定义表格')} ${index + 1}`,
                    rowHeight: options.rowHeight,
                })
            )).join('');
        }
        return trCustomBuildStaticSingleTableHtml(safe, options);
    }

    // 将打印内容包裹为 A4 页或预览缩放页
    function trCustomWrapPrintPageHtml(innerHtml, options = {}) {
        const spec = trCustomGetPrintPageSpec();
        const pageWidthPx = spec.widthPx;
        const pageHeightPx = spec.heightPx;
        const pageClass = options.forPrint ? 'tr-custom-print-a4-page' : 'tr-custom-print-a4-page tr-custom-print-preview-page';
        const previewWidthPx = Math.max(120, Number(options.previewWidthPx) || pageWidthPx);
        const scale = Math.min(1, previewWidthPx / pageWidthPx);
        const scaledH = Math.ceil(pageHeightPx * scale);
        const pageHtml = `<div class="${pageClass}" style="width:${pageWidthPx}px;height:${pageHeightPx}px;box-sizing:border-box;display:flex;flex-direction:column;gap:${TR_CUSTOM_PRINT_BLOCK_GAP}px;overflow:hidden;background:#fff;">${innerHtml}</div>`;
        if (options.forPrint || scale >= 0.999) return pageHtml;
        return `<div class="tr-custom-print-preview-scale-host" style="width:100%;height:${scaledH}px;overflow:hidden;position:relative;"><div class="tr-custom-print-preview-scale-inner" style="width:${pageWidthPx}px;height:${pageHeightPx}px;transform:scale(${scale});transform-origin:top left;">${pageHtml}</div></div>`;
    }

    // 构建分页后的自定义表格打印 HTML
    function trCustomBuildPaginatedPrintHtml(selections, options = {}) {
        const spec = trCustomGetPrintPageSpec();
        const pageWidthPx = spec.widthPx;
        const pageHeightPx = spec.heightPx;
        const metrics = trCustomGetPrintRowMetrics(8, { rowHeight: TR_CUSTOM_PRINT_ROW_H });
        const blocks = trCustomCollectPrintBlocksFromSelections(selections);
        if (!blocks.length) {
            return { pages: ['<div style="padding:20px;text-align:center;color:#666;">暂无表格</div>'], totalPages: 1, spec };
        }
        const pageGroups = trCustomPaginatePrintBlocks(blocks, pageHeightPx, metrics);
        const pages = pageGroups.map((group) => {
            const inner = group.map((block) => trCustomBuildStaticSingleTableHtml(block.section, {
                title: block.title,
                rowHeight: metrics.rowHeight,
            })).join('');
            return trCustomWrapPrintPageHtml(inner, {
                forPrint: Boolean(options.forPrint),
                previewWidthPx: options.previewWidthPx,
            });
        });
        return { pages, totalPages: pages.length, spec };
    }

    // 从网格数据计算各列合计值
    function trCustomComputeColumnSumsFromGrid(cells, rows, cols) {
        const safeCols = Math.max(1, Number(cols) || 1);
        const safeRows = Math.max(2, Number(rows) || 2);
        const sums = Array.from({ length: safeCols }, () => 0);
        const lastDataRow = trCustomGetTotalRowIndex(safeRows);
        const totalCol = safeCols >= 2 && String(cells?.[0]?.[safeCols - 1] || '').trim() === '总额'
            ? safeCols - 1
            : -1;
        const sumEndCol = totalCol > 0 ? totalCol : safeCols;

        for (let r = 1; r < lastDataRow; r += 1) {
            const row = Array.isArray(cells?.[r]) ? cells[r] : [];
            for (let c = 1; c < sumEndCol; c += 1) {
                sums[c] += trCustomParseNumeric(row[c]);
            }
        }

        if (totalCol > 0) {
            let grand = 0;
            for (let r = 1; r < lastDataRow; r += 1) {
                for (let c = 1; c < totalCol; c += 1) {
                    grand += trCustomParseNumeric(cells?.[r]?.[c]);
                }
            }
            sums[totalCol] = grand;
        }
        return sums;
    }

    // 将草稿合计同步到 DOM 合计单元格
    function trCustomSyncSumCellsDom(sectionIndex = null) {
        const content = document.getElementById('totalReportContent');
        if (!content || trMode !== 'custom' || !trCustomDraft) return;
        const rows = Number(trCustomDraft.rows) || TR_CUSTOM_DEFAULT_ROWS;
        const cols = Number(trCustomDraft.cols) || TR_CUSTOM_DEFAULT_COLS;
        const isMulti = Array.isArray(trCustomDraft.sections) && trCustomDraft.sections.length > 0;

        const syncSection = (section, sectionAttrSelector) => {
            const sectionRows = Number(section?.rows) || rows;
            const sectionCols = Number(section?.cols) || cols;
            const sums = trCustomComputeColumnSumsFromGrid(section?.cells, sectionRows, sectionCols);
            content.querySelectorAll(`.tr-custom-sum-cell${sectionAttrSelector}[data-sum-col]:not([data-sum-row])`).forEach((cell) => {
                const col = Number(cell.dataset.sumCol);
                if (!Number.isInteger(col)) return;
                cell.innerHTML = escapeHtml(trFmt(formatCategoryDisplay(sums[col]))) || '&nbsp;';
                trCustomFitCellFont(cell);
            });
            content.querySelectorAll(`.tr-custom-sum-cell${sectionAttrSelector}[data-sum-row]`).forEach((cell) => {
                const row = Number(cell.dataset.sumRow);
                const col = Number(cell.dataset.sumCol);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                const raw = String((section?.cells?.[row] && section.cells[row][col]) ?? '').trim();
                cell.innerHTML = raw ? escapeHtml(raw) : '&nbsp;';
                trCustomFitCellFont(cell);
            });
        };

        if (isMulti) {
            trCustomDraft.sections.forEach((section, idx) => {
                if (sectionIndex !== null && idx !== sectionIndex) return;
                syncSection(section, `[data-section="${idx}"]`);
            });
            return;
        }
        syncSection(trCustomDraft, ':not([data-section])');
    }

    // 同步合计行 DOM 显示。
    function trCustomSyncSumRow() {
        trCustomSyncSumCellsDom();
    }

    // 判断草稿是否为多表（月/自定义）布局
    function trCustomIsMultiDraftLayout(draft = trCustomDraft) {
        return (draft?.layout === 'month' || draft?.layout === 'custom')
            && Array.isArray(draft?.sections) && draft.sections.length > 0;
    }

    // 判断指定草稿单元格是否允许写入
    function trCustomCanWriteDraftCell(sectionIndex, row, col) {
        if (!trCustomDraft || !Number.isInteger(row) || !Number.isInteger(col)) return false;
        const isMulti = trCustomIsMultiDraftLayout();
        let gridRows = Number(trCustomDraft.rows) || TR_CUSTOM_DEFAULT_ROWS;
        let gridCols = Number(trCustomDraft.cols) || TR_CUSTOM_DEFAULT_COLS;
        let cells = trCustomDraft.cells;
        if (isMulti && Number.isInteger(sectionIndex) && sectionIndex >= 0 && trCustomDraft.sections[sectionIndex]) {
            const section = trCustomDraft.sections[sectionIndex];
            gridRows = Number(section.rows) || gridRows;
            gridCols = Number(section.cols) || gridCols;
            cells = section.cells;
        }
        if (row < 0 || col < 0 || row >= gridRows || col >= gridCols) return false;
        if (trCustomIsTotalRow(row, gridRows)) return false;
        if (trCustomIsProtectedTotalLabelCell(row, col, gridRows, gridCols, cells)) return false;
        if (trCustomIsComputedSumCell(row, col, gridRows, gridCols, cells)) return false;
        return true;
    }

    // 将合计公式写回草稿指定分区
    function trCustomApplyComputedSumsToDraft(sectionIndex) {
        if (!trCustomDraft) return;
        const isMulti = trCustomIsMultiDraftLayout();
        if (isMulti && Number.isInteger(sectionIndex) && sectionIndex >= 0 && trCustomDraft.sections[sectionIndex]) {
            trCustomApplyComputedSums(trCustomDraft.sections[sectionIndex]);
            if (sectionIndex === 0) {
                trCustomApplyComputedSums({
                    rows: trCustomDraft.rows,
                    cols: trCustomDraft.cols,
                    cells: trCustomDraft.cells,
                });
            }
            return;
        }
        trCustomApplyComputedSums(trCustomDraft);
    }

    // 写入草稿单元格并触发合计重算
    function trCustomWriteDraftCell(sectionIndex, row, col, value) {
        if (!trCustomDraft || !trCustomCanWriteDraftCell(sectionIndex, row, col)) return;
        let gridRows = Number(trCustomDraft.rows) || TR_CUSTOM_DEFAULT_ROWS;
        const isMulti = trCustomIsMultiDraftLayout();
        if (isMulti && Number.isInteger(sectionIndex) && sectionIndex >= 0 && trCustomDraft.sections[sectionIndex]) {
            const section = trCustomDraft.sections[sectionIndex];
            gridRows = Number(section.rows) || gridRows;
            if (!Array.isArray(section.cells)) section.cells = [];
            if (!Array.isArray(section.cells[row])) section.cells[row] = [];
            section.cells[row][col] = value;
            if (sectionIndex === 0) {
                if (!Array.isArray(trCustomDraft.cells)) trCustomDraft.cells = [];
                if (!Array.isArray(trCustomDraft.cells[row])) trCustomDraft.cells[row] = [];
                trCustomDraft.cells[row][col] = value;
            }
            if (trCustomGetTotalColIndex(section) > 0) {
                trCustomApplyComputedSums(section);
                if (sectionIndex === 0) {
                    trCustomApplyComputedSums({
                        rows: trCustomDraft.rows,
                        cols: trCustomDraft.cols,
                        cells: trCustomDraft.cells,
                    });
                }
            }
            return;
        }
        if (!Array.isArray(trCustomDraft.cells)) trCustomDraft.cells = [];
        if (!Array.isArray(trCustomDraft.cells[row])) trCustomDraft.cells[row] = [];
        trCustomDraft.cells[row][col] = value;
        if (trCustomGetTotalColIndex(trCustomDraft) > 0) {
            trCustomApplyComputedSums(trCustomDraft);
        }
    }

    // 聚焦并进入指定可编辑单元格
    function trCustomFocusEditable(row, col, sectionIndex = null) {
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        let selector = `.tr-custom-editable[data-row="${row}"][data-col="${col}"]`;
        if (Number.isInteger(sectionIndex) && sectionIndex >= 0) {
            selector = `.tr-custom-editable[data-section="${sectionIndex}"][data-row="${row}"][data-col="${col}"]`;
        }
        const cell = content.querySelector(selector);
        if (!cell) return;
        cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    // 读取草稿指定单元格文本
    function trCustomReadDraftCell(sectionIndex, row, col) {
        if (!trCustomDraft) return '';
        const safe = trCustomNormalizeTemplate(trCustomDraft);
        if (trCustomIsMultiLayout(safe) && Number.isInteger(sectionIndex) && sectionIndex >= 0 && safe.sections[sectionIndex]) {
            return safe.sections[sectionIndex].cells[row][col] || '';
        }
        return safe.cells[row][col] || '';
    }

    // 清除单元格自适应字号内联样式
    function trCustomResetCellFontStyle(el) {
        if (!el) return;
        el.style.fontSize = '';
        el.style.whiteSpace = '';
        el.style.wordBreak = '';
        el.style.overflow = '';
        el.style.textOverflow = '';
    }

    // 计算单元格字号上下限
    function trCustomGetCellFontLimits(box) {
        if (trIsMobile()) {
            const min = TR_CUSTOM_MOBILE_FONT_MIN;
            const height = Math.max(box?.clientHeight || 0, 32);
            const width = Math.max(box?.clientWidth || 0, 24);
            const byHeight = Math.floor(height * 0.72);
            const byWidth = Math.floor(width * 0.42);
            const max = Math.max(
                min,
                Math.min(
                    TR_CUSTOM_MOBILE_FONT_CAP,
                    byHeight,
                    byWidth > 0 ? byWidth : TR_CUSTOM_MOBILE_FONT_CAP
                )
            );
            return { max, min };
        }
        return { max: TR_CUSTOM_DESKTOP_FONT_MAX, min: TR_CUSTOM_DESKTOP_FONT_MIN };
    }

    // 重置单个单元格字号为默认
    function trCustomFitCellFont(el) {
        if (!el) return;
        if (el.classList.contains('tr-custom-editable') && el.classList.contains('editing')) return;
        trCustomResetCellFontStyle(el);
    }

    // 批量重置表格内所有单元格字号
    function trCustomFitAllCellFonts() {
        const content = document.getElementById('totalReportContent');
        if (!content || trMode !== 'custom') return;
        if (content.querySelector('.tr-custom-editable.editing')) return;
        content.querySelectorAll('.tr-custom-table .tr-custom-editable').forEach((cell) => {
            trCustomFitCellFont(cell);
        });
        content.querySelectorAll('.tr-custom-table .tr-custom-sum-cell').forEach((cell) => {
            trCustomFitCellFont(cell);
        });
        content.querySelectorAll('.tr-custom-table tfoot td:first-child').forEach((cell) => {
            trCustomFitCellFont(cell);
        });
    }

    // 断开表格字号自适应 ResizeObserver
    function trCustomDisconnectFontFitObserver() {
        if (!trCustomFontFitObserver) return;
        trCustomFontFitObserver.disconnect();
        trCustomFontFitObserver = null;
    }

    // 清除字号批量调整定时器
    function trCustomClearFontFitAllTimer() {
        if (!trCustomFontFitAllTimer) return;
        clearTimeout(trCustomFontFitAllTimer);
        trCustomFontFitAllTimer = null;
    }

    // 延迟调度批量字号调整
    function trCustomScheduleAllCellFonts() {
        trCustomClearFontFitAllTimer();
        trCustomFontFitAllTimer = setTimeout(() => {
            trCustomFontFitAllTimer = null;
            trCustomFitAllCellFonts();
        }, 120);
    }

    // 监听表格容器尺寸变化以调整字号
    function trCustomBindFontFitObserver() {
        trCustomDisconnectFontFitObserver();
        const wrap = document.getElementById('trCustomTableWrap');
        if (!wrap || typeof ResizeObserver === 'undefined') return;
        trCustomFontFitObserver = new ResizeObserver(() => {
            trCustomScheduleAllCellFonts();
        });
        trCustomFontFitObserver.observe(wrap);
    }

    // 首帧初始化表格单元格字号
    function trCustomInitCellFonts() {
        requestAnimationFrame(() => {
            trCustomFitAllCellFonts();
        });
    }

    //#endregion

    //#region 自定义表 · 点击与按键
    // 绑定自定义表格可编辑单元格交互
    function trCustomBindEditableCells() {
        const content = document.getElementById('totalReportContent');
        if (!content || !trCustomIsWorkspaceEditable()) return;
        content.querySelectorAll('.tr-custom-table .tr-custom-editable').forEach((cell) => {
            cell.addEventListener('click', function () {
                if (!trCustomIsWorkspaceEditable()) return;
                if (this.classList.contains('editing')) return;
                trCustomResetCellFontStyle(this);
                const { max } = trCustomGetCellFontLimits(this.parentElement || this);
                this.style.fontSize = `${max}px`;
                this.contentEditable = 'true';
                this.classList.add('editing');
                this.focus();
                const range = document.createRange();
                range.selectNodeContents(this);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
            cell.addEventListener('input', function () {
                const row = Number(this.dataset.row);
                const col = Number(this.dataset.col);
                const sectionIndex = this.dataset.section === undefined ? null : Number(this.dataset.section);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                trCustomWriteDraftCell(sectionIndex, row, col, (this.textContent || '').replace(/\u00a0/g, ''));
                if (row >= 1 && col >= 1) {
                    trCustomSyncSumCellsDom(sectionIndex);
                }
            });
            cell.addEventListener('blur', function () {
                this.contentEditable = 'false';
                this.classList.remove('editing');
                const row = Number(this.dataset.row);
                const col = Number(this.dataset.col);
                const sectionIndex = this.dataset.section === undefined ? null : Number(this.dataset.section);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                trCustomWriteDraftCell(sectionIndex, row, col, (this.textContent || '').replace(/\u00a0/g, ''));
                if (row >= 1 && col >= 1) {
                    trCustomSyncSumCellsDom(sectionIndex);
                }
                if ((row === 0 || col === 0) && trMode === 'custom') {
                    const activeIdx = trCustomGetActiveTableIndex(trCustomDraft);
                    if (sectionIndex === null || sectionIndex === activeIdx) {
                        trCustomSyncShellFromActiveTable();
                        trRenderYearFilter(trGetAllYears());
                        trRenderSettings();
                    }
                }
                trCustomRefreshStatus();
                trCustomFitCellFont(this);
            });
            cell.addEventListener('keydown', function (e) {
                const row = Number(this.dataset.row);
                const col = Number(this.dataset.col);
                const sectionIndex = this.dataset.section === undefined ? null : Number(this.dataset.section);
                const grid = (Number.isInteger(sectionIndex) && sectionIndex >= 0 && trCustomDraft?.sections?.[sectionIndex])
                    ? trCustomDraft.sections[sectionIndex]
                    : trCustomDraft;
                const editableRows = trCustomGetTotalRowIndex(grid.rows);
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.blur();
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    this.blur();
                    const delta = e.shiftKey ? -1 : 1;
                    const total = editableRows * grid.cols;
                    let index = row * grid.cols + col + delta;
                    if (index < 0) index = 0;
                    if (index >= total) index = total - 1;
                    trCustomFocusEditable(Math.floor(index / grid.cols), index % grid.cols, sectionIndex);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.textContent = trCustomReadDraftCell(sectionIndex, row, col) || '';
                    this.blur();
                }
            });
        });
    }

    //#endregion

    //#region 打印模块 · 内容与编辑
    const TR_MODULE_API_BASE = `${LEDGER_API_BASE}/custom-module`;
    const TR_MODULE_MAX_SAVED = 5;
    const TR_MODULE_PRINTABLE_MAX_POSITION = 3;
    const TR_MODULE_DEFAULT_ROWS = 4;
    const TR_MODULE_DEFAULT_COLS = 6;
    const TR_MODULE_MIN_ROWS = 2;
    const TR_MODULE_MIN_COLS = 2;
    const TR_MODULE_MAX_ROWS = 40;
    const TR_MODULE_MAX_COLS = 16;
    const TR_MODULE_PRINT_WIDTH_PORTRAIT = 392;
    const TR_MODULE_PRINT_WIDTH_LANDSCAPE = 560;
    const TR_MODULE_A4_EDGE_INSET = 6;
    const TR_MODULE_PRINT_REF_WRAP_H = 554;
    const TR_MODULE_PRINT_REF_STACK_RATIO = 492;
    const TR_MODULE_PRINT_REF_BOTTOM_RATIO = 78;
    const TR_MODULE_PRINT_ROW_H = 10;
    const TR_MODULE_PRINT_REF_TABLE_ROWS = 5;
    const TR_MODULE_PRINT_STACK_RATIOS = [
        { key: 'cash', ratio: 74 },
        { key: 'check', ratio: 138 },
        { key: 'delivery', ratio: 112 },
        { key: 'expense', ratio: 90 },
        { key: 'bottom', ratio: 78 },
    ];
    const TR_MODULE_PRINT_STACK_RATIO_TOTAL = 492;
    const TR_MODULE_CREATE_PREVIEW_SCALE_MAX = 2.6;
    const TR_MODULE_CREATE_PREVIEW_EMPTY_H = 160;

    // 计算打印预览各栈区块高度
    function trModuleCalcPrintStackHeights(wrapW = null, wrapH = null) {
        const isLandscape = typeof printPaperOrientation === 'string' && printPaperOrientation === 'landscape';
        const designW = isLandscape ? TR_MODULE_PRINT_WIDTH_LANDSCAPE : TR_MODULE_PRINT_WIDTH_PORTRAIT;
        const safeWrapW = Math.max(80, Number(wrapW) || designW);
        const safeWrapH = Math.max(120, Number(wrapH) || TR_MODULE_PRINT_REF_WRAP_H);
        const designH = Math.max(120, Math.round(34 + 520));
        const scale = Math.min(safeWrapW / designW, safeWrapH / designH, 1.18);
        const gap = Math.max(1, Math.round(2 * scale));
        const titleH = Math.max(14, Math.round(16 * scale));
        const summaryH = Math.max(16, Math.round(18 * scale));
        const remainingH = Math.max(40, safeWrapH - titleH - summaryH - gap * (TR_MODULE_PRINT_STACK_RATIOS.length + 1));
        const heights = {};
        let usedH = 0;
        TR_MODULE_PRINT_STACK_RATIOS.forEach((item, index) => {
            const h = index === TR_MODULE_PRINT_STACK_RATIOS.length - 1
                ? (remainingH - usedH)
                : Math.max(32, Math.floor(remainingH * item.ratio / TR_MODULE_PRINT_STACK_RATIO_TOTAL));
            heights[item.key] = h;
            usedH += h;
        });
        return heights;
    }

    // 获取刷卡区块参考高度
    function trModuleGetCheckPitHeight(wrapW = null, wrapH = TR_MODULE_PRINT_REF_WRAP_H) {
        const safeWrapW = Math.max(80, Number(wrapW) || TR_MODULE_PRINT_WIDTH_PORTRAIT);
        const heights = trModuleCalcPrintStackHeights(safeWrapW, wrapH);
        return Math.max(32, Number(heights.check) || 0);
    }

    // 解析创建预览使用的坑位高度
    function trModuleResolveCreatePreviewPitHeight(wrapW = null, wrapH = TR_MODULE_PRINT_REF_WRAP_H) {
        const safeWrapW = Math.max(80, Number(wrapW) || TR_MODULE_PRINT_WIDTH_PORTRAIT);
        const safeWrapH = Math.max(120, Number(wrapH) || TR_MODULE_PRINT_REF_WRAP_H);
        const heights = trModuleCalcPrintStackHeights(safeWrapW, safeWrapH);
        const selectedSet = new Set(Array.isArray(printSelectedCats) ? printSelectedCats : []);
        const stackPlan = allocatePrintStackSlots(selectedSet, { moduleIds: printActiveModuleIds.slice() });
        const namedHit = stackPlan.namedPits.find((pit) => isPrintModuleOccupantKey(pit.occupantKey));
        if (namedHit) {
            const pitH = Number(heights[namedHit.ownerKey]);
            if (Number.isFinite(pitH) && pitH > 0) return pitH;
        }
        const publicModuleHit = stackPlan.publicItems.find((itemKey) => isPrintModuleOccupantKey(itemKey));
        if (publicModuleHit) {
            const bottomH = Number(heights.bottom);
            if (Number.isFinite(bottomH) && bottomH > 0) return bottomH;
        }
        return trModuleGetCheckPitHeight(safeWrapW, safeWrapH);
    }

    // 获取模块插入打印预览的尺寸规格
    function trModuleGetPrintInsertSpec() {
        const printPreview = document.getElementById('printPreviewContent');
        let wrapW = TR_MODULE_PRINT_WIDTH_PORTRAIT;
        let wrapH = TR_MODULE_PRINT_REF_WRAP_H;
        if (printPreview) {
            const rect = printPreview.getBoundingClientRect();
            if (rect.width > 0) wrapW = Math.max(240, Math.floor(rect.width) || printPreview.clientWidth || wrapW);
            if (rect.height > 0) wrapH = Math.max(160, Math.floor(rect.height) || printPreview.clientHeight || wrapH);
        }
        const designH = Math.max(120, Math.round(34 + 520));
        const layoutScale = Math.min(wrapW / TR_MODULE_PRINT_WIDTH_PORTRAIT, wrapH / designH, 1.18);
        const widthNudge = 1;
        const widthPx = Math.max(80, wrapW - widthNudge);
        const pitBoxH = trModuleGetCheckPitHeight(wrapW, wrapH);
        const createPitBoxH = trModuleResolveCreatePreviewPitHeight(wrapW, wrapH);
        const guideWidthPx = widthPx + TR_MODULE_A4_EDGE_INSET * 2;
        return { wrapW, wrapH, widthPx, pitBoxH, createPitBoxH, layoutScale, guideWidthPx };
    }

    // 获取创建预览最大坑位高度
    function trModuleGetCreatePreviewMaxPitHeight() {
        const spec = trModuleGetPrintInsertSpec();
        return Number(spec.createPitBoxH) > 0 ? spec.createPitBoxH : spec.pitBoxH;
    }

    // 计算坑位内容区可用高度
    function trModuleGetPitBodyHeight(pitBoxH, scale = 1) {
        const metrics = trModuleGetPrintBlockMetrics(scale);
        return Math.max(10, pitBoxH - metrics.padV * 2 - metrics.titleH - metrics.titleGap);
    }

    // 计算坑位可容纳的最大行数
    function trModuleGetMaxRowsForPit(pitBoxH, rowH = TR_MODULE_PRINT_ROW_H, scale = 1) {
        const bodyH = trModuleGetPitBodyHeight(pitBoxH, scale);
        const safeRowH = Math.max(1, Number(rowH) || TR_MODULE_PRINT_ROW_H);
        return Math.max(1, Math.floor(bodyH / safeRowH));
    }

    // 获取模块打印布局缩放比
    function trModuleGetPrintLayoutScale() {
        const blockWidthPx = trModuleGetPreviewBlockWidthPx();
        const designH = Math.max(120, Math.round(34 + 520));
        const safeWrapH = TR_MODULE_PRINT_REF_WRAP_H;
        return Math.min(blockWidthPx / 392, safeWrapH / designH, 1.18);
    }

    // 将总宽度均分为多列宽
    function trModuleSplitEqualWidths(totalW, count) {
        const safeCount = Math.max(1, Number(count) || 1);
        const safeTotal = Math.max(safeCount, Number(totalW) || safeCount);
        const baseW = Math.floor(safeTotal / safeCount);
        const remainder = safeTotal - baseW * safeCount;
        return Array.from({ length: safeCount }, (_, index) => baseW + (index < remainder ? 1 : 0));
    }

    // 计算金额表各列打印宽度
    function trModuleGetMoneyBoxColWidths(widthPx, colCount, scale, showTotalCol) {
        const metrics = trModuleGetPrintBlockMetrics(scale);
        const innerBoxW = Math.max(40, widthPx - metrics.padH * 2);
        const safeCols = Math.max(1, Number(colCount) || 1);
        if (!showTotalCol || safeCols < 2) {
            return trModuleSplitEqualWidths(innerBoxW, safeCols);
        }
        const labelW = Math.max(34, Math.round(36 * scale));
        const amtW = Math.max(32, Math.round(40 * scale));
        const layoutSlack = 2;
        if (safeCols === 2) {
            return [Math.max(34, innerBoxW - amtW - layoutSlack), amtW];
        }
        const middleCount = safeCols - 2;
        const middleAreaW = Math.max(middleCount, innerBoxW - labelW - amtW - layoutSlack);
        return [labelW, ...trModuleSplitEqualWidths(middleAreaW, middleCount), amtW];
    }

    // 获取打印区块内边距与字号指标
    function trModuleGetPrintBlockMetrics(scale = 1) {
        const isLandscape = typeof printPaperOrientation === 'string' && printPaperOrientation === 'landscape';
        const isPortrait = !isLandscape;
        const padV = isPortrait ? Math.max(1, Math.round(1.5 * scale)) : Math.max(2, Math.round(2.5 * scale));
        const padH = isPortrait ? Math.max(2, Math.round(3 * scale)) : Math.max(4, Math.round(6 * scale));
        const titleH = isPortrait ? Math.max(8, Math.round(9 * scale)) : Math.max(11, Math.round(12 * scale));
        const titleGap = 1;
        const smallFont = isPortrait ? Math.max(5, Math.round(5.8 * scale)) : Math.max(7, Math.round(8 * scale));
        const titleFont = isPortrait ? Math.max(6, Math.round(6.5 * scale)) : Math.max(8, Math.round(9 * scale));
        const tableFont = isPortrait ? Math.max(5, smallFont - 1) : Math.max(6, smallFont - 1);
        const titleBarH = Math.max(14, Math.round(16 * scale));
        const summaryH = Math.max(16, Math.round(18 * scale));
        const gap = Math.max(1, Math.round(2 * scale));
        const remainingH = Math.max(40, TR_MODULE_PRINT_REF_WRAP_H - titleBarH - summaryH - gap * 6);
        const refPitH = Math.max(32, Math.floor(remainingH * TR_MODULE_PRINT_REF_BOTTOM_RATIO / TR_MODULE_PRINT_REF_STACK_RATIO));
        const refBodyH = Math.max(10, refPitH - padV * 2 - titleH - titleGap);
        const rowH = Math.max(6, Math.floor(refBodyH / TR_MODULE_PRINT_REF_TABLE_ROWS));
        return { padV, padH, titleH, titleGap, titleFont, tableFont, rowH, refPitH };
    }

    // 计算打印区块整体布局尺寸
    function trModuleCalcPrintBlockLayout(rowCount, scale = 1, pitBoxH = null) {
        const metrics = trModuleGetPrintBlockMetrics(scale);
        const safeRows = Math.max(1, Number(rowCount) || 1);
        const { padV, padH, titleH, titleGap, titleFont, tableFont, refPitH } = metrics;
        const printRowH = TR_MODULE_PRINT_ROW_H;
        let rowH = printRowH;
        const pitH = Number(pitBoxH);
        if (Number.isFinite(pitH) && pitH > 0) {
            const bodyH = trModuleGetPitBodyHeight(pitH, scale);
            const naturalTableH = rowH * safeRows;
            if (naturalTableH > bodyH) {
                rowH = Math.max(6, Math.floor(bodyH / safeRows));
            }
            const tableH = Math.min(bodyH, rowH * safeRows);
            const compactBoxH = padV * 2 + titleH + titleGap + tableH;
            const boxH = naturalTableH > bodyH ? pitH : compactBoxH;
            return {
                padV, padH, titleH, titleGap, titleFont, tableFont, rowH,
                tableH,
                boxH,
                maxBoxH: pitH,
                inPit: true,
            };
        }
        const exactTableH = rowH * safeRows;
        const compactBoxH = padV * 2 + titleH + titleGap + exactTableH;
        const tableH = exactTableH;
        const boxH = Math.max(compactBoxH, refPitH);
        return { padV, padH, titleH, titleGap, titleFont, tableFont, rowH, tableH, boxH, maxBoxH: boxH };
    }

    // 计算预览区块显示高度
    function trModuleCalcPreviewBlockHeight(rowCount, metrics, pitBoxH = null) {
        const scale = 1;
        if (pitBoxH != null) return trModuleCalcPrintBlockLayout(rowCount, scale, pitBoxH).boxH;
        if (metrics) {
            const safeRows = Math.max(1, Number(rowCount) || 1);
            const tableH = safeRows * metrics.rowH;
            return metrics.padV * 2 + metrics.titleH + metrics.titleGap + tableH;
        }
        return trModuleCalcPrintBlockLayout(rowCount, scale, null).boxH;
    }

    // 解析模块总额行列显示标志
    function trModuleResolveTotalFlags(source) {
        const raw = source && typeof source === 'object' ? source : {};
        const hasCol = typeof raw.showTotalCol === 'boolean';
        const hasRow = typeof raw.showTotalRow === 'boolean';
        if (hasCol || hasRow) {
            const legacy = typeof raw.showTotal === 'boolean' ? raw.showTotal : true;
            return {
                showTotalCol: hasCol ? raw.showTotalCol : legacy,
                showTotalRow: hasRow ? raw.showTotalRow : legacy,
            };
        }
        const legacy = typeof raw.showTotal === 'boolean' ? raw.showTotal : true;
        return { showTotalCol: legacy, showTotalRow: legacy };
    }

    // 写回模块总额行列显示标志
    function trModuleApplyTotalFlags(payload) {
        if (!payload || typeof payload !== 'object') return payload;
        const flags = trModuleResolveTotalFlags(payload);
        payload.showTotalCol = flags.showTotalCol;
        payload.showTotalRow = flags.showTotalRow;
        payload.showTotal = flags.showTotalCol && flags.showTotalRow;
        return payload;
    }

    const TR_MODULE_MONTH_LABELS_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    let trModuleMonthInsertExpanded = false;
    let trModuleActiveVariableKey = null;
    let trModuleMonthInsertStartYear = new Date().getFullYear();
    let trModuleMonthInsertStartMonth = 0;
    let trModuleMonthInsertEndYear = new Date().getFullYear();
    let trModuleMonthInsertEndMonth = new Date().getMonth();
    let trModuleMonthInsertRow = 1;
    let trModuleMonthInsertCol = 1;

    // 生成变量单元格键名
    function trModuleVarCellKey(row, col) {
        return `${row},${col}`;
    }

    // 解析变量单元格键名为行列
    function trModuleParseVarCellKey(key) {
        const parts = String(key || '').split(',');
        return { row: Number(parts[0]) || 0, col: Number(parts[1]) || 0 };
    }

    // 计算月份范围跨月数量
    function trModuleMonthSpanCount(startYear, startMonth, endYear, endMonth) {
        let count = 0;
        let y = Number(startYear) || 0;
        let m = Math.max(0, Math.min(11, Number(startMonth) || 0));
        const ey = Number(endYear) || y;
        const em = Math.max(0, Math.min(11, Number(endMonth) || 0));
        while (count < 12000) {
            count += 1;
            if (y === ey && m === em) break;
            m += 1;
            if (m > 11) {
                m = 0;
                y += 1;
            }
        }
        return count;
    }

    // 规范化变量月份范围输入
    function trModuleNormalizeMonthRangeInput(startYear, startMonth, endYear, endMonth) {
        let sy = Number(startYear) || Number(currentYear) || new Date().getFullYear();
        let ey = Number(endYear) || sy;
        let sm = Math.max(0, Math.min(11, Number(startMonth) || 0));
        let em = Math.max(0, Math.min(11, Number(endMonth) || 0));
        if (ey < sy || (ey === sy && em < sm)) {
            ey = sy;
            em = sm;
        }
        return { startYear: sy, startMonth: sm, endYear: ey, endMonth: em };
    }

    // 确保载荷含月份变量对象
    function trModuleEnsureMonthVariables(payload) {
        if (!payload.monthVariables || typeof payload.monthVariables !== 'object' || Array.isArray(payload.monthVariables)) {
            payload.monthVariables = {};
        }
        return payload.monthVariables;
    }

    // 读取指定格的月份变量定义
    function trModuleGetMonthVariable(payload, row, col) {
        if (!payload || typeof payload !== 'object') return null;
        const vars = payload.monthVariables;
        if (!vars || typeof vars !== 'object') return null;
        return vars[trModuleVarCellKey(row, col)] || null;
    }

    // 判断单元格是否为月份变量格
    function trModuleIsVariableCell(payload, row, col, rows, cols, flags) {
        if (trModuleIsProtectedLabelCell(row, col, rows, cols, flags)) return false;
        if (trModuleIsComputedSumCell(row, col, rows, cols, flags)) return false;
        return !!trModuleGetMonthVariable(payload, row, col);
    }

    // 判断范围字段是否已有有效值
    function trModuleHasVariableRangeValue(raw) {
        return raw != null && raw !== '' && Number.isFinite(Number(raw));
    }

    // 判断变量日期范围是否完整
    function trModuleIsVariableRangeComplete(varDef) {
        if (!varDef || typeof varDef !== 'object') return false;
        if (!trModuleHasVariableRangeValue(varDef.startYear)
            || !trModuleHasVariableRangeValue(varDef.startMonth)
            || !trModuleHasVariableRangeValue(varDef.endYear)
            || !trModuleHasVariableRangeValue(varDef.endMonth)) {
            return false;
        }
        const sy = Number(varDef.startYear);
        const sm = Number(varDef.startMonth);
        const ey = Number(varDef.endYear);
        const em = Number(varDef.endMonth);
        if (sm < 0 || sm > 11 || em < 0 || em > 11) return false;
        if (ey < sy || (ey === sy && em < sm)) return false;
        return trModuleMonthSpanCount(sy, sm, ey, em) >= 1;
    }

    // 规范化单个月份变量条目
    function trModuleNormalizeMonthVariableEntry(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const name = String(entry.name || '变量').trim() || '变量';
        const sharedValue = String(entry.sharedValue ?? '');
        if (!trModuleIsVariableRangeComplete(entry)) {
            return {
                name,
                startYear: trModuleHasVariableRangeValue(entry.startYear) ? Number(entry.startYear) : null,
                startMonth: trModuleHasVariableRangeValue(entry.startMonth) ? Number(entry.startMonth) : null,
                endYear: trModuleHasVariableRangeValue(entry.endYear) ? Number(entry.endYear) : null,
                endMonth: trModuleHasVariableRangeValue(entry.endMonth) ? Number(entry.endMonth) : null,
                rangeConfirmed: false,
                sharedValue,
                values: [],
            };
        }
        const range = trModuleNormalizeMonthRangeInput(
            entry.startYear,
            entry.startMonth,
            entry.endYear,
            entry.endMonth
        );
        const span = trModuleMonthSpanCount(range.startYear, range.startMonth, range.endYear, range.endMonth);
        const values = Array.isArray(entry.values) ? entry.values.map((v) => String(v ?? '')) : [];
        while (values.length < span) values.push('');
        values.length = span;
        return Object.assign({}, range, { name, rangeConfirmed: true, sharedValue, values });
    }

    // 判断变量某月是否有独立覆盖值
    function trModuleVariableMonthHasOverride(varDef, index) {
        const raw = varDef?.values?.[index];
        return raw != null && String(raw) !== '';
    }

    // 解析变量某月展示值
    function trModuleResolveVariableMonthDisplayValue(varDef, index) {
        if (!varDef) return '';
        if (trModuleVariableMonthHasOverride(varDef, index)) {
            return String(varDef.values[index]);
        }
        return String(varDef.sharedValue ?? '');
    }

    // 解析变量某月输入框原始值
    function trModuleResolveVariableMonthInputValue(varDef, index) {
        if (!varDef || !Array.isArray(varDef.values)) return '';
        const raw = varDef.values[index];
        return raw != null ? String(raw) : '';
    }

    // 获取工作区合计计算用的年月上下文
    function trModuleGetWorkspaceSumContext() {
        return {
            year: Number(currentYear) || new Date().getFullYear(),
            month: Math.max(0, Math.min(11, Number(currentMonth) || 0)),
        };
    }

    // 解析单元格数值（含变量格）
    function trModuleParseCellNumeric(payload, row, col, context) {
        if (!payload) return 0;
        const rows = Number(payload.rows) || 0;
        const cols = Number(payload.cols) || 0;
        const flags = trModuleResolveTotalFlags(payload);
        if (trModuleIsVariableCell(payload, row, col, rows, cols, flags)) {
            const text = trModuleResolveVariableCellValue(payload, row, col, context);
            return trCustomParseNumeric(text);
        }
        return trCustomParseNumeric(payload.cells?.[row]?.[col]);
    }

    // 保存时将共享值同步到变量各月
    function trModuleApplyVariableSharedValueOnSave(varDef, sharedRaw, monthInputs) {
        if (!varDef) return;
        const shared = String(sharedRaw ?? '');
        varDef.sharedValue = shared;
        if (!Array.isArray(varDef.values)) varDef.values = [];
        monthInputs.forEach((input) => {
            const idx = Number(input.dataset.varIndex);
            if (!Number.isInteger(idx) || idx < 0) return;
            const typed = String(input.value ?? '');
            if (typed.trim() === '') {
                varDef.values[idx] = '';
            } else if (shared !== '' && typed === shared) {
                varDef.values[idx] = '';
            } else {
                varDef.values[idx] = typed;
            }
        });
    }

    // 获取变量显示名称
    function trModuleGetVariableDisplayName(varDef) {
        return String(varDef?.name || '变量').trim() || '变量';
    }

    // 移除指定月份变量并重算合计
    function trModuleRemoveMonthVariable(payload, key) {
        if (!payload || !key) return payload;
        trModuleEnsureMonthVariables(payload);
        delete payload.monthVariables[key];
        if (trModuleActiveVariableKey === key) trModuleActiveVariableKey = null;
        return trModuleSyncTotals(payload);
    }

    // 清理越界或非法的月份变量
    function trModulePruneMonthVariables(payload) {
        if (!payload) return payload;
        trModuleEnsureMonthVariables(payload);
        const rows = Number(payload.rows) || 0;
        const cols = Number(payload.cols) || 0;
        const flags = trModuleResolveTotalFlags(payload);
        Object.keys(payload.monthVariables).forEach((key) => {
            const { row, col } = trModuleParseVarCellKey(key);
            if (row < 0 || col < 0 || row >= rows || col >= cols
                || trModuleIsProtectedLabelCell(row, col, rows, cols, flags)
                || trModuleIsComputedSumCell(row, col, rows, cols, flags)) {
                delete payload.monthVariables[key];
                if (trModuleActiveVariableKey === key) trModuleActiveVariableKey = null;
            }
        });
        return payload;
    }

    // 规范化全部月份变量并修剪
    function trModuleNormalizeMonthVariablesPayload(payload) {
        if (!payload) return payload;
        trModuleEnsureMonthVariables(payload);
        const normalized = {};
        Object.keys(payload.monthVariables).forEach((key) => {
            const entry = trModuleNormalizeMonthVariableEntry(payload.monthVariables[key]);
            if (entry) normalized[key] = entry;
        });
        payload.monthVariables = normalized;
        return trModulePruneMonthVariables(payload);
    }

    // 构建变量跨度内各月元数据列表
    function trModuleBuildMonthSpanMeta(varDef) {
        if (!varDef) return [];
        const items = [];
        let y = varDef.startYear;
        let m = varDef.startMonth;
        let idx = 1;
        while (items.length < 12000) {
            items.push({
                index: idx,
                year: y,
                month: m,
                label: TR_MODULE_MONTH_LABELS_CN[m] || `${idx}月`,
                seqLabel: `${idx}月`,
            });
            if (y === varDef.endYear && m === varDef.endMonth) break;
            idx += 1;
            m += 1;
            if (m > 11) {
                m = 0;
                y += 1;
            }
        }
        return items;
    }

    // 按打印上下文解析变量单元格显示值
    function trModuleResolveVariableCellValue(payload, row, col, context) {
        const varDef = trModuleGetMonthVariable(payload, row, col);
        if (!varDef) return '';
        if (!context || context.year == null || context.month == null) return '变量';
        const meta = trModuleBuildMonthSpanMeta(varDef);
        const hit = meta.find((item) => item.year === Number(context.year) && item.month === Number(context.month));
        if (!hit) return '';
        return trModuleResolveVariableMonthDisplayValue(varDef, hit.index - 1).trim();
    }

    // 在指定格添加月份变量
    function trModuleAddMonthVariable(payload, row, col) {
        if (!payload) return null;
        const rows = Number(payload.rows) || TR_MODULE_DEFAULT_ROWS;
        const cols = Number(payload.cols) || TR_MODULE_DEFAULT_COLS;
        const flags = trModuleResolveTotalFlags(payload);
        const safe = payload;
        const existingKey = trModuleVarCellKey(row, col);
        const isReplace = !!(safe.monthVariables && safe.monthVariables[existingKey]);
        if (!isReplace && !trModuleCanWriteDraftCell(row, col, rows, cols, flags, payload)) return null;
        trModuleEnsureMonthVariables(safe);
        const key = trModuleVarCellKey(row, col);
        safe.monthVariables[key] = {
            name: '变量',
            startYear: null,
            startMonth: null,
            endYear: null,
            endMonth: null,
            rangeConfirmed: false,
            sharedValue: '',
            values: [],
        };
        if (!Array.isArray(safe.cells[row])) safe.cells[row] = [];
        safe.cells[row][col] = '';
        trModuleActiveVariableKey = key;
        return trModuleSyncTotals(safe);
    }

    // 按年份分组构建变量月份输入
    function trModuleBuildMonthSpanGroupsByYear(varDef) {
        if (!trModuleIsVariableRangeComplete(varDef)) return [];
        const meta = trModuleBuildMonthSpanMeta(varDef);
        const groups = new Map();
        meta.forEach((item) => {
            if (!groups.has(item.year)) groups.set(item.year, []);
            groups.get(item.year).push(item);
        });
        return Array.from(groups.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([year, items]) => ({ year, items }));
    }

    // 构建变量各月输入控件 HTML
    function trModuleBuildVariableMonthInputsHtml(varDef, readOnly = false) {
        if (!varDef?.rangeConfirmed || !trModuleIsVariableRangeComplete(varDef)) return '';
        const groups = trModuleBuildMonthSpanGroupsByYear(varDef);
        const lockAttr = readOnly ? ' readonly disabled' : '';
        return groups.map((group) => {
            const monthsHtml = group.items.map((item) => {
                const value = readOnly
                    ? trModuleResolveVariableMonthDisplayValue(varDef, item.index - 1)
                    : trModuleResolveVariableMonthInputValue(varDef, item.index - 1);
                const monthLabel = monthLabels[item.month] || item.seqLabel;
                return `<div class="tr-module-var-month-item"><label>${escapeHtml(monthLabel)}</label><input type="text" class="tr-custom-size-input tr-module-var-month-input" data-var-index="${item.index - 1}" value="${escapeHtml(value)}" maxlength="40"${lockAttr}></div>`;
            }).join('');
            return `<div class="tr-module-var-year-row"><div class="tr-module-var-year-label">${group.year}</div><div class="tr-module-var-year-months">${monthsHtml}</div></div>`;
        }).join('');
    }

    // 构建变量编辑侧栏 HTML
    function trModuleBuildVariableEditorHtml() {
        if (!trModuleActiveVariableKey || !trModuleDraft || !trModuleIsToolbarExpanded()) return '';
        const editable = trModuleIsWorkspaceEditable();
        const { row, col } = trModuleParseVarCellKey(trModuleActiveVariableKey);
        const varDef = trModuleGetMonthVariable(trModuleDraft, row, col);
        if (!varDef) return '';
        const varName = trModuleGetVariableDisplayName(varDef);
        const sharedValue = String(varDef.sharedValue ?? '');
        const bodyHtml = trModuleBuildVariableMonthInputsHtml(varDef, !editable);
        const lockAttr = editable ? '' : ' readonly disabled';
        const actionsHtml = editable
            ? `<button type="button" class="tr-custom-action-btn" id="trModuleVarCancelBtn">取消</button>
                            <button type="button" class="tr-custom-action-btn primary" id="trModuleVarPanelSaveBtn">保存</button>`
            : `<button type="button" class="tr-custom-action-btn" id="trModuleVarCloseBtn">关闭</button>`;
        return `<div class="tr-module-var-editor${editable ? '' : ' is-readonly'}" id="trModuleVarEditor">
                    <div class="tr-module-var-editor-head">
                        <div class="tr-module-var-editor-identity">
                            <span class="tr-module-var-editor-tag">variable</span>
                            <input type="text" class="tr-custom-size-input tr-module-var-name-input" id="trModuleVarNameInput" value="${escapeHtml(varName)}" maxlength="20" placeholder="变量"${lockAttr}>
                        </div>
                        <div class="tr-module-var-editor-range">
                            <span class="tr-module-var-editor-field-label">选择范围</span>
                            <select class="tr-module-month-range-select" id="trModuleVarPanelStartYear" title="起始年份"${lockAttr}>${trModuleBuildYearSelectOptions(varDef.startYear, true)}</select>
                            <select class="tr-module-month-range-select" id="trModuleVarPanelStartMonth" title="起始月份"${lockAttr}>${trModuleBuildMonthSelectOptions(varDef.startMonth, true)}</select>
                            <span class="tr-module-month-range-sep">-</span>
                            <select class="tr-module-month-range-select" id="trModuleVarPanelEndYear" title="结束年份"${lockAttr}>${trModuleBuildYearSelectOptions(varDef.endYear, true)}</select>
                            <select class="tr-module-month-range-select" id="trModuleVarPanelEndMonth" title="结束月份"${lockAttr}>${trModuleBuildMonthSelectOptions(varDef.endMonth, true)}</select>
                        </div>
                        <div class="tr-module-var-editor-shared">
                            <span class="tr-module-var-editor-field-label">共享值</span>
                            <input type="text" class="tr-custom-size-input tr-module-var-shared-input" id="trModuleVarSharedInput" value="${escapeHtml(sharedValue)}" maxlength="40" placeholder=""${lockAttr}>
                        </div>
                        <div class="tr-module-var-editor-actions">
                            ${actionsHtml}
                        </div>
                    </div>
                    ${bodyHtml ? `<div class="tr-module-var-editor-body">${bodyHtml}</div>` : ''}
                </div>`;
    }

    // 获取变量面板可选年份列表
    function trModuleGetSelectableYears() {
        const years = (Array.isArray(ledgerYears) ? ledgerYears : []).concat(Number(currentYear) || new Date().getFullYear());
        return Array.from(new Set(years))
            .filter((y) => Number.isInteger(y) && y >= 2000 && y <= 2100)
            .sort((a, b) => b - a);
    }

    // 构建变量年份下拉选项 HTML
    function trModuleBuildYearSelectOptions(selectedYear, allowEmpty = false) {
        const years = trModuleGetSelectableYears();
        const hasValue = trModuleHasVariableRangeValue(selectedYear);
        const safeYear = hasValue ? Number(selectedYear) : null;
        const emptyOpt = allowEmpty && !hasValue
            ? '<option value="" selected disabled>--</option>'
            : '';
        const yearOpts = years.map((year) => (
            `<option value="${year}"${hasValue && Number(year) === safeYear ? ' selected' : ''}>${year}</option>`
        )).join('');
        return `${emptyOpt}${yearOpts}`;
    }

    // 构建变量月份下拉选项 HTML
    function trModuleBuildMonthSelectOptions(selectedMonth, allowEmpty = false) {
        const hasValue = trModuleHasVariableRangeValue(selectedMonth);
        const safeMonth = hasValue ? Math.max(0, Math.min(11, Number(selectedMonth))) : null;
        const emptyOpt = allowEmpty && !hasValue
            ? '<option value="" selected disabled>--</option>'
            : '';
        const monthOpts = monthLabels.map((label, index) => (
            `<option value="${index}"${hasValue && index === safeMonth ? ' selected' : ''}>${label}</option>`
        )).join('');
        return `${emptyOpt}${monthOpts}`;
    }

    // 重置变量插入工具栏 UI 状态
    function trModuleResetMonthInsertUiState() {
        trModuleMonthInsertExpanded = false;
        trModuleActiveVariableKey = null;
        trModuleMonthInsertStartYear = Number(currentYear) || new Date().getFullYear();
        trModuleMonthInsertStartMonth = 0;
        trModuleMonthInsertEndYear = Number(currentYear) || new Date().getFullYear();
        trModuleMonthInsertEndMonth = Math.max(0, Math.min(11, Number(currentMonth) || 0));
        trModuleMonthInsertRow = 1;
        trModuleMonthInsertCol = 1;
    }

    // 写入模块草稿单元格
    function trModuleWriteDraftCell(row, col, value) {
        if (!trModuleDraft) return;
        const rows = Number(trModuleDraft.rows) || TR_MODULE_DEFAULT_ROWS;
        const cols = Number(trModuleDraft.cols) || TR_MODULE_DEFAULT_COLS;
        const flags = trModuleResolveTotalFlags(trModuleDraft);
        if (!trModuleCanWriteDraftCell(row, col, rows, cols, flags)) return;
        if (!Array.isArray(trModuleDraft.cells)) trModuleDraft.cells = [];
        if (!Array.isArray(trModuleDraft.cells[row])) trModuleDraft.cells[row] = [];
        trModuleDraft.cells[row][col] = value;
        if (flags.showTotalCol || flags.showTotalRow) trModuleApplyComputedSums(trModuleDraft);
    }

    // 读取模块草稿单元格文本
    function trModuleReadDraftCell(row, col) {
        if (!trModuleDraft) return '';
        const safe = trModuleNormalizePayload(trModuleDraft);
        return String((safe.cells[row] && safe.cells[row][col]) ?? '');
    }

    // 获取合计行索引
    function trModuleGetTotalRowIndex(rows) {
        return Math.max(0, Math.trunc(rows) - 1);
    }

    // 获取总额列索引
    function trModuleGetTotalColIndex(cols, showTotalCol) {
        return showTotalCol ? Math.max(0, Math.trunc(cols) - 1) : -1;
    }

    // 判断网格是否含总额列
    function trModuleHasTotalCol(cells, cols) {
        const lastCol = Math.max(0, Math.trunc(cols) - 1);
        return cols > 0 && String(cells?.[0]?.[lastCol] || '').trim() === '总额';
    }

    // 判断网格是否含合计行
    function trModuleHasTotalRow(cells, rows) {
        const lastRow = Math.max(0, Math.trunc(rows) - 1);
        return rows > 0 && String(cells?.[lastRow]?.[0] || '').trim() === 'Total';
    }

    // 判断是否为自动合计格
    function trModuleIsComputedSumCell(row, col, rows, cols, flags) {
        const { showTotalCol, showTotalRow } = trModuleResolveTotalFlags(flags);
        if (rows < 2 || cols < 2) return false;
        if (!showTotalCol && !showTotalRow) return false;
        const totalRow = showTotalRow ? trModuleGetTotalRowIndex(rows) : -1;
        const totalCol = showTotalCol ? trModuleGetTotalColIndex(cols, true) : -1;
        if (showTotalCol && showTotalRow && row === totalRow && col === totalCol) return true;
        if (showTotalCol && col === totalCol && row > 0) {
            return showTotalRow ? row < totalRow : row < rows;
        }
        if (showTotalRow && row === totalRow && col > 0) {
            return showTotalCol ? col < totalCol : col < cols;
        }
        return false;
    }

    // 判断是否为受保护标签格
    function trModuleIsProtectedLabelCell(row, col, rows, cols, flags) {
        const { showTotalCol, showTotalRow } = trModuleResolveTotalFlags(flags);
        if (showTotalCol && row === 0 && col === trModuleGetTotalColIndex(cols, true)) return true;
        if (showTotalRow && row === trModuleGetTotalRowIndex(rows) && col === 0) return true;
        return false;
    }

    // 判断模块单元格是否允许写入
    function trModuleCanWriteDraftCell(row, col, rows, cols, flags, payload) {
        if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
        if (row < 0 || col < 0 || row >= rows || col >= cols) return false;
        if (trModuleIsProtectedLabelCell(row, col, rows, cols, flags)) return false;
        if (trModuleIsComputedSumCell(row, col, rows, cols, flags)) return false;
        const source = payload || trModuleDraft;
        if (source && trModuleIsVariableCell(source, row, col, rows, cols, flags)) return false;
        return true;
    }

    // 同步模块总额行列结构
    function trModuleSyncTotalStructure(payload) {
        if (!payload || !Array.isArray(payload.cells)) return payload;
        let rows = Math.max(1, Number(payload.rows) || TR_MODULE_DEFAULT_ROWS);
        let cols = Math.max(1, Number(payload.cols) || TR_MODULE_DEFAULT_COLS);
        const cells = payload.cells;
        const { showTotalCol, showTotalRow } = trModuleResolveTotalFlags(payload);

        const ensureRect = () => {
            for (let r = 0; r < rows; r += 1) {
                if (!Array.isArray(cells[r])) cells[r] = [];
                while (cells[r].length < cols) cells[r].push('');
                cells[r].length = cols;
            }
            while (cells.length < rows) {
                cells.push(Array.from({ length: cols }, () => ''));
            }
            cells.length = rows;
        };

        ensureRect();
        if (showTotalCol) {
            if (!trModuleHasTotalCol(cells, cols)) {
                for (let r = 0; r < rows; r += 1) {
                    cells[r].push(r === 0 ? '总额' : '');
                }
                cols += 1;
            }
            ensureRect();
            cells[0][cols - 1] = '总额';
        } else if (trModuleHasTotalCol(cells, cols)) {
            for (let r = 0; r < rows; r += 1) {
                if (cells[r]) cells[r].pop();
            }
            cols -= 1;
            ensureRect();
        }

        ensureRect();
        if (showTotalRow) {
            if (!trModuleHasTotalRow(cells, rows)) {
                cells.push(Array.from({ length: cols }, (_, c) => (c === 0 ? 'Total' : '')));
                rows += 1;
            }
            ensureRect();
            cells[rows - 1][0] = 'Total';
        } else if (trModuleHasTotalRow(cells, rows)) {
            cells.pop();
            rows -= 1;
            ensureRect();
        }

        payload.rows = rows;
        payload.cols = cols;
        payload.cells = cells;
        return trModuleApplyTotalFlags(payload);
    }

    // 计算并写回模块合计格
    function trModuleApplyComputedSums(payload, sumContext = null) {
        if (!payload || !Array.isArray(payload.cells)) return payload;
        const { showTotalCol, showTotalRow } = trModuleResolveTotalFlags(payload);
        if (!showTotalCol && !showTotalRow) return payload;
        const rows = Math.max(2, Number(payload.rows) || 0);
        const cols = Math.max(2, Number(payload.cols) || 0);
        const cells = payload.cells;
        const totalRow = showTotalRow ? trModuleGetTotalRowIndex(rows) : -1;
        const totalCol = showTotalCol ? trModuleGetTotalColIndex(cols, true) : -1;
        const dataRowEnd = showTotalRow ? totalRow : rows;
        const dataColEnd = showTotalCol ? totalCol : cols;
        const ctx = (sumContext && sumContext.year != null && sumContext.month != null)
            ? sumContext
            : trModuleGetWorkspaceSumContext();

        if (showTotalRow && totalRow >= 1) {
            for (let c = 1; c < dataColEnd; c += 1) {
                let colSum = 0;
                for (let r = 1; r < dataRowEnd; r += 1) {
                    colSum += trModuleParseCellNumeric(payload, r, c, ctx);
                }
                if (!Array.isArray(cells[totalRow])) cells[totalRow] = [];
                cells[totalRow][c] = trFmt(formatCategoryDisplay(colSum));
            }
        }

        if (showTotalCol && totalCol >= 1) {
            for (let r = 1; r < dataRowEnd; r += 1) {
                let rowSum = 0;
                for (let c = 1; c < dataColEnd; c += 1) {
                    rowSum += trModuleParseCellNumeric(payload, r, c, ctx);
                }
                if (!Array.isArray(cells[r])) cells[r] = [];
                cells[r][totalCol] = trFmt(formatCategoryDisplay(rowSum));
            }
        }

        if (showTotalCol && showTotalRow && totalRow >= 1 && totalCol >= 1) {
            let grand = 0;
            for (let r = 1; r < totalRow; r += 1) {
                for (let c = 1; c < totalCol; c += 1) {
                    grand += trModuleParseCellNumeric(payload, r, c, ctx);
                }
            }
            if (!Array.isArray(cells[totalRow])) cells[totalRow] = [];
            cells[totalRow][totalCol] = trFmt(formatCategoryDisplay(grand));
        }
        return payload;
    }

    // 同步结构、变量并刷新合计
    function trModuleSyncTotals(payload) {
        if (!payload) return payload;
        trModuleSyncTotalStructure(payload);
        trModuleNormalizeMonthVariablesPayload(payload);
        const flags = trModuleResolveTotalFlags(payload);
        if (flags.showTotalCol || flags.showTotalRow) {
            trModuleApplyComputedSums(payload);
        }
        return payload;
    }

    // 获取模块右下角总合计数值
    function trModuleGetGrandTotal(payload) {
        const safe = trModuleNormalizePayload(payload);
        const { showTotalCol, showTotalRow } = trModuleResolveTotalFlags(safe);
        if (!showTotalCol && !showTotalRow) return 0;
        const totalRow = showTotalRow ? trModuleGetTotalRowIndex(safe.rows) : -1;
        const totalCol = showTotalCol ? trModuleGetTotalColIndex(safe.cols, true) : -1;
        if (showTotalCol && showTotalRow) {
            let grand = trCustomParseNumeric(safe.cells?.[totalRow]?.[totalCol]);
            if (!grand) {
                for (let r = 1; r < totalRow; r += 1) {
                    for (let c = 1; c < totalCol; c += 1) {
                        grand += trCustomParseNumeric(safe.cells[r]?.[c]);
                    }
                }
            }
            return grand;
        }
        const dataRowEnd = showTotalRow ? totalRow : safe.rows;
        const dataColEnd = showTotalCol ? totalCol : safe.cols;
        let grand = 0;
        for (let r = 1; r < dataRowEnd; r += 1) {
            for (let c = 1; c < dataColEnd; c += 1) {
                grand += trCustomParseNumeric(safe.cells[r]?.[c]);
            }
        }
        return grand;
    }

    // 将模块合计同步到预览 DOM
    function trModuleSyncSumCellsDom() {
        const flags = trModuleDraft ? trModuleResolveTotalFlags(trModuleDraft) : null;
        if (!trModuleDraft || !flags || (!flags.showTotalCol && !flags.showTotalRow)) return;
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        const safe = trModuleNormalizePayload(trModuleDraft);
        content.querySelectorAll('.tr-module-preview-grid .tr-module-sum-cell').forEach((cell) => {
            const row = Number(cell.dataset.row);
            const col = Number(cell.dataset.col);
            if (!Number.isInteger(row) || !Number.isInteger(col)) return;
            const raw = String((safe.cells[row] && safe.cells[row][col]) ?? '').trim();
            cell.innerHTML = raw ? escapeHtml(raw) : '&nbsp;';
        });
    }

    // 聚焦模块预览可编辑单元格
    function trModuleFocusEditable(row, col) {
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        const cell = content.querySelector(`.tr-module-preview-grid .tr-custom-editable[data-row="${row}"][data-col="${col}"]`);
        if (!cell) return;
        cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    // 设置模块单元格打印字号样式
    function trModuleEnsureCellFont(el) {
        if (!el) return;
        const table = el.closest('.tr-module-preview-grid');
        const rowHVar = table ? getComputedStyle(table).getPropertyValue('--tr-module-row-h').trim() : '';
        const cellFontVar = table ? getComputedStyle(table).getPropertyValue('--tr-module-cell-font').trim() : '';
        const safeRowH = rowHVar ? Number.parseFloat(rowHVar) : TR_MODULE_PRINT_ROW_H;
        const safeFont = cellFontVar ? Number.parseFloat(cellFontVar) : safeRowH;
        el.style.fontSize = `${safeFont}px`;
        el.style.lineHeight = `${safeRowH}px`;
        el.style.fontWeight = '400';
        el.style.whiteSpace = 'nowrap';
        el.style.overflow = 'hidden';
        el.style.textOverflow = 'clip';
    }

    // 判断模块工作区是否可编辑
    function trModuleIsWorkspaceEditable() {
        return !!trModuleWorkspaceEditMode;
    }

    // 判断模块工具栏是否展开
    function trModuleIsToolbarExpanded() {
        return !!trModuleToolbarExpanded;
    }

    // 判断是否为模块工作区预览态
    function trModuleIsModuleWorkspacePreview() {
        return trCustomContentKind === 'module' && !!trModuleDraft && trModulePreviewReady;
    }

    // 绑定变量单元格按钮事件
    function trModuleBindVariableCells() {
        const content = document.getElementById('totalReportContent');
        if (!content || !trModuleDraft || !trModuleIsModuleWorkspacePreview()) return;
        content.querySelectorAll('.tr-module-var-cell-btn').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                const row = Number(btn.dataset.row);
                const col = Number(btn.dataset.col);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                if (!trModuleToolbarExpanded) {
                    trModuleToolbarExpanded = true;
                    trModuleWorkspaceEditMode = false;
                }
                trModuleActiveVariableKey = trModuleVarCellKey(row, col);
                trModuleLastPreviewScaleKey = '';
                trQueueRenderDOM();
            });
        });
    }

    // 绑定变量编辑侧栏事件
    function trModuleBindVariableEditor() {
        const editor = document.getElementById('trModuleVarEditor');
        if (!editor || !trModuleActiveVariableKey || !trModuleDraft) return;
        if (!trModuleIsWorkspaceEditable()) {
            const closeBtn = document.getElementById('trModuleVarCloseBtn');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    trModuleActiveVariableKey = null;
                    trModuleToolbarExpanded = false;
                    trModuleLastPreviewScaleKey = '';
                    trQueueRenderDOM();
                });
            }
            return;
        }
        const { row, col } = trModuleParseVarCellKey(trModuleActiveVariableKey);
        const varDef = trModuleGetMonthVariable(trModuleDraft, row, col);
        if (!varDef) return;
        const nameInput = document.getElementById('trModuleVarNameInput');
        const startYearSel = document.getElementById('trModuleVarPanelStartYear');
        const startMonthSel = document.getElementById('trModuleVarPanelStartMonth');
        const endYearSel = document.getElementById('trModuleVarPanelEndYear');
        const endMonthSel = document.getElementById('trModuleVarPanelEndMonth');
        const sharedInput = document.getElementById('trModuleVarSharedInput');
        const cancelBtn = document.getElementById('trModuleVarCancelBtn');
        const saveBtn = document.getElementById('trModuleVarPanelSaveBtn');
        const monthInputs = () => Array.from(editor.querySelectorAll('.tr-module-var-month-input'));
        const syncRangeFromDom = () => {
            trModuleApplyVariablePanelRange(varDef, {
                startYear: startYearSel ? startYearSel.value : '',
                startMonth: startMonthSel ? startMonthSel.value : '',
                endYear: endYearSel ? endYearSel.value : '',
                endMonth: endMonthSel ? endMonthSel.value : '',
            });
        };
        const syncPanelFromDom = () => {
            trModuleSyncVariableEditorDomToDraft(varDef);
        };
        const onRangeChange = () => {
            syncRangeFromDom();
            trQueueRenderDOM();
        };
        if (nameInput) {
            nameInput.addEventListener('input', () => {
                varDef.name = String(nameInput.value || '变量').trim() || '变量';
                trModuleEmitUpdate();
            });
        }
        [startYearSel, startMonthSel, endYearSel, endMonthSel].forEach((el) => {
            if (el) el.addEventListener('change', onRangeChange);
        });
        monthInputs().forEach((input) => {
            input.addEventListener('input', () => {
                const idx = Number(input.dataset.varIndex);
                if (!Number.isInteger(idx) || idx < 0) return;
                if (!Array.isArray(varDef.values)) varDef.values = [];
                varDef.values[idx] = String(input.value ?? '');
                trModuleEmitUpdate();
            });
        });
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                trModuleDraft = trModuleRemoveMonthVariable(trModuleDraft, trModuleActiveVariableKey);
                trModuleEmitUpdate();
                trQueueRenderDOM();
            });
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                syncPanelFromDom();
                if (!trModuleIsVariableRangeComplete(varDef)) {
                    trCustomSetError('请先选择完整的日期范围');
                    return;
                }
                const savedVarName = trModuleGetVariableDisplayName(varDef);
                trModuleDraft = trModuleSyncTotals(trModuleDraft);
                trModuleActiveVariableKey = null;
                trModuleLastPreviewScaleKey = '';
                trCustomClearStatus();
                trScheduleWorkspaceSaveToast(`"${savedVarName}" 保存成功`, 2000);
                trModuleEmitUpdate();
                trQueueRenderDOM();
            });
        }
    }

    // 绑定变量工具栏事件
    function trModuleBindVarToolbar() {
        if (!trModuleIsWorkspaceEditable()) return;
        const toggleBtn = document.getElementById('trModuleVarToggleBtn');
        const rowInput = document.getElementById('trModuleVarRowInput');
        const colInput = document.getElementById('trModuleVarColInput');
        const addBtn = document.getElementById('trModuleVarAddBtn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                trModuleMonthInsertExpanded = !trModuleMonthInsertExpanded;
                trQueueRenderDOM();
            });
        }
        if (rowInput) rowInput.addEventListener('input', () => {
            trModuleMonthInsertRow = Math.max(1, Number(rowInput.value) || 1);
        });
        if (colInput) colInput.addEventListener('input', () => {
            trModuleMonthInsertCol = Math.max(1, Number(colInput.value) || 1);
        });
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                if (!trModuleDraft) return;
                if (rowInput) trModuleMonthInsertRow = Math.max(1, Number(rowInput.value) || 1);
                if (colInput) trModuleMonthInsertCol = Math.max(1, Number(colInput.value) || 1);
                const maxRows = Math.max(1, Number(trModuleDraft.rows) || TR_MODULE_DEFAULT_ROWS);
                const maxCols = Math.max(1, Number(trModuleDraft.cols) || TR_MODULE_DEFAULT_COLS);
                const row = Math.max(0, Math.min(maxRows - 1, trModuleMonthInsertRow - 1));
                const col = Math.max(0, Math.min(maxCols - 1, trModuleMonthInsertCol - 1));
                const updated = trModuleAddMonthVariable(trModuleDraft, row, col);
                if (!updated) {
                    trCustomSetError('无法在该位置添加变量，请选择有效行列（非总额/Total/合计格）');
                    trQueueRenderDOM();
                    return;
                }
                trModuleDraft = updated;
                trCustomClearStatus();
                trModuleEmitUpdate();
                trModuleLastPreviewScaleKey = '';
                trQueueRenderDOM();
            });
        }
    }

    // 解析变量面板范围选择值
    function trModuleParsePanelRangeValue(raw) {
        if (raw === '' || raw == null) return null;
        const num = Number(raw);
        return Number.isFinite(num) ? num : null;
    }

    // 将面板范围写入变量定义
    function trModuleApplyVariablePanelRange(varDef, range) {
        if (!varDef || !range) return;
        varDef.startYear = trModuleParsePanelRangeValue(range.startYear);
        varDef.startMonth = trModuleParsePanelRangeValue(range.startMonth);
        varDef.endYear = trModuleParsePanelRangeValue(range.endYear);
        varDef.endMonth = trModuleParsePanelRangeValue(range.endMonth);
        if (!trModuleIsVariableRangeComplete(varDef)) {
            varDef.rangeConfirmed = false;
            varDef.values = [];
            return;
        }
        const normalized = trModuleNormalizeMonthRangeInput(
            varDef.startYear,
            varDef.startMonth,
            varDef.endYear,
            varDef.endMonth
        );
        const oldValues = Array.isArray(varDef.values) ? varDef.values.slice() : [];
        const span = trModuleMonthSpanCount(
            normalized.startYear,
            normalized.startMonth,
            normalized.endYear,
            normalized.endMonth
        );
        Object.assign(varDef, normalized, {
            rangeConfirmed: true,
            values: Array.from({ length: span }, (_, index) => String(oldValues[index] ?? '')),
        });
    }

    // 绑定模块预览可编辑单元格事件
    function trModuleBindEditableCells() {
        const content = document.getElementById('totalReportContent');
        if (!content || !trModuleDraft || !trModuleIsWorkspaceEditable()) return;
        const rowCount = trCustomClamp(trModuleDraft.rows, TR_MODULE_MIN_ROWS, TR_MODULE_MAX_ROWS, TR_MODULE_DEFAULT_ROWS);
        const colCount = trCustomClamp(trModuleDraft.cols, TR_MODULE_MIN_COLS, TR_MODULE_MAX_COLS, TR_MODULE_DEFAULT_COLS);
        content.querySelectorAll('.tr-module-preview-grid .tr-custom-editable').forEach((cell) => {
            cell.addEventListener('click', function () {
                if (!trModuleIsWorkspaceEditable()) return;
                if (this.classList.contains('editing')) return;
                trModuleEnsureCellFont(this);
                this.contentEditable = 'true';
                this.classList.add('editing');
                this.focus();
                const range = document.createRange();
                range.selectNodeContents(this);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
            cell.addEventListener('input', function () {
                const row = Number(this.dataset.row);
                const col = Number(this.dataset.col);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                trModuleWriteDraftCell(row, col, (this.textContent || '').replace(/\u00a0/g, ''));
                trModuleSyncSumCellsDom();
                trModuleEmitUpdate();
            });
            cell.addEventListener('blur', function () {
                const el = this;
                el.contentEditable = 'false';
                el.classList.remove('editing');
                const row = Number(el.dataset.row);
                const col = Number(el.dataset.col);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                trModuleWriteDraftCell(row, col, (el.textContent || '').replace(/\u00a0/g, ''));
                trModuleSyncSumCellsDom();
                trModuleEmitUpdate();
                trModuleEnsureCellFont(el);
            });
            cell.addEventListener('keydown', function (e) {
                const row = Number(this.dataset.row);
                const col = Number(this.dataset.col);
                if (!Number.isInteger(row) || !Number.isInteger(col)) return;
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.blur();
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    this.blur();
                    const delta = e.shiftKey ? -1 : 1;
                    const total = rowCount * colCount;
                    let index = row * colCount + col + delta;
                    if (index < 0) index = 0;
                    if (index >= total) index = total - 1;
                    trModuleFocusEditable(Math.floor(index / colCount), index % colCount);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.textContent = trModuleReadDraftCell(row, col) || '';
                    this.blur();
                }
            });
        });
    }

    // 渲染模块打印/预览区块 HTML
    function trModuleRenderPrintBlockHtml(payload, widthPx, scale = 1, pitBoxH = null, options = {}) {
        const opts = options || {};
        const editable = !!opts.editable;
        const showVarButtons = !!opts.showVarButtons;
        const safe = trModuleClonePayload(trModuleNormalizePayload(payload));
        const sumContext = (opts.context && opts.context.year != null && opts.context.month != null)
            ? opts.context
            : trModuleGetWorkspaceSumContext();
        const sumFlags = trModuleResolveTotalFlags(safe);
        if (sumFlags.showTotalCol || sumFlags.showTotalRow) {
            trModuleApplyComputedSums(safe, sumContext);
        }
        const rowCount = trCustomClamp(safe.rows, TR_MODULE_MIN_ROWS, TR_MODULE_MAX_ROWS, TR_MODULE_DEFAULT_ROWS);
        const colCount = trCustomClamp(safe.cols, TR_MODULE_MIN_COLS, TR_MODULE_MAX_COLS, TR_MODULE_DEFAULT_COLS);
        const layout = trModuleCalcPrintBlockLayout(rowCount, scale, pitBoxH);
        const { padV, padH, titleH, titleGap, titleFont, tableFont, rowH, tableH, boxH, maxBoxH, inPit } = layout;
        const pitMaxH = Number(maxBoxH) > 0 ? maxBoxH : boxH;
        const tableW = Math.max(40, widthPx - padH * 2);
        const totalFlags = trModuleResolveTotalFlags(safe);
        const colWidths = trModuleGetMoneyBoxColWidths(widthPx, colCount, scale, totalFlags.showTotalCol);
        const colgroupHtml = colWidths.map((width) => `<col style="width:${width}px;">`).join('');
        const moneyTableClass = 'preview-money-table tr-module-preview-grid';
        let tbodyHtml = '';
        const tdStyle = `height:${rowH}px;padding:0;vertical-align:middle;line-height:${rowH}px;font-size:${tableFont}px;font-weight:400;`;
        const cellFontStyle = `font-size:${tableFont}px;line-height:${rowH}px;font-weight:400;`;
        for (let r = 0; r < rowCount; r += 1) {
            tbodyHtml += `<tr style="height:${rowH}px;">`;
            for (let c = 0; c < colCount; c += 1) {
                const rawCell = String((safe.cells[r] && safe.cells[r][c]) ?? '');
                const isSumCell = trModuleIsComputedSumCell(r, c, rowCount, colCount, totalFlags);
                const isLabelCell = trModuleIsProtectedLabelCell(r, c, rowCount, colCount, totalFlags);
                const isVarCell = trModuleIsVariableCell(safe, r, c, rowCount, colCount, totalFlags);
                if (isSumCell) {
                    const sumText = rawCell.trim() ? escapeHtml(rawCell.trim()) : '&nbsp;';
                    tbodyHtml += `<td style="${tdStyle}"><span class="tr-module-sum-cell" style="${cellFontStyle}" data-row="${r}" data-col="${c}">${sumText}</span></td>`;
                } else if (isLabelCell) {
                    tbodyHtml += `<td style="${tdStyle}"><span class="tr-module-label-cell" style="${cellFontStyle}">${escapeHtml(rawCell)}</span></td>`;
                } else if (isVarCell) {
                    const varKey = trModuleVarCellKey(r, c);
                    const varDef = trModuleGetMonthVariable(safe, r, c);
                    const varLabel = trModuleGetVariableDisplayName(varDef);
                    const varActive = editable && trModuleActiveVariableKey === varKey ? ' active' : '';
                    if (showVarButtons) {
                        tbodyHtml += `<td class="tr-module-var-cell-td" style="${tdStyle}"><span class="tr-module-var-cell-slot"><button type="button" class="tr-module-var-cell-btn${varActive}" data-row="${r}" data-col="${c}" title="${escapeHtml(varLabel)}">${escapeHtml(varLabel)}</button></span></td>`;
                    } else {
                        const hasPrintContext = opts.context
                            && opts.context.year != null
                            && opts.context.month != null;
                        if (hasPrintContext) {
                            const varText = trModuleResolveVariableCellValue(safe, r, c, opts.context);
                            const display = varText.trim() ? escapeHtml(varText.trim()) : '&nbsp;';
                            tbodyHtml += `<td style="${tdStyle}"><span class="tr-module-var-cell-display" style="${cellFontStyle}">${display}</span></td>`;
                        } else {
                            const varText = trModuleResolveVariableCellValue(safe, r, c, opts.context) || varLabel;
                            const display = varText.trim() ? escapeHtml(varText.trim()) : escapeHtml(varLabel);
                            tbodyHtml += `<td style="${tdStyle}"><span class="tr-module-var-cell-display" style="${cellFontStyle}">${display}</span></td>`;
                        }
                    }
                } else if (editable) {
                    tbodyHtml += `<td style="${tdStyle}"><span class="tr-custom-editable" style="${cellFontStyle}" data-row="${r}" data-col="${c}" tabindex="0">${escapeHtml(rawCell)}</span></td>`;
                } else {
                    const cellText = rawCell.trim() ? escapeHtml(rawCell.trim()) : '&nbsp;';
                    tbodyHtml += `<td style="${tdStyle}"><span class="tr-module-data-cell" style="${cellFontStyle}">${cellText}</span></td>`;
                }
            }
            tbodyHtml += '</tr>';
        }
        const title = escapeHtml(String(safe.title || '').trim() || '模块 1');
        const useCompactPitHeight = inPit && boxH < pitMaxH;
        const blockStyle = [
            `width:${widthPx}px`,
            useCompactPitHeight ? 'height:auto' : `height:${boxH}px`,
            `min-width:${widthPx}px`,
            useCompactPitHeight ? 'min-height:0' : `min-height:${boxH}px`,
            `max-height:${pitMaxH}px`,
            `max-width:${widthPx}px`,
            `padding:${padV}px ${padH}px`,
            'box-sizing:border-box',
            inPit ? 'overflow:hidden;justify-content:flex-start' : '',
        ].filter(Boolean).join(';');
        const finalTableH = tableH;
        const tableStyle = [
            `height:${finalTableH}px`,
            `min-height:${finalTableH}px`,
            `max-height:${finalTableH}px`,
            `width:${tableW}px`,
            `min-width:${tableW}px`,
            `max-width:${tableW}px`,
            `font-size:${tableFont}px`,
            `font-weight:400`,
            `--tr-module-row-h:${rowH}px`,
            `--tr-module-cell-font:${tableFont}px`,
        ].join(';');
        const pitClass = inPit
            ? (editable ? ' tr-module-create-pit-preview' : ' tr-module-pit-block')
            : '';
        return `<div class="preview-block tr-module-preview-block${pitClass}" style="${blockStyle}"><div class="preview-block-title" style="font-size:${titleFont}px;line-height:${titleH}px;height:${titleH}px;flex-shrink:0;margin-bottom:${titleGap}px;">${title}</div><table class="${moneyTableClass}" data-table-font="${tableFont}" style="${tableStyle}"><colgroup>${colgroupHtml}</colgroup><tbody>${tbodyHtml}</tbody></table></div>`;
    }

    // 获取创建预览内容区高度
    function trModuleGetCreatePreviewContentHeight() {
        if (!trModulePreviewReady || !trModuleDraft) return TR_MODULE_CREATE_PREVIEW_EMPTY_H;
        const safe = trModuleNormalizePayload(trModuleDraft);
        const spec = trModuleGetPrintInsertSpec();
        const pitH = Number(spec.createPitBoxH) > 0 ? spec.createPitBoxH : spec.pitBoxH;
        return trModuleCalcPrintBlockLayout(safe.rows, spec.layoutScale, pitH).boxH;
    }

    // 计算创建预览缩放比例
    function trModuleGetCreatePreviewScale(guideWidthPx) {
        const wrap = document.getElementById('trCustomTableWrap');
        const availableW = Math.max(280, (wrap && wrap.clientWidth > 0 ? wrap.clientWidth : 720) - 28);
        const safeGuideW = Math.max(1, Number(guideWidthPx) || TR_MODULE_PRINT_WIDTH_PORTRAIT + TR_MODULE_A4_EDGE_INSET * 2);
        const scaleByW = (availableW / safeGuideW) * 0.94;
        return Math.min(TR_MODULE_CREATE_PREVIEW_SCALE_MAX, Math.max(1, scaleByW));
    }

    // 获取变量侧栏宽度像素值
    function trModuleGetVarPanelWidthPx() {
        const spec = trModuleGetPrintInsertSpec();
        const previewScale = trModuleGetCreatePreviewScale(spec.guideWidthPx);
        return Math.ceil(spec.widthPx * previewScale);
    }
    let trModuleTemplates = [];
    let trModuleLoaded = false;
    let trModuleLoadingPromise = null;
    let trModuleCurrentId = null;
    let trModuleDraft = null;
    let trModuleToolbarExpanded = false;
    let trModuleWorkspaceEditMode = false;
    let trModulePendingDraft = false;
    let trModuleBeforeCreateId = null;
    let trModuleSavedSnapshot = null;
    let trModuleNewTitle = '模块 1';
    let trModuleNewRows = TR_MODULE_DEFAULT_ROWS;
    let trModuleNewCols = TR_MODULE_DEFAULT_COLS;
    let trModuleNewShowTotalCol = true;
    let trModuleNewShowTotalRow = true;
    let trModulePreviewReady = false;

    // 返回模块默认单元格初始值
    function trModuleDefaultCellValue(rowIndex, colIndex, rows, cols, flags) {
        const { showTotalCol, showTotalRow } = trModuleResolveTotalFlags(flags);
        if (showTotalRow && rowIndex === trModuleGetTotalRowIndex(rows) && colIndex === 0) return 'Total';
        if (showTotalCol && rowIndex === 0 && colIndex === trModuleGetTotalColIndex(cols, true)) return '总额';
        return '';
    }

    // 创建默认模块数据载荷
    function trModuleCreateDefaultPayload(
        title = trModuleNewTitle,
        rows = TR_MODULE_DEFAULT_ROWS,
        cols = TR_MODULE_DEFAULT_COLS,
        flags = { showTotalCol: trModuleNewShowTotalCol, showTotalRow: trModuleNewShowTotalRow }
    ) {
        const safeRows = trCustomClamp(rows, TR_MODULE_MIN_ROWS, TR_MODULE_MAX_ROWS, TR_MODULE_DEFAULT_ROWS);
        const safeCols = trCustomClamp(cols, TR_MODULE_MIN_COLS, TR_MODULE_MAX_COLS, TR_MODULE_DEFAULT_COLS);
        const safeTitle = String(title || '模块 1').trim() || '模块 1';
        const totalFlags = trModuleResolveTotalFlags(flags);
        const cells = Array.from({ length: safeRows }, (_, r) => Array.from({ length: safeCols }, (_, c) => (
            trModuleDefaultCellValue(r, c, safeRows, safeCols, totalFlags)
        )));
        return trModuleSyncTotals({
            title: safeTitle,
            rows: safeRows,
            cols: safeCols,
            showTotalCol: totalFlags.showTotalCol,
            showTotalRow: totalFlags.showTotalRow,
            monthVariables: {},
            cells,
        });
    }

    // 规范化模块数据载荷
    function trModuleNormalizePayload(raw) {
        const fallback = trModuleCreateDefaultPayload();
        if (!raw || typeof raw !== 'object') return fallback;
        const rows = trCustomClamp(raw.rows, TR_MODULE_MIN_ROWS, TR_MODULE_MAX_ROWS, fallback.rows);
        const cols = trCustomClamp(raw.cols, TR_MODULE_MIN_COLS, TR_MODULE_MAX_COLS, fallback.cols);
        const title = String(raw.title || fallback.title).trim() || fallback.title;
        const totalFlags = trModuleResolveTotalFlags(raw);
        const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
            if (r < (raw.cells?.length || 0) && c < (raw.cells[r]?.length || 0)) return String(raw.cells[r][c] ?? '');
            return trModuleDefaultCellValue(r, c, rows, cols, totalFlags);
        }));
        const monthVariables = (raw.monthVariables && typeof raw.monthVariables === 'object' && !Array.isArray(raw.monthVariables))
            ? raw.monthVariables
            : {};
        return trModuleSyncTotals({
            title,
            rows,
            cols,
            showTotalCol: totalFlags.showTotalCol,
            showTotalRow: totalFlags.showTotalRow,
            monthVariables,
            cells,
        });
    }

    // 深拷贝模块数据载荷
    function trModuleClonePayload(raw) {
        return JSON.parse(JSON.stringify(trModuleNormalizePayload(raw)));
    }

    // 序列化模块草稿用于脏检查
    function trModuleSerializeDraft(payload, id = trModuleCurrentId) {
        return JSON.stringify({ id: id || null, data: trModuleNormalizePayload(payload) });
    }

    // 标记模块草稿为已保存状态
    function trModuleMarkClean(payload = trModuleDraft, id = trModuleCurrentId) {
        trModuleSavedSnapshot = payload ? trModuleSerializeDraft(payload, id) : null;
    }

    // 判断模块草稿是否有未保存修改
    function trModuleIsDirty() {
        if (!trModuleDraft || trModuleSavedSnapshot === null) return false;
        return trModuleSerializeDraft(trModuleDraft, trModuleCurrentId) !== trModuleSavedSnapshot;
    }

    // 在确认后执行模块变更任务
    async function trModuleRunIfAllowed(message, task, options = {}) {
        const alwaysConfirm = Boolean(options && options.alwaysConfirm);
        if (!alwaysConfirm && !trModuleIsDirty()) {
            await task();
            return true;
        }
        if (!(await trCustomConfirm(message))) return false;
        await task();
        return true;
    }

    // 获取模块打印预览框架宽度
    function trModuleGetPrintFrameWidth() {
        if (trIsMobile()) return '100%';
        const isLandscape = typeof printPaperOrientation === 'string' && printPaperOrientation === 'landscape';
        return `${isLandscape ? TR_MODULE_PRINT_WIDTH_LANDSCAPE : TR_MODULE_PRINT_WIDTH_PORTRAIT}px`;
    }

    // 获取模块预览区块设计宽度
    function trModuleGetPreviewBlockWidthPx() {
        const isLandscape = typeof printPaperOrientation === 'string' && printPaperOrientation === 'landscape';
        return isLandscape ? TR_MODULE_PRINT_WIDTH_LANDSCAPE : TR_MODULE_PRINT_WIDTH_PORTRAIT;
    }

    // 获取模块引导轨总宽度
    function trModuleGetGuideTrackWidthPx(moduleWidthPx = trModuleGetPreviewBlockWidthPx()) {
        return moduleWidthPx + TR_MODULE_A4_EDGE_INSET * 2;
    }

    // 派发模块数据更新事件
    function trModuleEmitUpdate() {
        document.dispatchEvent(new CustomEvent('yybbq-custom-module-updated'));
    }

    // 判断是否还能创建更多模块
    function trModuleCanCreateMore() {
        return trModuleTemplates.length < TR_MODULE_MAX_SAVED;
    }

    // 获取创建模块按钮禁用属性
    function trModuleGetCreateButtonAttrs() {
        if (trModuleCanCreateMore()) return '';
        return ` disabled title="最多保存 ${TR_MODULE_MAX_SAVED} 个模块"`;
    }

    // 生成下一个默认模块标题
    function trModuleGetNextDefaultTitle() {
        return `模块 ${trModuleTemplates.length + 1}`;
    }

    // 应用服务端返回的模块列表
    function trModuleApplyTemplateList(list) {
        const safeList = Array.isArray(list) ? list : [];
        trModuleTemplates = safeList.map((item) => {
            const data = trModuleClonePayload(item && item.data);
            return {
                id: Number(item && item.id) || 0,
                position: Number(item && item.position) || 0,
                updated: String((item && item.updated) || ''),
                data,
            };
        }).filter((item) => item.id > 0).sort((a, b) => (a.position - b.position) || (a.id - b.id));
        if (trModuleCurrentId && !trModuleTemplates.some((item) => item.id === trModuleCurrentId)) {
            trModuleCurrentId = null;
        }
        if (!trModuleTemplates.length && !trModuleDraft && !trModulePendingDraft) {
            trModuleDraft = null;
            trModulePreviewReady = false;
        }
        trModuleEmitUpdate();
    }

    // 从服务端加载模块模板列表
    async function trModuleEnsureLoaded(force = false) {
        if (trModuleLoaded && !force) return trModuleTemplates;
        if (trModuleLoadingPromise && !force) return trModuleLoadingPromise;
        trModuleLoadingPromise = (async () => {
            const json = await fetchJsonSafe(`${TR_MODULE_API_BASE}/list`);
            if (json && json.ok) {
                trModuleApplyTemplateList(json.data);
                trModuleLoaded = true;
                return trModuleTemplates;
            }
            throw new Error((json && json.error) || 'load custom modules failed');
        })();
        try {
            return await trModuleLoadingPromise;
        } finally {
            trModuleLoadingPromise = null;
        }
    }

    // 构建模块模板切换按钮 HTML
    function trModuleBuildTemplateButtonsHtml() {
        const parts = trModuleTemplates.map((item, index) => {
            const slot = Math.min(3, index + 1);
            const active = trCustomContentKind === 'module' && item.id === trModuleCurrentId ? ' active' : '';
            return `<button type="button" class="tr-custom-template-btn tr-custom-template-slot-${slot}${active}" data-module-id="${item.id}">${index + 1}</button>`;
        });
        if (trCustomContentKind === 'module' && trModulePendingDraft && trModuleCurrentId === null) {
            parts.push('<button type="button" class="tr-custom-template-btn pending active" data-module-id="pending" aria-label="未保存模块"></button>');
        }
        return parts.join('');
    }

    // 构建带边界引导的预览包裹 HTML
    function trModuleBuildBoundsWrapHtml(innerHtml) {
        const spec = trModuleGetPrintInsertSpec();
        const guideWidthPx = spec.guideWidthPx;
        const contentHeightPx = trModuleGetCreatePreviewContentHeight();
        const previewScale = trModuleGetCreatePreviewScale(guideWidthPx);
        const scaledW = Math.ceil(guideWidthPx * previewScale);
        const scaledH = Math.ceil(contentHeightPx * previewScale);
        return `
                    <div class="tr-module-bounds-guide" style="--tr-module-print-width:${spec.widthPx}px; --tr-module-guide-width:${guideWidthPx}px; --tr-module-a4-edge-inset:${TR_MODULE_A4_EDGE_INSET}px; --tr-module-preview-scale:${previewScale};">
                        <div class="tr-module-bounds-scale-host" style="width:${scaledW}px;height:${scaledH}px;min-width:${scaledW}px;min-height:${scaledH}px;">
                            <div class="tr-module-bounds-scale" style="width:${guideWidthPx}px;height:${contentHeightPx}px;transform:scale(${previewScale});">
                                <div class="tr-module-bounds-track">
                                    <span class="tr-module-bounds-line tr-module-bounds-line-left" aria-hidden="true"></span>
                                    <span class="tr-module-bounds-line tr-module-bounds-line-right" aria-hidden="true"></span>
                                    <div class="tr-module-bounds-content">${innerHtml}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
    }

    // 构建模块预览区 HTML
    function trModuleBuildPreviewHtml() {
        if (!trModulePreviewReady || !trModuleDraft) {
            return '<div class="tr-module-preview-shell is-empty"></div>';
        }
        const spec = trModuleGetPrintInsertSpec();
        const createPitH = Number(spec.createPitBoxH) > 0 ? spec.createPitBoxH : spec.pitBoxH;
        const blockHtml = trModuleRenderPrintBlockHtml(
            trModuleDraft,
            spec.widthPx,
            spec.layoutScale,
            createPitH,
            {
                editable: trModuleIsWorkspaceEditable(),
                showVarButtons: trModuleIsModuleWorkspacePreview(),
            }
        );
        return `<div class="tr-module-preview-shell"><div class="tr-module-preview-frame is-pit-ref" style="--tr-module-print-width:${spec.widthPx}px">${blockHtml}</div></div>`;
    }

    // 构建模块工作区列布局 HTML
    function trModuleBuildWorkspaceHtml() {
        const varPanelWidthPx = trModuleGetVarPanelWidthPx();
        const previewHtml = trModuleBuildPreviewHtml();
        const varEditorHtml = trModuleBuildVariableEditorHtml();
        const varOpenClass = trModuleActiveVariableKey ? ' is-var-open' : '';
        return `<div class="tr-module-workspace-column${varOpenClass}" style="--tr-module-var-panel-width:${varPanelWidthPx}px">${trModuleBuildBoundsWrapHtml(previewHtml)}${varEditorHtml}</div>`;
    }

    // 判断模块除表头外是否已有数据
    function trModuleHasDataBeyondOrigin(payload) {
        const safe = trModuleNormalizePayload(payload);
        for (let r = 0; r < safe.rows; r += 1) {
            for (let c = 0; c < safe.cols; c += 1) {
                if (trModuleIsProtectedLabelCell(r, c, safe.rows, safe.cols, safe)) continue;
                if (trModuleIsComputedSumCell(r, c, safe.rows, safe.cols, safe)) continue;
                if (trModuleIsVariableCell(safe, r, c, safe.rows, safe.cols, safe)) {
                    const varDef = trModuleGetMonthVariable(safe, r, c);
                    if (varDef) {
                        if (trCustomCellHasContent(varDef.sharedValue)) return true;
                        if (Array.isArray(varDef.values) && varDef.values.some((v) => trCustomCellHasContent(v))) return true;
                    }
                    continue;
                }
                if (trCustomCellHasContent(safe.cells[r] && safe.cells[r][c])) return true;
            }
        }
        return false;
    }

    // 根据数据情况返回模块清空方案
    function trModuleGetClearPlan(payload) {
        if (trModuleHasDataBeyondOrigin(payload)) {
            return { message: '是否清空数据？', mode: 'data' };
        }
        return { message: '是否清空模块？', mode: 'module' };
    }

    // 清空模块草稿数据格
    function trModuleClearDraftCells(payload = trModuleDraft) {
        const safe = trModuleClonePayload(payload);
        for (let r = 0; r < safe.rows; r += 1) {
            for (let c = 0; c < safe.cols; c += 1) {
                if (trModuleIsProtectedLabelCell(r, c, safe.rows, safe.cols, safe)) continue;
                if (trModuleIsComputedSumCell(r, c, safe.rows, safe.cols, safe)) {
                    safe.cells[r][c] = '';
                    continue;
                }
                if (trModuleIsVariableCell(safe, r, c, safe.rows, safe.cols, safe)) {
                    const varDef = trModuleGetMonthVariable(safe, r, c);
                    if (varDef && Array.isArray(varDef.values)) varDef.values.fill('');
                    continue;
                }
                safe.cells[r][c] = '';
            }
        }
        return trModuleSyncTotals(safe);
    }

    // 重置模块为默认空白结构
    function trModuleResetWholeModule(payload = trModuleDraft) {
        const safe = trModuleClonePayload(payload);
        return trModuleCreateDefaultPayload(safe.title, safe.rows, safe.cols, trModuleResolveTotalFlags(safe));
    }

    // 删除已保存的模块模板
    async function trModuleDeleteTemplate(moduleId) {
        const json = await fetchJsonSafe(`${TR_MODULE_API_BASE}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: moduleId }),
        });
        if (!json || !json.ok) {
            throw new Error((json && json.error) || 'delete custom module failed');
        }
        trModuleTemplates = trModuleTemplates.filter((item) => item.id !== moduleId);
        trCustomCloseManagePanel();
        trModuleToolbarExpanded = false;
        trModuleWorkspaceEditMode = false;
        trCustomClearStatus();
        if (trModuleCurrentId === moduleId) {
            if (trModuleBeforeCreateId && trModuleTemplates.some((item) => item.id === trModuleBeforeCreateId)) {
                trModuleSelectTemplate(trModuleBeforeCreateId);
                trCustomContentKind = 'module';
            } else if (trModuleTemplates.length) {
                trModuleSelectTemplate(trModuleTemplates[0].id);
                trCustomContentKind = 'module';
            } else {
                trModuleCurrentId = null;
                trModulePendingDraft = false;
                trModuleBeforeCreateId = null;
                trModuleDraft = null;
                trModulePreviewReady = false;
                trCustomContentKind = null;
                trModuleMarkClean();
                trModuleEmitUpdate();
            }
        } else {
            trModuleEmitUpdate();
        }
        trModuleLoaded = true;
        return json;
    }

    // 选中并加载已保存模块
    function trModuleSelectTemplate(templateId) {
        const match = trModuleTemplates.find((item) => item.id === Number(templateId));
        if (!match) return;
        trCustomCloseManagePanel();
        trModuleCurrentId = match.id;
        trModuleDraft = trModuleClonePayload(match.data);
        trModulePreviewReady = true;
        trModulePendingDraft = false;
        trModuleBeforeCreateId = null;
        trModuleToolbarExpanded = false;
        trModuleWorkspaceEditMode = false;
        trModuleActiveVariableKey = null;
        trModuleMarkClean();
        trModuleEmitUpdate();
    }

    // 开始新建模块会话
    function trModuleBeginCreateSession() {
        if (!trModuleCanCreateMore()) {
            trCustomSetError(`最多保存 ${TR_MODULE_MAX_SAVED} 个模块`);
            return false;
        }
        trCustomCloseManagePanel();
        trCustomSelectorKind = 'module';
        trCustomContentKind = 'module';
        trModuleBeforeCreateId = trModuleCurrentId;
        trModuleToolbarExpanded = true;
        trModuleWorkspaceEditMode = true;
        trModuleNewTitle = trModuleGetNextDefaultTitle();
        trModuleNewRows = TR_MODULE_DEFAULT_ROWS;
        trModuleNewCols = TR_MODULE_DEFAULT_COLS;
        trModuleNewShowTotalCol = true;
        trModuleNewShowTotalRow = true;
        trModuleResetMonthInsertUiState();
        trModuleCurrentId = null;
        trModuleDraft = null;
        trModulePreviewReady = false;
        trModulePendingDraft = true;
        trModuleMarkClean();
        trModuleApplyCreateFromInputs();
        trModuleEmitUpdate();
        return true;
    }

    // 取消新建模块会话
    function trModuleCancelCreateSession() {
        trCustomCloseManagePanel();
        trModulePendingDraft = false;
        trModuleToolbarExpanded = false;
        trModuleWorkspaceEditMode = false;
        trModuleActiveVariableKey = null;
        if (trModuleBeforeCreateId && trModuleTemplates.some((item) => item.id === trModuleBeforeCreateId)) {
            trModuleSelectTemplate(trModuleBeforeCreateId);
            trCustomContentKind = 'module';
        } else {
            trModuleCurrentId = null;
            trModuleDraft = null;
            trModulePreviewReady = false;
            trCustomContentKind = null;
            trModuleMarkClean();
        }
        trModuleBeforeCreateId = null;
        trModuleEmitUpdate();
    }

    // 根据输入创建模块草稿
    function trModuleApplyCreateFromInputs() {
        const title = String(trModuleNewTitle || '').trim() || '模块 1';
        const rows = trCustomClamp(trModuleNewRows, TR_MODULE_MIN_ROWS, TR_MODULE_MAX_ROWS, TR_MODULE_DEFAULT_ROWS);
        const cols = trCustomClamp(trModuleNewCols, TR_MODULE_MIN_COLS, TR_MODULE_MAX_COLS, TR_MODULE_DEFAULT_COLS);
        trModuleDraft = trModuleCreateDefaultPayload(title, rows, cols, {
            showTotalCol: trModuleNewShowTotalCol,
            showTotalRow: trModuleNewShowTotalRow,
        });
        trModuleNewRows = trModuleDraft.rows;
        trModuleNewCols = trModuleDraft.cols;
        trModulePreviewReady = true;
        trModuleEmitUpdate();
        return true;
    }

    // 根据输入调整模块行列
    function trModuleApplyResizeFromInputs() {
        const title = String(trModuleNewTitle || '').trim() || '模块 1';
        const targetRows = trCustomClamp(trModuleNewRows, TR_MODULE_MIN_ROWS, TR_MODULE_MAX_ROWS, TR_MODULE_DEFAULT_ROWS);
        const targetCols = trCustomClamp(trModuleNewCols, TR_MODULE_MIN_COLS, TR_MODULE_MAX_COLS, TR_MODULE_DEFAULT_COLS);
        const flags = {
            showTotalCol: trModuleNewShowTotalCol,
            showTotalRow: trModuleNewShowTotalRow,
        };
        if (!trModuleDraft) {
            return trModuleApplyCreateFromInputs();
        }
        const old = trModuleClonePayload(trModuleDraft);
        const oldFlags = trModuleResolveTotalFlags(old);
        const cells = Array.from({ length: targetRows }, (_, r) => Array.from({ length: targetCols }, (_, c) => {
            if (r < old.rows && c < old.cols && old.cells[r]) {
                return String(old.cells[r][c] ?? '');
            }
            return trModuleDefaultCellValue(r, c, targetRows, targetCols, oldFlags);
        }));
        trModuleDraft = trModuleSyncTotals(Object.assign({}, old, {
            title,
            rows: targetRows,
            cols: targetCols,
            showTotalCol: flags.showTotalCol,
            showTotalRow: flags.showTotalRow,
            cells,
            monthVariables: old.monthVariables || {},
        }));
        trModuleNewRows = trModuleDraft.rows;
        trModuleNewCols = trModuleDraft.cols;
        trModulePreviewReady = true;
        trModuleEmitUpdate();
        return true;
    }

    // 将变量编辑面板同步到草稿
    function trModuleSyncVariableEditorDomToDraft(varDef) {
        if (!varDef) return;
        const nameInput = document.getElementById('trModuleVarNameInput');
        const startYearSel = document.getElementById('trModuleVarPanelStartYear');
        const startMonthSel = document.getElementById('trModuleVarPanelStartMonth');
        const endYearSel = document.getElementById('trModuleVarPanelEndYear');
        const endMonthSel = document.getElementById('trModuleVarPanelEndMonth');
        const sharedInput = document.getElementById('trModuleVarSharedInput');
        const editor = document.getElementById('trModuleVarEditor');
        const monthInputs = editor
            ? Array.from(editor.querySelectorAll('.tr-module-var-month-input'))
            : [];
        if (nameInput) varDef.name = String(nameInput.value || '变量').trim() || '变量';
        trModuleApplyVariablePanelRange(varDef, {
            startYear: startYearSel ? startYearSel.value : '',
            startMonth: startMonthSel ? startMonthSel.value : '',
            endYear: endYearSel ? endYearSel.value : '',
            endMonth: endMonthSel ? endMonthSel.value : '',
        });
        if (!trModuleIsVariableRangeComplete(varDef)) return;
        trModuleApplyVariableSharedValueOnSave(
            varDef,
            sharedInput ? sharedInput.value : '',
            monthInputs
        );
        varDef.rangeConfirmed = true;
    }

    // 保存前校验并整理模块草稿
    function trModulePrepareDraftForSave() {
        if (!trModuleDraft) return { ok: false, error: '没有可保存的模块' };
        const titleInput = document.getElementById('trModuleTitleInput');
        if (titleInput) {
            const title = String(titleInput.value || '').trim();
            if (title) {
                trModuleDraft.title = title;
                trModuleNewTitle = title;
            }
        }
        if (trModuleActiveVariableKey) {
            const { row, col } = trModuleParseVarCellKey(trModuleActiveVariableKey);
            const varDef = trModuleGetMonthVariable(trModuleDraft, row, col);
            if (varDef) {
                trModuleSyncVariableEditorDomToDraft(varDef);
                if (!trModuleIsVariableRangeComplete(varDef)) {
                    return { ok: false, error: '变量面板有未完成的日期范围，请先保存变量或补全范围' };
                }
                trModuleActiveVariableKey = null;
            }
        }
        trModuleDraft = trModuleSyncTotals(trModuleDraft);
        return { ok: true };
    }

    // 保存当前模块草稿到服务端
    async function trModuleSaveCurrent() {
        const prepared = trModulePrepareDraftForSave();
        if (!prepared.ok) throw new Error(prepared.error || '保存模块失败');
        const payload = trModuleClonePayload(trModuleDraft);
        const json = await fetchJsonSafe(`${TR_MODULE_API_BASE}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: trModuleCurrentId, data: payload }),
        });
        if (!json || !json.ok) throw new Error((json && json.error) || 'save custom module failed');
        const savedId = Number(json.id) || 0;
        const saved = {
            id: savedId,
            position: Number(json.position) || (trModuleTemplates.length + 1),
            updated: String(json.updated || ''),
            data: trModuleClonePayload(json.data),
        };
        const idx = trModuleTemplates.findIndex((item) => item.id === savedId);
        if (idx > -1) trModuleTemplates.splice(idx, 1, saved);
        else trModuleTemplates.push(saved);
        trModuleTemplates.sort((a, b) => (a.position - b.position) || (a.id - b.id));
        trModuleCurrentId = savedId;
        trModuleDraft = trModuleClonePayload(saved.data);
        trModuleNewTitle = String(trModuleDraft.title || '').trim() || trModuleNewTitle;
        trModuleNewRows = trModuleDraft.rows;
        trModuleNewCols = trModuleDraft.cols;
        const savedFlags = trModuleResolveTotalFlags(trModuleDraft);
        trModuleNewShowTotalCol = savedFlags.showTotalCol;
        trModuleNewShowTotalRow = savedFlags.showTotalRow;
        trModulePreviewReady = true;
        trModulePendingDraft = false;
        trModuleBeforeCreateId = null;
        trModuleToolbarExpanded = false;
        trModuleWorkspaceEditMode = false;
        trModuleActiveVariableKey = null;
        trCustomSelectorKind = 'module';
        trCustomContentKind = 'module';
        trModuleMarkClean();
        trModuleLoaded = true;
        trModuleEmitUpdate();
        if (typeof window.yybbqEnsurePrintEnabledItem === 'function') {
            window.yybbqEnsurePrintEnabledItem('module', savedId);
        }
        if (typeof window.yybbqOnModuleSaved === 'function') {
            window.yybbqOnModuleSaved(saved);
        }
        return saved;
    }

    window.yybbqRenderModuleInPit = function (payload, widthPx, scale, pitBoxH, context = null) {
        return trModuleRenderPrintBlockHtml(payload, widthPx, scale, pitBoxH, {
            editable: false,
            context: context || null,
        });
    };
    window.yybbqResolveModulePayloadForPrint = function (moduleId) {
        const id = Number(moduleId) || 0;
        if (id > 0 && trModuleCurrentId === id && trModuleDraft) {
            return trModuleClonePayload(trModuleDraft);
        }
        return null;
    };
    window.yybbqGetModuleGrandTotal = function (payload) {
        return trModuleGetGrandTotal(payload);
    };
    window.yybbqResolveModuleTotalFlags = function (payload) {
        return trModuleResolveTotalFlags(payload);
    };
    window.yybbqOnModuleSaved = function (saved) {
        if (typeof setPrintActiveModule === 'function') {
            Promise.resolve(setPrintActiveModule(saved)).catch(() => { });
        }
    };

    //#endregion

    //#region 共用 · 工具栏外框
    // 构建打印设置中的表格启用按钮 HTML
    function trBuildPrintSettingsTableButtonsHtml() {
        return trCustomTemplates.map((item, index) => {
            const enabled = trPrintSettingsDraftTableIds.has(item.id) ? ' is-print-enabled' : '';
            return `<button type="button" class="tr-custom-template-btn tr-custom-template-slot-${Math.min(3, index + 1)}${enabled}" data-print-settings-kind="table" data-template-id="${item.id}">${index + 1}</button>`;
        }).join('');
    }

    // 构建打印设置中的模块启用按钮 HTML
    function trBuildPrintSettingsModuleButtonsHtml() {
        return trModuleTemplates.map((item, index) => {
            const enabled = trPrintSettingsDraftModuleIds.has(item.id) ? ' is-print-enabled' : '';
            return `<button type="button" class="tr-custom-template-btn tr-custom-template-slot-${Math.min(3, index + 1)}${enabled}" data-print-settings-kind="module" data-module-id="${item.id}">${index + 1}</button>`;
        }).join('');
    }

    // 进入打印项启用设置模式
    async function trEnterPrintSettingsMode() {
        trPrintSettingsMode = true;
        trCustomCloseManagePanel();
        try {
            await trCustomEnsureLoaded();
            await trModuleEnsureLoaded();
        } catch (_) { }
        const enabledTables = typeof window.yybbqGetPrintEnabledTableIds === 'function'
            ? window.yybbqGetPrintEnabledTableIds()
            : [];
        const enabledModules = typeof window.yybbqGetPrintEnabledModuleIds === 'function'
            ? window.yybbqGetPrintEnabledModuleIds()
            : [];
        trPrintSettingsDraftTableIds = new Set(
            enabledTables.length
                ? enabledTables
                : trCustomTemplates.map((item) => item.id)
        );
        trPrintSettingsDraftModuleIds = new Set(
            enabledModules.length
                ? enabledModules
                : trModuleTemplates.map((item) => item.id)
        );
    }

    // 退出打印设置模式并可选择丢弃草稿
    function trExitPrintSettingsMode(revertDraft = true) {
        trPrintSettingsMode = false;
        if (revertDraft) {
            trPrintSettingsDraftTableIds = new Set();
            trPrintSettingsDraftModuleIds = new Set();
        }
    }

    // 确认并保存打印启用项选择
    function trConfirmPrintSettings() {
        const tableIds = Array.from(trPrintSettingsDraftTableIds);
        const moduleIds = Array.from(trPrintSettingsDraftModuleIds);
        if (typeof window.yybbqSetPrintEnabledIds === 'function') {
            window.yybbqSetPrintEnabledIds(tableIds, moduleIds);
        }
        trExitPrintSettingsMode(false);
    }

    // 构建报表/模块选择器面板 HTML
    function trBuildCustomSelectorPanelHtml() {
        if (trPrintSettingsMode) {
            const tableButtons = trBuildPrintSettingsTableButtonsHtml();
            const moduleButtons = trBuildPrintSettingsModuleButtonsHtml();
            return `
                        <div class="tr-custom-selector-panel is-print-settings">
                            <span class="tr-print-settings-group-label">表格</span>
                            <div class="tr-custom-selector-items tr-print-settings-tables">${tableButtons || '<span class="tr-custom-status">无</span>'}</div>
                            <span class="tr-print-settings-group-label">模块</span>
                            <div class="tr-custom-selector-items tr-print-settings-modules">${moduleButtons || '<span class="tr-custom-status">无</span>'}</div>
                            <div class="tr-print-settings-actions">
                                <button type="button" class="tr-custom-action-btn" id="trPrintSettingsCancelBtn">取消</button>
                                <button type="button" class="tr-custom-action-btn primary" id="trPrintSettingsConfirmBtn">确定</button>
                            </div>
                        </div>
                    `;
        }
        const itemsHtml = trCustomSelectorKind === 'table'
            ? trCustomBuildTemplateButtonsHtml()
            : trCustomSelectorKind === 'module'
                ? trModuleBuildTemplateButtonsHtml()
                : '';
        return `
                    <div class="tr-custom-selector-panel">
                        <button type="button" class="tr-custom-action-btn tr-custom-kind-btn${trCustomSelectorKind === 'table' ? ' active' : ''}" data-selector-kind="table">报表</button>
                        <button type="button" class="tr-custom-action-btn tr-custom-kind-btn${trCustomSelectorKind === 'module' ? ' active' : ''}" data-selector-kind="module">模块</button>
                        <div class="tr-custom-selector-items">${itemsHtml}</div>
                        <div class="tr-custom-selector-manage-slot">${trCustomBuildManageControlsHtml()}</div>
                    </div>
                `;
    }

    // 构建创建表格/模块与打印设置按钮 HTML
    function trBuildCreateActionsHtml(createModuleActive, createTableActive) {
        const settingsActive = trPrintSettingsMode ? ' active' : '';
        return `
                    <button type="button" class="tr-custom-action-btn tr-custom-print-settings-btn${settingsActive}" id="trCustomPrintSettingsBtn">打印设置</button>
                    <button type="button" class="tr-custom-action-btn tr-custom-create-module-btn${createModuleActive ? ' active' : ''}" id="trCustomCreateModuleBtn"${trModuleGetCreateButtonAttrs()}>创建模块</button>
                    <button type="button" class="tr-custom-action-btn tr-custom-create-toggle-btn${createTableActive ? ' active' : ''}" id="trCustomCreateToggleBtn">创建表格</button>
                `;
    }

    // 尝试切换报表/模块选择器类型
    async function trCustomTrySwitchSelectorKind(nextKind) {
        if (nextKind === trCustomSelectorKind) return true;
        if (trCustomContentKind === 'table' && trCustomDraft && trCustomIsDirty()) {
            if (!(await trCustomConfirm('当前表格有未保存的修改，切换将丢失，是否继续？'))) return false;
        }
        if (trCustomContentKind === 'module' && trModuleDraft && trModuleIsDirty()) {
            if (!(await trCustomConfirm('当前模块有未保存的修改，切换将丢失，是否继续？'))) return false;
        }
        trCustomSelectorKind = nextKind;
        trCustomContentKind = null;
        trCustomCloseManagePanel();
        return true;
    }

    // 激活选择器中的第一项模板
    async function trCustomActivateFirstSelectorItem(kind) {
        trCustomSelectorKind = kind;
        if (kind === 'table') {
            await trCustomEnsureLoaded();
            if (!trCustomTemplates.length) {
                trCustomContentKind = null;
                return true;
            }
            const firstId = trCustomTemplates[0].id;
            if (trCustomContentKind === 'table' && trCustomCurrentId === firstId && !trCustomPendingDraft) {
                return true;
            }
            return trCustomRunIfAllowed('当前表格有未保存的修改，切换表格将丢失，是否继续？', () => {
                trCustomContentKind = 'table';
                trCustomSelectTemplate(firstId);
            });
        }
        await trModuleEnsureLoaded();
        if (!trModuleTemplates.length) {
            trCustomContentKind = null;
            return true;
        }
        const firstId = trModuleTemplates[0].id;
        if (trCustomContentKind === 'module' && trModuleCurrentId === firstId && !trModulePendingDraft) {
            return true;
        }
        if (trCustomContentKind === 'module' && trModuleDraft && trModuleIsDirty()) {
            if (!(await trCustomConfirm('当前模块有未保存的修改，切换将丢失，是否继续？'))) return false;
        }
        trCustomContentKind = 'module';
        trModuleSelectTemplate(firstId);
        return true;
    }

    //#endregion

    //#region 共用 · 按钮与操作
    // 绑定打印设置面板按钮事件
    function trCustomBindPrintSettingsHandlers(root) {
        const scope = root || document;
        const printSettingsBtn = scope.querySelector('#trCustomPrintSettingsBtn');
        const cancelBtn = scope.querySelector('#trPrintSettingsCancelBtn');
        const confirmBtn = scope.querySelector('#trPrintSettingsConfirmBtn');
        if (printSettingsBtn) {
            printSettingsBtn.addEventListener('click', async () => {
                if (trPrintSettingsMode) {
                    trExitPrintSettingsMode(true);
                    trQueueRenderDOM();
                    return;
                }
                await trEnterPrintSettingsMode();
                trQueueRenderDOM();
            });
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                trExitPrintSettingsMode(true);
                trQueueRenderDOM();
            });
        }
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                trConfirmPrintSettings();
                trQueueRenderDOM();
            });
        }
        scope.querySelectorAll('.tr-custom-template-btn[data-print-settings-kind="table"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const templateId = Number(btn.dataset.templateId) || 0;
                if (!templateId) return;
                if (trPrintSettingsDraftTableIds.has(templateId)) {
                    trPrintSettingsDraftTableIds.delete(templateId);
                    btn.classList.remove('is-print-enabled');
                } else {
                    trPrintSettingsDraftTableIds.add(templateId);
                    btn.classList.add('is-print-enabled');
                }
            });
        });
        scope.querySelectorAll('.tr-custom-template-btn[data-print-settings-kind="module"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const moduleId = Number(btn.dataset.moduleId) || 0;
                if (!moduleId) return;
                if (trPrintSettingsDraftModuleIds.has(moduleId)) {
                    trPrintSettingsDraftModuleIds.delete(moduleId);
                    btn.classList.remove('is-print-enabled');
                } else {
                    trPrintSettingsDraftModuleIds.add(moduleId);
                    btn.classList.add('is-print-enabled');
                }
            });
        });
    }

    // 绑定报表/模块选择器相关事件
    function trCustomBindSelectorHandlers(root) {
        const scope = root || document;
        trCustomBindPrintSettingsHandlers(scope);
        if (trPrintSettingsMode) return;
        scope.querySelectorAll('.tr-custom-kind-btn[data-selector-kind]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const nextKind = btn.dataset.selectorKind === 'module' ? 'module' : 'table';
                if (nextKind !== trCustomSelectorKind) {
                    if (!(await trCustomTrySwitchSelectorKind(nextKind))) return;
                }
                const activated = await trCustomActivateFirstSelectorItem(nextKind);
                if (activated) trQueueRenderDOM();
            });
        });
        scope.querySelectorAll('.tr-custom-template-btn[data-template-id]:not([data-print-settings-kind])').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (btn.dataset.templateId === 'pending') return;
                const templateId = Number(btn.dataset.templateId);
                if (trCustomContentKind === 'table' && templateId === trCustomCurrentId) return;
                const ok = await trCustomRunIfAllowed('当前表格有未保存的修改，切换表格将丢失，是否继续？', () => {
                    trCustomSelectorKind = 'table';
                    trCustomContentKind = 'table';
                    trCustomSelectTemplate(templateId);
                });
                if (ok) trQueueRenderDOM();
            });
        });
        scope.querySelectorAll('.tr-custom-template-btn[data-module-id]:not([data-print-settings-kind])').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (btn.dataset.moduleId === 'pending') return;
                const moduleId = Number(btn.dataset.moduleId);
                if (trCustomContentKind === 'module' && moduleId === trModuleCurrentId) return;
                if (trCustomContentKind === 'module' && trModuleIsDirty() && !(await trCustomConfirm('当前模块有未保存的修改，切换将丢失，是否继续？'))) return;
                trCustomSelectorKind = 'module';
                trCustomContentKind = 'module';
                await trModuleEnsureLoaded();
                trModuleSelectTemplate(moduleId);
                trQueueRenderDOM();
            });
        });
        const createModuleBtn = scope.querySelector('#trCustomCreateModuleBtn');
        const createTableBtn = scope.querySelector('#trCustomCreateToggleBtn');
        if (createModuleBtn) {
            createModuleBtn.addEventListener('click', async () => {
                if (!trModuleCanCreateMore()) {
                    trCustomSetError(`最多保存 ${TR_MODULE_MAX_SAVED} 个模块`);
                    trQueueRenderDOM();
                    return;
                }
                if (trCustomContentKind === 'table' && trCustomDraft && trCustomIsDirty()) {
                    if (!(await trCustomConfirm('当前表格有未保存的修改，切换将丢失，是否继续？'))) return;
                }
                trCustomSelectorKind = 'module';
                trCustomContentKind = 'module';
                if (!trModuleToolbarExpanded) {
                    if (trModuleBeginCreateSession() === false) {
                        trQueueRenderDOM();
                        return;
                    }
                }
                trQueueRenderDOM();
                try {
                    await trModuleEnsureLoaded();
                    trQueueRenderDOM();
                } catch (_) { }
            });
        }
        if (createTableBtn) {
            createTableBtn.addEventListener('click', async () => {
                if (trCustomContentKind === 'module' && trModuleDraft && trModuleIsDirty()) {
                    if (!(await trCustomConfirm('当前模块有未保存的修改，切换将丢失，是否继续？'))) return;
                }
                trCustomBeginCreateSession();
                const allYears = trGetAllYears();
                trRenderYearFilter(allYears);
                trRenderSettings();
                trQueueRenderDOM();
            });
        }
    }

    // 渲染无选中模板的空闲工作区页面
    function trCustomRenderIdlePage() {
        return `
                    <div class="tr-custom-page">
                        <div class="tr-custom-toolbar tr-workspace-idle${trPrintSettingsMode ? ' is-print-settings-mode' : ''}">
                            <div class="tr-custom-template-group">
                                ${trBuildCustomSelectorPanelHtml()}
                            </div>
                            <div class="tr-custom-create-actions">
                                ${trBuildCreateActionsHtml(false, false)}
                            </div>
                        </div>
                        <div class="tr-custom-table-wrap tr-custom-idle-wrap" id="trCustomTableWrap"></div>
                    </div>
                `;
    }

    // 绑定空闲工作区页面事件
    function trCustomBindIdlePage() {
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        trModuleDisconnectPreviewResizeObserver();
        trCustomEnsureConfirmBound();
        trCustomBindSelectorHandlers(content);
        trCustomBindManageHandlers(content);
    }

    // 渲染模块编辑工作区页面 HTML
    function trModuleRenderPage() {
        const selectorPanelHtml = trBuildCustomSelectorPanelHtml();
        const workspaceHtml = trModuleBuildWorkspaceHtml();
        const varEditing = trModuleActiveVariableKey ? ' is-var-editing' : '';
        const moduleEdit = trModuleWorkspaceEditMode;
        const moduleToolbarOpen = trModuleToolbarExpanded;
        const roAttr = moduleEdit ? '' : ' disabled';
        const roInputAttr = moduleEdit ? '' : ' disabled readonly';
        return `
                    <div class="tr-custom-page">
                        <div class="tr-custom-toolbar tr-workspace-module${moduleToolbarOpen ? ' is-expanded' : ''}${moduleToolbarOpen && !moduleEdit ? ' is-readonly' : ''}${trPrintSettingsMode ? ' is-print-settings-mode' : ''}">
                            <div class="tr-custom-template-group">
                                ${selectorPanelHtml}
                            </div>
                            <div class="tr-module-tools-toolbar">
                                <div class="tr-custom-expanded-controls">
                                    <div class="tr-custom-tools-cluster">
                                        <div class="tr-module-create-panel">
                                            <span class="tr-custom-size-label">Module</span>
                                            <input class="tr-custom-size-input tr-module-title-input" id="trModuleTitleInput" type="text" maxlength="40" value="${escapeHtml(trModuleNewTitle)}" placeholder=""${roInputAttr}>
                                            <span class="tr-custom-size-label">行</span>
                                            <input class="tr-custom-size-input" id="trModuleRowsInput" type="number" min="${TR_MODULE_MIN_ROWS}" max="${TR_MODULE_MAX_ROWS}" value="${trModuleNewRows}"${roInputAttr}>
                                            <span class="tr-custom-size-label">列</span>
                                            <input class="tr-custom-size-input" id="trModuleColsInput" type="number" min="${TR_MODULE_MIN_COLS}" max="${TR_MODULE_MAX_COLS}" value="${trModuleNewCols}"${roInputAttr}>
                                            <button type="button" class="tr-custom-action-btn" id="trModuleApplyCreateBtn"${roAttr}>调整</button>
                                        </div>
                                        <div class="tr-module-total-panel${trModuleMonthInsertExpanded ? ' is-var-expanded' : ''}">
                                            <button type="button" class="tr-module-total-toggle${trModuleNewShowTotalCol ? ' active' : ''}" id="trModuleTotalColToggleBtn"${roAttr}>总额</button>
                                            <button type="button" class="tr-module-total-toggle${trModuleNewShowTotalRow ? ' active' : ''}" id="trModuleTotalRowToggleBtn"${roAttr}>Total</button>
                                            <button type="button" class="tr-module-total-toggle${trModuleMonthInsertExpanded ? ' active' : ''}" id="trModuleVarToggleBtn"${roAttr}>变量</button>
                                            <div class="tr-module-var-toolbar-expand">
                                                <span class="tr-custom-size-label">行</span>
                                                <input class="tr-custom-size-input tr-module-var-pos-input" id="trModuleVarRowInput" type="number" min="1" max="${Math.max(1, trModuleDraft ? trModuleDraft.rows : trModuleNewRows)}" value="${trModuleMonthInsertRow}"${roInputAttr}>
                                                <span class="tr-custom-size-label">列</span>
                                                <input class="tr-custom-size-input tr-module-var-pos-input" id="trModuleVarColInput" type="number" min="1" max="${Math.max(1, trModuleDraft ? trModuleDraft.cols : trModuleNewCols)}" value="${trModuleMonthInsertCol}"${roInputAttr}>
                                                <button type="button" class="tr-custom-action-btn" id="trModuleVarAddBtn"${roAttr}>添加</button>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="tr-custom-action-panel">
                                        <button type="button" class="tr-custom-action-btn" id="trModuleCancelBtn"${roAttr}>取消</button>
                                        <button type="button" class="tr-custom-action-btn primary" id="trModuleSaveBtn"${roAttr}>保存</button>
                                    </div>
                                </div>
                            </div>
                            <div class="tr-custom-create-actions">
                                ${trBuildCreateActionsHtml(true, false)}
                            </div>
                        </div>
                        <div class="tr-custom-table-wrap tr-module-workspace-wrap${moduleEdit ? ' is-editing' : ''}${varEditing}" id="trCustomTableWrap">${workspaceHtml}<div class="tr-module-save-toast" aria-live="polite"></div></div>
                    </div>
                `;
    }

    let trModulePreviewResizeObserver = null;
    let trModulePreviewScaleRaf = 0;
    let trModuleLastPreviewScaleKey = '';
    let trWorkspaceSaveToastTimer = null;
    let trPendingWorkspaceSaveToast = null;

    // 显示工作区保存成功提示条
    function trWorkspaceShowSaveToast(message = '保存成功', ms = 2000) {
        const wrap = document.getElementById('trCustomTableWrap');
        if (!wrap) return;
        let toast = wrap.querySelector('.tr-module-save-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'tr-module-save-toast';
            toast.setAttribute('aria-live', 'polite');
            wrap.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.remove('show');
        void toast.offsetWidth;
        toast.classList.add('show');
        if (trWorkspaceSaveToastTimer) clearTimeout(trWorkspaceSaveToastTimer);
        trWorkspaceSaveToastTimer = setTimeout(() => {
            toast.classList.remove('show');
            trWorkspaceSaveToastTimer = null;
        }, ms);
    }

    // 调度在下次渲染后显示保存提示
    function trScheduleWorkspaceSaveToast(message = '保存成功', ms = 2000) {
        trPendingWorkspaceSaveToast = { message, ms };
    }

    // 刷新待显示的保存提示条
    function trFlushPendingWorkspaceSaveToast() {
        if (!trPendingWorkspaceSaveToast) return;
        const { message, ms } = trPendingWorkspaceSaveToast;
        trPendingWorkspaceSaveToast = null;
        requestAnimationFrame(() => {
            trWorkspaceShowSaveToast(message, ms);
        });
    }

    // 同步模块预览区缩放与变量面板宽度
    function trModuleSyncPreviewScale() {
        if (trCustomContentKind !== 'module') return;
        const wrap = document.getElementById('trCustomTableWrap');
        const guide = wrap && wrap.querySelector('.tr-module-bounds-guide');
        const scaleHost = guide && guide.querySelector('.tr-module-bounds-scale-host');
        const scaleEl = scaleHost && scaleHost.querySelector('.tr-module-bounds-scale');
        if (!wrap || !guide || !scaleHost || !scaleEl) return;

        const spec = trModuleGetPrintInsertSpec();
        const guideWidthPx = spec.guideWidthPx;
        const contentHeightPx = trModuleGetCreatePreviewContentHeight();
        const previewScale = trModuleGetCreatePreviewScale(guideWidthPx);
        const scaledW = Math.ceil(guideWidthPx * previewScale);
        const scaledH = Math.ceil(contentHeightPx * previewScale);
        const scaleKey = `${guideWidthPx}|${contentHeightPx}|${previewScale}|${wrap.clientWidth}`;
        if (scaleKey === trModuleLastPreviewScaleKey) return;
        trModuleLastPreviewScaleKey = scaleKey;

        guide.style.setProperty('--tr-module-print-width', `${spec.widthPx}px`);
        guide.style.setProperty('--tr-module-guide-width', `${guideWidthPx}px`);
        guide.style.setProperty('--tr-module-a4-edge-inset', `${TR_MODULE_A4_EDGE_INSET}px`);
        guide.style.setProperty('--tr-module-preview-scale', String(previewScale));
        scaleHost.style.width = `${scaledW}px`;
        scaleHost.style.height = `${scaledH}px`;
        scaleHost.style.minWidth = `${scaledW}px`;
        scaleHost.style.minHeight = `${scaledH}px`;
        scaleEl.style.width = `${guideWidthPx}px`;
        scaleEl.style.height = `${contentHeightPx}px`;
        scaleEl.style.transform = `scale(${previewScale})`;

        const varPanelWidthPx = Math.ceil(spec.widthPx * previewScale);
        const workspaceColumn = wrap.querySelector('.tr-module-workspace-column');
        if (workspaceColumn) {
            workspaceColumn.style.setProperty('--tr-module-var-panel-width', `${varPanelWidthPx}px`);
        }
    }

    // 断开模块预览区尺寸监听
    function trModuleDisconnectPreviewResizeObserver() {
        if (trModulePreviewResizeObserver) {
            trModulePreviewResizeObserver.disconnect();
            trModulePreviewResizeObserver = null;
        }
        if (trModulePreviewScaleRaf) {
            cancelAnimationFrame(trModulePreviewScaleRaf);
            trModulePreviewScaleRaf = 0;
        }
        trModuleLastPreviewScaleKey = '';
    }

    // 监听模块预览容器尺寸以更新缩放
    function trModuleBindPreviewResizeObserver() {
        const wrap = document.getElementById('trCustomTableWrap');
        if (!wrap || typeof ResizeObserver === 'undefined') return;
        trModuleDisconnectPreviewResizeObserver();
        trModuleLastPreviewScaleKey = '';
        trModulePreviewResizeObserver = new ResizeObserver(() => {
            if (trCustomContentKind !== 'module') return;
            if (trModulePreviewScaleRaf) cancelAnimationFrame(trModulePreviewScaleRaf);
            trModulePreviewScaleRaf = requestAnimationFrame(() => {
                trModulePreviewScaleRaf = 0;
                trModuleSyncPreviewScale();
            });
        });
        trModulePreviewResizeObserver.observe(wrap);
        trModuleSyncPreviewScale();
    }

    // 绑定模块工作区页面全部事件
    function trModuleBindPage() {
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        if (trModuleDraft) {
            trModuleDraft = trModuleNormalizePayload(trModuleDraft);
            trModuleNewRows = trModuleDraft.rows;
            trModuleNewCols = trModuleDraft.cols;
            const bindFlags = trModuleResolveTotalFlags(trModuleDraft);
            trModuleNewShowTotalCol = bindFlags.showTotalCol;
            trModuleNewShowTotalRow = bindFlags.showTotalRow;
        }
        trCustomEnsureConfirmBound();
        trCustomBindSelectorHandlers(content);
        trCustomBindManageHandlers(content);
        trModuleBindPreviewResizeObserver();
        trModuleBindEditableCells();
        trModuleBindVariableCells();
        trModuleBindVariableEditor();
        trModuleBindVarToolbar();
        content.querySelectorAll('.tr-module-preview-grid .tr-custom-editable').forEach((cell) => {
            trModuleEnsureCellFont(cell);
        });
        const titleInput = document.getElementById('trModuleTitleInput');
        const rowsInput = document.getElementById('trModuleRowsInput');
        const colsInput = document.getElementById('trModuleColsInput');
        const totalColToggleBtn = document.getElementById('trModuleTotalColToggleBtn');
        const totalRowToggleBtn = document.getElementById('trModuleTotalRowToggleBtn');
        const applyCreateBtn = document.getElementById('trModuleApplyCreateBtn');
        const cancelBtn = document.getElementById('trModuleCancelBtn');
        const saveBtn = document.getElementById('trModuleSaveBtn');
        const syncModuleInputs = () => {
            if (titleInput) trModuleNewTitle = String(titleInput.value || '').trim();
            if (rowsInput) {
                const parsed = Number(rowsInput.value);
                if (Number.isFinite(parsed) && parsed > 0) trModuleNewRows = parsed;
            }
            if (colsInput) {
                const parsed = Number(colsInput.value);
                if (Number.isFinite(parsed) && parsed > 0) trModuleNewCols = parsed;
            }
        };
        if (titleInput) titleInput.addEventListener('input', syncModuleInputs);
        if (rowsInput) rowsInput.addEventListener('input', syncModuleInputs);
        if (colsInput) colsInput.addEventListener('input', syncModuleInputs);
        const applyModuleTotalToggle = (kind) => {
            if (kind === 'col') {
                trModuleNewShowTotalCol = !trModuleNewShowTotalCol;
            } else {
                trModuleNewShowTotalRow = !trModuleNewShowTotalRow;
            }
            if (trModuleDraft) {
                trModuleDraft.showTotalCol = trModuleNewShowTotalCol;
                trModuleDraft.showTotalRow = trModuleNewShowTotalRow;
                trModuleApplyTotalFlags(trModuleDraft);
                trModuleSyncTotals(trModuleDraft);
                trModuleNewRows = trModuleDraft.rows;
                trModuleNewCols = trModuleDraft.cols;
                trModuleEmitUpdate();
            }
            trModuleLastPreviewScaleKey = '';
            trQueueRenderDOM();
        };
        if (totalColToggleBtn) {
            totalColToggleBtn.addEventListener('click', () => applyModuleTotalToggle('col'));
        }
        if (totalRowToggleBtn) {
            totalRowToggleBtn.addEventListener('click', () => applyModuleTotalToggle('row'));
        }
        if (applyCreateBtn) {
            applyCreateBtn.addEventListener('click', () => {
                syncModuleInputs();
                trModuleApplyResizeFromInputs();
                trModuleLastPreviewScaleKey = '';
                trQueueRenderDOM();
            });
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                trModuleCancelCreateSession();
                trQueueRenderDOM();
            });
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                try {
                    await trModuleSaveCurrent();
                    trScheduleWorkspaceSaveToast('保存成功', 2000);
                    trQueueRenderDOM();
                } catch (error) {
                    trCustomSetError(error && error.message ? error.message : '保存模块失败');
                    trQueueRenderDOM();
                }
            });
        }
        trFlushPendingWorkspaceSaveToast();
    }

    // 渲染自定义表格编辑工作区页面 HTML
    function trCustomRenderPage() {
        const buttonsHtml = trCustomBuildTemplateButtonsHtml();
        const sheetButtonsHtml = trCustomBuildSheetButtonsHtml();
        const displayStatus = trCustomGetDisplayStatus();
        const draftSafe = trCustomNormalizeTemplate(trCustomDraft);
        trCustomEnsureReportTables(trCustomDraft);
        const activeSection = trCustomGetActiveSection(trCustomDraft);
        const activeRows = activeSection?.rows || draftSafe.rows;
        const activeCols = activeSection?.cols || draftSafe.cols;
        const layoutMode = draftSafe.layout || 'single';
        const wrapColsClass = trCustomIsMultiLayout(draftSafe) ? '' : trCustomGetDesktopColsClass(draftSafe.cols);
        const wrapColsStyle = trCustomIsMultiLayout(draftSafe) ? '' : trCustomGetDesktopColsStyle(draftSafe.cols);
        return `
                    <div class="tr-custom-page">
                        <div class="tr-custom-toolbar tr-workspace-table${trCustomToolbarExpanded ? ' is-expanded' : ''}${trPrintSettingsMode ? ' is-print-settings-mode' : ''}">
                            <div class="tr-custom-template-group">
                                ${trBuildCustomSelectorPanelHtml()}
                            </div>
                            <div class="tr-custom-tools-toolbar">
                                <div class="tr-custom-expanded-controls">
                                    <div class="tr-custom-tools-cluster">
                                        <div class="tr-custom-size-panel">
                                            <span class="tr-custom-panel-label">新建:</span>
                                            <span class="tr-custom-size-label">行</span>
                                            <input class="tr-custom-size-input" id="trCustomRowsInput" type="number" min="${TR_CUSTOM_MIN_ROWS}" max="${TR_CUSTOM_MAX_ROWS}" value="${trCustomNewTableRows}">
                                            <span class="tr-custom-size-label">列</span>
                                            <input class="tr-custom-size-input" id="trCustomColsInput" type="number" min="${TR_CUSTOM_MIN_COLS}" max="${TR_CUSTOM_MAX_COLS}" value="${trCustomNewTableCols}">
                                            <button type="button" class="tr-custom-action-btn" id="trCustomApplySizeBtn">确定</button>
                                            <div class="tr-custom-sheet-buttons">${sheetButtonsHtml}</div>
                                        </div>
                                        <div class="tr-custom-layout-panel">
                                            <span class="tr-custom-panel-label">布局:</span>
                                            <button type="button" class="tr-custom-layout-btn tr-custom-fill-btn${layoutMode === 'year' ? ' active' : ''}" id="trCustomLayoutYearBtn">年</button>
                                            <button type="button" class="tr-custom-layout-btn tr-custom-fill-btn${layoutMode === 'month' ? ' active' : ''}" id="trCustomLayoutMonthBtn">月</button>
                                        </div>
                                        <div class="tr-custom-insert-panel${trCustomRowColMode === 'delete' ? ' is-delete-mode' : ''}">
                                            <button type="button" class="tr-custom-rowcol-toggle${trCustomRowColMode === 'delete' ? ' is-delete' : ''}" id="trCustomRowColToggleBtn" aria-pressed="${trCustomRowColMode === 'delete'}" aria-label="插入或删除模式">
                                                <span class="tr-custom-rowcol-toggle-thumb" aria-hidden="true"></span>
                                                <span class="tr-custom-rowcol-toggle-option" data-mode="insert">插入</span>
                                                <span class="tr-custom-rowcol-toggle-option" data-mode="delete">删除</span>
                                            </button>
                                            <input class="tr-custom-size-input" id="trCustomInsertInput" type="number" min="${trCustomRowColMode === 'delete' ? 1 : 2}" max="${Math.max(activeRows, activeCols)}" value="${trCustomInsertPosition}" aria-label="${trCustomRowColMode === 'delete' ? '删除位置' : '插入位置'}">
                                            <button type="button" class="tr-custom-action-btn" id="trCustomInsertRowBtn">行</button>
                                            <button type="button" class="tr-custom-action-btn" id="trCustomInsertColBtn">列</button>
                                        </div>
                                    </div>
                                    <div class="tr-custom-action-panel">
                                        <button type="button" class="tr-custom-action-btn" id="trCustomCancelBtn">取消</button>
                                        <button type="button" class="tr-custom-action-btn primary" id="trCustomSaveBtn">保存</button>
                                    </div>
                                </div>
                            </div>
                            <div class="tr-custom-create-actions">
                                ${trBuildCreateActionsHtml(false, true)}
                            </div>
                            <div class="tr-custom-status-row tr-custom-expanded-only">
                                <span class="tr-custom-status" id="trCustomStatusText" data-tone="${escapeHtml(displayStatus.tone || '')}">${escapeHtml(displayStatus.text || '')}</span>
                            </div>
                        </div>
                        <div class="tr-custom-table-wrap${trCustomToolbarExpanded ? ' is-editing' : ''}${wrapColsClass ? ` ${wrapColsClass}` : ''}" id="trCustomTableWrap"${wrapColsStyle}>${trCustomBuildEditableTableHtml(trCustomDraft)}<div class="tr-module-save-toast" aria-live="polite"></div></div>
                    </div>
                `;
    }

    // 绑定自定义表格工作区页面全部事件
    function trCustomBindPage() {
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        trModuleDisconnectPreviewResizeObserver();
        trCustomEnsureConfirmBound();
        if (trCustomSavedSnapshot === null && trCustomDraft) {
            trCustomMarkClean();
        }
        const cancelBtn = document.getElementById('trCustomCancelBtn');
        trCustomBindSelectorHandlers(content);
        trCustomBindManageHandlers(content);
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                trCustomCancelCreateSession();
                trQueueRenderDOM();
            });
        }
        const rowsInput = document.getElementById('trCustomRowsInput');
        const colsInput = document.getElementById('trCustomColsInput');
        const applySizeBtn = document.getElementById('trCustomApplySizeBtn');
        const saveBtn = document.getElementById('trCustomSaveBtn');
        const layoutYearBtn = document.getElementById('trCustomLayoutYearBtn');
        const layoutMonthBtn = document.getElementById('trCustomLayoutMonthBtn');
        const insertInput = document.getElementById('trCustomInsertInput');
        const insertRowBtn = document.getElementById('trCustomInsertRowBtn');
        const insertColBtn = document.getElementById('trCustomInsertColBtn');
        const rowColToggleBtn = document.getElementById('trCustomRowColToggleBtn');
        const removeTableBtn = document.getElementById('trCustomRemoveTableBtn');
        const syncNewTableSizeFromInput = () => {
            if (rowsInput) {
                const parsedRows = Number(rowsInput.value);
                if (Number.isFinite(parsedRows) && parsedRows > 0) {
                    trCustomNewTableRows = parsedRows;
                }
            }
            if (colsInput) {
                const parsedCols = Number(colsInput.value);
                if (Number.isFinite(parsedCols) && parsedCols > 0) {
                    trCustomNewTableCols = parsedCols;
                }
            }
        };
        const applyAddTable = () => {
            syncNewTableSizeFromInput();
            const nextRows = trCustomClamp(trCustomNewTableRows, TR_CUSTOM_MIN_ROWS, TR_CUSTOM_MAX_ROWS, TR_CUSTOM_DEFAULT_ROWS);
            const nextCols = trCustomClamp(trCustomNewTableCols, TR_CUSTOM_MIN_COLS, TR_CUSTOM_MAX_COLS, TR_CUSTOM_DEFAULT_COLS);
            if (!trCustomAddReportTable(nextRows, nextCols)) return;
            trCustomArmStatusFlash('addTable', { index: trCustomDraft.sections.length });
            trQueueRenderDOM();
        };
        const handleSizeInputEnter = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyAddTable();
            }
        };
        if (rowsInput) {
            rowsInput.addEventListener('input', syncNewTableSizeFromInput);
            rowsInput.addEventListener('change', syncNewTableSizeFromInput);
            rowsInput.addEventListener('keydown', handleSizeInputEnter);
        }
        if (colsInput) {
            colsInput.addEventListener('input', syncNewTableSizeFromInput);
            colsInput.addEventListener('change', syncNewTableSizeFromInput);
            colsInput.addEventListener('keydown', handleSizeInputEnter);
        }
        if (applySizeBtn) {
            applySizeBtn.addEventListener('click', applyAddTable);
        }
        content.querySelectorAll('.tr-custom-sheet-btn[data-sheet-index]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.sheetIndex);
                if (!Number.isInteger(idx) || idx < 0 || idx === trCustomActiveTableIndex) return;
                trCustomActiveTableIndex = idx;
                trCustomSyncPrimaryFromSection(idx);
                trCustomQueueScrollToTable(idx);
                trQueueRenderDOM();
            });
        });
        if (removeTableBtn) {
            removeTableBtn.addEventListener('click', async () => {
                await trCustomRemoveActiveTable();
                trQueueRenderDOM();
            });
        }
        const syncInsertPositionFromInput = () => {
            if (!insertInput) return;
            const parsed = Number(insertInput.value);
            if (Number.isFinite(parsed) && parsed > 0) {
                trCustomInsertPosition = parsed;
            }
        };
        if (insertInput) {
            insertInput.addEventListener('input', syncInsertPositionFromInput);
            insertInput.addEventListener('change', syncInsertPositionFromInput);
        }
        if (rowColToggleBtn) {
            rowColToggleBtn.addEventListener('click', () => {
                syncInsertPositionFromInput();
                trCustomRowColMode = trCustomRowColMode === 'delete' ? 'insert' : 'delete';
                trQueueRenderDOM();
            });
        }
        if (insertRowBtn) {
            insertRowBtn.addEventListener('click', () => {
                syncInsertPositionFromInput();
                const activeRows = trCustomGetActiveSection()?.rows || trCustomDraft?.rows || TR_CUSTOM_DEFAULT_ROWS;
                const isDelete = trCustomRowColMode === 'delete';
                if (!isDelete && trCustomInsertPosition < 2) {
                    trCustomSetError('不能在表头行之前插入');
                    trQueueRenderDOM();
                    return;
                }
                const pos = trCustomClamp(trCustomInsertPosition, isDelete ? 1 : 2, activeRows, isDelete ? 1 : 2);
                if (trCustomRowColMode === 'delete') {
                    if (!trCustomDeleteDraftRow(pos)) {
                        const totalRow = trCustomGetTotalRowIndex(trCustomDraft?.rows || TR_CUSTOM_DEFAULT_ROWS);
                        if (pos === 1 || pos === totalRow + 1) {
                            trCustomSetError('不能删除表头行或合计行');
                        } else {
                            trCustomSetError(`行数已达下限 ${TR_CUSTOM_MIN_ROWS}`);
                        }
                        trQueueRenderDOM();
                        return;
                    }
                    trQueueRenderDOM();
                    return;
                }
                if (!trCustomInsertDraftRow(pos)) {
                    trCustomSetError(`行数已达上限 ${TR_CUSTOM_MAX_ROWS}`);
                    trQueueRenderDOM();
                    return;
                }
                trQueueRenderDOM();
            });
        }
        if (insertColBtn) {
            insertColBtn.addEventListener('click', () => {
                syncInsertPositionFromInput();
                const activeCols = trCustomGetActiveSection()?.cols || trCustomDraft?.cols || TR_CUSTOM_DEFAULT_COLS;
                const isDelete = trCustomRowColMode === 'delete';
                if (!isDelete && trCustomInsertPosition < 2) {
                    trCustomSetError('不能在首列之前插入');
                    trQueueRenderDOM();
                    return;
                }
                const pos = trCustomClamp(trCustomInsertPosition, isDelete ? 1 : 2, activeCols, isDelete ? 1 : 2);
                if (trCustomRowColMode === 'delete') {
                    if (!trCustomDeleteDraftCol(pos)) {
                        if (pos === 1) {
                            trCustomSetError('不能删除首列');
                        } else {
                            trCustomSetError(`列数已达下限 ${TR_CUSTOM_MIN_COLS}`);
                        }
                        trQueueRenderDOM();
                        return;
                    }
                    trQueueRenderDOM();
                    return;
                }
                if (!trCustomInsertDraftCol(pos)) {
                    trCustomSetError(`列数已达上限 ${TR_CUSTOM_MAX_COLS}`);
                    trQueueRenderDOM();
                    return;
                }
                trQueueRenderDOM();
            });
        }
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                try {
                    await trCustomSaveCurrent();
                    trScheduleWorkspaceSaveToast('保存成功', 2000);
                    trQueueRenderDOM();
                } catch (error) {
                    trCustomSetError(error && error.message ? error.message : '保存失败');
                    trQueueRenderDOM();
                }
            });
        }
        trFlushPendingWorkspaceSaveToast();
        if (layoutYearBtn) {
            layoutYearBtn.addEventListener('click', async () => {
                const ok = await trCustomApplyYearLayout();
                if (ok) {
                    trCustomArmStatusFlash('yearLayout');
                    trQueueRenderDOM();
                }
            });
        }
        if (layoutMonthBtn) {
            layoutMonthBtn.addEventListener('click', async () => {
                const years = await trCustomEnsureSelectedYearsLoaded();
                if (!years.length) {
                    trCustomSetError('先选择年份', 'selectYears');
                    trQueueRenderDOM();
                    return;
                }
                const ok = await trCustomApplyMonthLayout();
                if (ok) {
                    trCustomArmStatusFlash('monthLayout', { count: years.length });
                    trQueueRenderDOM();
                }
            });
        }
        trCustomBindEditableCells();
        trCustomSyncSumRow();
        trCustomBindFontFitObserver();
        trCustomInitCellFonts();
        trCustomRefreshStatus();
        if (trCustomScrollToTableOnRender !== null) {
            const scrollIndex = trCustomScrollToTableOnRender;
            trCustomScrollToTableOnRender = null;
            requestAnimationFrame(() => {
                trCustomPerformScrollToTable(scrollIndex);
            });
        }
    }

    //#endregion

    //#region 总结报表 · 画出界面
    // 将 DOM 渲染请求合并到下一帧执行
    function trQueueRenderDOM() {
        if (trRenderQueued) return;
        trRenderQueued = true;
        requestAnimationFrame(() => {
            trRenderQueued = false;
            trRenderDOM();
        });
    }

    // 构建「仅显示年」总结报表表格 HTML
    function trBuildYearTable(yearsData) {
        const cats = getTrDisplayCats();
        if (trIsMobile()) {
            return trBuildMobileYearTable(yearsData, cats);
        }

        const colCount = 1 + yearsData.length + 1;
        let html = `<div class="tr-table-wrap"><table class="tr-table" style="table-layout:fixed;width:100%">${trColgroup(colCount, 84)}<thead><tr>`;
        html += '<th><button class="tr-settings-trigger" id="trSettingsBtn">⚙ 显示设置</button></th>';
        for (const yd of yearsData) {
            const tone = trGetYearTone(yd.year);
            html += `<th class="tr-year-col ${tone}">${yd.year}</th>`;
        }
        html += '<th class="tr-total-col">总额</th>';
        html += '</tr></thead><tbody>';
        for (const cat of cats) {
            const vals = yearsData.map(yd => yd.data12.reduce((a, md) => a + trGetVal(md, cat.key), 0));
            const total = vals.reduce((a, b) => a + b, 0);
            const valueCls = trValueClassByKey(cat.key, total);
            let row = `<tr class="tr-row-${cat.key}"><td class="tr-cat-hd tr-row-${cat.key}">${cat.label}</td>`;
            for (let i = 0; i < yearsData.length; i++) {
                const tone = trGetYearTone(yearsData[i].year);
                row += `<td class="${tone} tr-year-col ${valueCls}">${trFmt(vals[i])}</td>`;
            }
            row += `<td class="tr-sum ${valueCls}">${trFmt(total)}</td></tr>`;
            html += row;
        }
        const periodTotals = yearsData.map((yd) => yd.data12.reduce((sum, md) => sum + trSelectedPeriodTotal(md, cats), 0));
        html += `</tbody>${trShowTotal ? `<tfoot>${trTotalRow(periodTotals)}</tfoot>` : ''}</table></div>`;
        return html;
    }

    // 构建单年详细报表表格 HTML
    function trBuildAllTable(yd, isFirst) {
        const cats = getTrDisplayCats();
        if (trIsMobile()) {
            return trBuildMobileAllTable(yd, isFirst, cats);
        }

        const colCount = 14;
        let html = `<div class="tr-year-block"><div class="tr-year-label">${yd.year}</div>`;
        html += `<div class="tr-table-wrap"><table class="tr-table" style="table-layout:fixed;width:100%">${trColgroup(colCount, 84)}<thead><tr>`;
        if (isFirst) {
            html += '<th><button class="tr-settings-trigger" id="trSettingsBtn">⚙ 显示设置</button></th>';
        } else {
            html += '<th></th>';
        }
        for (let mi = 0; mi < MON.length; mi++) html += `<th class="tr-month-hd m-${mi + 1}">${MON[mi]}</th>`;
        html += '<th class="tr-total-col">总额</th>';
        html += '</tr></thead><tbody>';
        for (const cat of cats) {
            const vals = yd.data12.map(md => trGetVal(md, cat.key));
            const total = vals.reduce((a, b) => a + b, 0);
            html += trDataRowWithKeys(cat.label, total, vals, vals.map(() => cat.key));
        }
        html += `</tbody>${trShowTotal ? `<tfoot>${trTotalRow(yd.data12.map((md) => trSelectedPeriodTotal(md, cats)))}</tfoot>` : ''}</table></div></div>`;
        return html;
    }

    // 渲染总报表面板主内容 DOM
    function trRenderDOM() {
        const content = document.getElementById('totalReportContent');
        if (!content) return;
        content.classList.toggle('tr-mode-all', trMode === 'all' && trIsMobile());
        content.classList.toggle('tr-mode-year', trMode === 'year');
        content.classList.toggle('tr-mode-custom', trMode === 'custom');

        if (trMode === 'custom' && trCustomContentKind === 'table' && trCustomDraft) {
            trCustomSyncShellFromActiveTable();
        }

        const allYears = trGetAllYears();
        trRenderYearFilter(allYears);

        trYearCache[currentYear] = monthData;

        const visibleYears = allYears.filter((y) => trSelectedYears.includes(y));
        const yearsData = visibleYears.map(y => ({
            year: y,
            data12: trYearCache[y] || Array.from({ length: 12 }, () => ({}))
        }));

        let html = '';
        if (trMode === 'custom') {
            if (trCustomContentKind === 'module' && (trModulePendingDraft || trModuleDraft || trModulePreviewReady)) {
                html = trModuleRenderPage();
            } else if (trCustomContentKind === 'table' && (trCustomPendingDraft || trCustomDraft)) {
                html = trCustomRenderPage();
            } else {
                if (trCustomContentKind && !trCustomPendingDraft && !trModulePendingDraft) {
                    trCustomContentKind = null;
                }
                html = trCustomRenderIdlePage();
            }
        } else if (trMode === 'year') {
            html = `<div class="tr-year-block">${trBuildYearTable(yearsData)}</div>`;
        } else {
            let isFirst = true;
            for (const yd of yearsData) {
                html += trBuildAllTable(yd, isFirst);
                isFirst = false;
            }
        }

        content.innerHTML = html || '<div style="padding:20px;opacity:0.5;">暂无数据</div>';
        trRenderSettings();
        if (trMode === 'custom') {
            if (trCustomContentKind === 'module' && (trModulePendingDraft || trModuleDraft || trModulePreviewReady)) {
                trModuleBindPage();
            } else if (trCustomContentKind === 'table' && (trCustomPendingDraft || trCustomDraft)) {
                trCustomBindPage();
            } else {
                trCustomBindIdlePage();
            }
            if (!trCustomLoaded && !trCustomLoadingPromise) {
                trCustomEnsureLoaded().then(() => trQueueRenderDOM()).catch((error) => {
                    trCustomSetError(error && error.message ? error.message : '加载表格失败');
                    trQueueRenderDOM();
                });
            }
            if (!trModuleLoaded && !trModuleLoadingPromise) {
                trModuleEnsureLoaded().then(() => trQueueRenderDOM()).catch(() => { });
            }
            trFlushPendingWorkspaceSaveToast();
            return;
        }

        const settingsBtn = document.getElementById('trSettingsBtn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                trRenderSettings();
                document.getElementById('trSettingsOverlay').classList.add('active');
            });
        }
    }

    // 后台补全缺失年份数据后刷新
    async function trLoadMissingYearsBackground() {
        if (trLoading) return;
        trLoading = true;
        try {
            const allYears = trGetAllYears();
            const missingYears = allYears.filter(y => y !== currentYear && !trYearCache[y]);
            if (!missingYears.length) return;
            await Promise.all(missingYears.map(y => trEnsureYear(y)));
            trQueueRenderDOM();
        } finally {
            trLoading = false;
        }
    }

    // 首次打开总报表时快速渲染并后台加载
    function trLoadAndRender() {
        trYearCache[currentYear] = monthData;
        trQueueRenderDOM();
        trLoaded = true;
        trLoadMissingYearsBackground();
    }

    // 渲染设置弹窗中的模式与分类按钮
    function trRenderSettings() {
        const modeRow = document.getElementById('trModeRow');
        const catRow = document.getElementById('trCatRow');
        const inlineModeRow = document.getElementById('trInlineModeRow');
        const inlineCatRow = document.getElementById('trInlineCatRow');
        if (!modeRow || !catRow || !inlineModeRow || !inlineCatRow) return;

        const renderModeButtons = (host) => {
            const modeButtons = [
                { val: 'year', label: '总结报表', cls: 'month-btn m-2' },
                { val: 'all', label: '详细报表', cls: 'month-btn m-4' },
                { val: 'custom', label: '创建报表', cls: 'month-btn m-8' },
            ];
            host.innerHTML = '';
            for (const mb of modeButtons) {
                const btn = document.createElement('button');
                btn.className = mb.cls + (trMode === mb.val ? ' active' : '');
                btn.style.cssText = 'width:auto;min-width:80px;height:35px;padding:0 16px;font-size:14px;';
                btn.textContent = mb.label;
                btn.addEventListener('click', () => {
                    if (trMode === mb.val) return;
                    trSaveActiveToMode();
                    trMode = mb.val;
                    if (trMode === 'custom') {
                        trCustomResetSelectorOnModeEnter();
                    }
                    trSyncActiveFromMode();
                    saveTrPrefs();
                    trRenderSettings();
                    trQueueRenderDOM();
                });
                host.appendChild(btn);
            }
        };

        const renderCatButtons = (host) => {
            const catColors = ['m-1', 'm-2', 'm-3', 'm-5', 'm-7', 'm-9'];
            const allSelected = TR_CATS.every((cat) => trSelectedCats.includes(cat.key)) && trShowTotal;
            host.innerHTML = '';
            TR_CATS.forEach((cat, i) => {
                const btn = document.createElement('button');
                btn.className = 'month-btn ' + catColors[i] + (trSelectedCats.includes(cat.key) ? ' active' : '');
                btn.style.cssText = 'width:auto;min-width:46px;height:44px;padding:0 8px;font-size:13px;';
                btn.textContent = cat.label;
                btn.dataset.key = cat.key;
                btn.addEventListener('click', async () => {
                    if (trSelectedCats.includes(cat.key)) {
                        trSelectedCats = trSelectedCats.filter(k => k !== cat.key);
                    } else {
                        trSelectedCats.push(cat.key);
                    }
                    saveTrPrefs();
                    trRenderSettings();
                    if (trMode === 'custom') {
                        await trCustomOnSelectionChanged();
                    }
                    trQueueRenderDOM();
                });
                host.appendChild(btn);
            });

            const totalBtn = document.createElement('button');
            totalBtn.className = 'month-btn m-6' + (trShowTotal ? ' active' : '');
            totalBtn.style.cssText = 'width:auto;min-width:46px;height:44px;padding:0 8px;font-size:13px;';
            totalBtn.textContent = '总计';
            totalBtn.addEventListener('click', async () => {
                trShowTotal = !trShowTotal;
                saveTrPrefs();
                trRenderSettings();
                if (trMode === 'custom') {
                    await trCustomOnSelectionChanged();
                }
                trQueueRenderDOM();
            });
            host.appendChild(totalBtn);

            if (host === inlineCatRow) {
                const allBtn = document.createElement('button');
                allBtn.className = 'month-btn m-8' + (allSelected ? ' active' : '');
                allBtn.style.cssText = 'width:auto;min-width:46px;height:44px;padding:0 8px;font-size:13px;';
                allBtn.textContent = '全部';
                allBtn.addEventListener('click', async () => {
                    if (allSelected) {
                        trSelectedCats = [];
                        trShowTotal = false;
                    } else {
                        trSelectedCats = TR_CATS.map((cat) => cat.key);
                        trShowTotal = true;
                    }
                    saveTrPrefs();
                    trRenderSettings();
                    if (trMode === 'custom') {
                        await trCustomOnSelectionChanged();
                    }
                    trQueueRenderDOM();
                });
                host.appendChild(allBtn);
            }
        };

        renderModeButtons(modeRow);
        renderModeButtons(inlineModeRow);
        renderCatButtons(catRow);
        renderCatButtons(inlineCatRow);
    }

    //#endregion

    //#region 共用 · 打开与关闭
    const trOverlay = document.getElementById('trSettingsOverlay');
    if (trOverlay) {
        trOverlay.addEventListener('click', (e) => {
            if (e.target === trOverlay) trOverlay.classList.remove('active');
        });
    }

    const openTotalReportBtn = document.getElementById('openTotalReportBtn');
    if (openTotalReportBtn) {
        openTotalReportBtn.addEventListener('click', () => {
            openOverlay('totalReportLayer');
            requestAnimationFrame(() => {
                if (!trLoaded) {
                    trLoadAndRender();
                } else {
                    trYearCache[currentYear] = monthData;
                    trQueueRenderDOM();
                }
            });
        });
    }

    //#endregion

    //#region 共用 · 给收支页面调用
    window.__yybbqCustomTable = {
        ensureLoaded: trCustomEnsureLoaded,
        getTemplates() {
            return trCustomTemplates.map((item, index) => ({
                id: item.id,
                position: item.position,
                index: index + 1,
                updated: item.updated,
                data: trCustomCloneTemplate(item.data),
            }));
        },
        getCurrentTemplateId() {
            return trCustomCurrentId;
        },
        getCurrentDraft() {
            return trCustomCloneTemplate(trCustomDraft);
        },
        selectTemplate(id) {
            trCustomSelectTemplate(id);
            if (trMode === 'custom') trQueueRenderDOM();
        },
        getTemplateById(id) {
            const match = trCustomTemplates.find((item) => item.id === Number(id));
            return match ? trCustomCloneTemplate(match.data) : null;
        },
        getTemplateTitle(id) {
            return trCustomGetTemplateDisplayTitle(id);
        },
        getPrintHeaderToneCss() {
            return trCustomGetPrintHeaderToneCss();
        },
        renderPrintHtml(template, options = {}) {
            return trCustomBuildStaticTableHtml(template, options);
        },
        buildPaginatedPrintHtml(selections, options = {}) {
            return trCustomBuildPaginatedPrintHtml(selections, options);
        },
        getPrintPageSpec() {
            return trCustomGetPrintPageSpec();
        },
    };

    //#endregion
})();
//#endregion

//#region 库存面板

const inventoryLayer = document.getElementById('inventoryLayer');

function openInventory() {
    if (!inventoryLayer) return;
    if (window.matchMedia('(max-width: 480px)').matches) invPage = 1;
    if (typeof closeInvSettings === 'function') closeInvSettings();
    if (typeof showInvNewForm === 'function') showInvNewForm(false);
    if (invNewInput) invNewInput.value = '';
    if (invStockRecords) {
        const viewport = document.getElementById('invViewport');
        const editOverlay = viewport ? viewport.querySelector('.inv-edit-overlay') : null;
        if (editOverlay) editOverlay.remove();
        invStockRecords.querySelectorAll('.inv-detail-panel').forEach((p) => { p.hidden = true; });
        invStockRecords.querySelectorAll('.inv-detail-btn').forEach((b) => { b.textContent = '详情'; });
    }
    openOverlay('inventoryLayer');
}

const openInventoryBtn = document.getElementById('openInventoryBtn');
if (openInventoryBtn) {
    openInventoryBtn.addEventListener('click', openInventory);
}

const verifyForm = document.getElementById('verifyForm');
const verifyInput = document.getElementById('verifyInput');

function openInventoryByVerifyCode() {
    const vRaw = (verifyInput && verifyInput.value || '').trim();
    verifyInput.value = '';
    openInventory();
    if (typeof addAccessRecordByCode === 'function' && vRaw) addAccessRecordByCode(vRaw);
    if (verifyInput) verifyInput.blur();
    window.scrollTo(0, 0);
}

function isInventoryVerifyCode() {
    return verifyInput && verifyInput.value.trim().toLowerCase() === 'k';
}

document.addEventListener('submit', (e) => {
        if (e.target === verifyForm && isInventoryVerifyCode()) {
            e.preventDefault();
            e.stopPropagation();
            openInventoryByVerifyCode();
        }
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.target === verifyInput && e.key === 'Enter' && isInventoryVerifyCode()) {
            e.preventDefault();
            e.stopPropagation();
            openInventoryByVerifyCode();
        }
    }, true);

//#region 新增项目

const invNewForm = document.getElementById('invNewForm');
const invNewInput = document.getElementById('invNewInput');
const invColorDots = document.getElementById('invColorDots');
const invNewCancel = document.getElementById('invNewCancel');
const invNewOk = document.getElementById('invNewOk');
const invStockRecords = document.getElementById('invStockRecords');

const invItems = [];

const invUnits = {};

const invStock = {};

let invRecords = [];

// 本次出入库编辑中被 del 删除的项目（保存时写入记录详情）。
let invEditDeleted = [];

function formatInvTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function saveInvPanel() {
    if (typeof queueAppPrefSave !== 'function') return;
    queueAppPrefSave('inv_panel', {
        units: invUnits,
        items: invItems,
        stock: invStock,
        records: invRecords,
    });
}

let invPage = 1;

function renderInvRecords() {
    if (!invStockRecords) return;
    const isMobile = window.matchMedia('(max-width: 480px)').matches;
    invStockRecords.innerHTML = '';
    const total = invRecords.length;
    if (isMobile) {
        if (total > 0) {
            const page = Math.min(Math.max(invPage, 1), total);
            invStockRecords.appendChild(buildInvRecordBox(invRecords[page - 1]));
        }
        renderInvPager(total);
    } else {
        invRecords.forEach((rec) => {
            invStockRecords.appendChild(buildInvRecordBox(rec));
        });
    }
}


function openInvDetail(rec) {
    const vp = document.getElementById('invViewport');
    if (!vp) return;
    const oldPop = vp.querySelector('.inv-detail-pop');
    if (oldPop) oldPop.remove();
    const pop = document.createElement('div');
    pop.className = 'inv-detail-pop';
    const card = document.createElement('div');
    card.className = 'inv-detail-card';
    const typeSpan = document.createElement('span');
    typeSpan.className = 'inv-record-type';
    typeSpan.textContent = rec.type === 'panelZ' ? 'panelZ' : (rec.type === 'in' ? '入库' : '出库');
    card.appendChild(typeSpan);
    const grid = document.createElement('div');
    grid.className = 'inv-detail-grid';
    renderGroupedItems(grid, rec.changed || [], (c) => {
        const item = document.createElement('span');
        item.className = `inv-stock-btn inv-cat-${c.color}`;
        const nameEl = document.createElement('span');
        nameEl.className = 'inv-stock-name';
        nameEl.textContent = c.name;
        const qtyEl = document.createElement('span');
        qtyEl.className = 'inv-qty';
        qtyEl.textContent = c.del ? 'del' : c.qty;
        item.appendChild(nameEl);
        item.appendChild(qtyEl);
        if (['牛','羊','鸡','鸡翅'].includes(c.name)) {
            const star = document.createElement('span');
            star.className = 'inv-star';
            star.textContent = '★';
            item.appendChild(star);
        }
        return item;
    });
    card.appendChild(grid);
    pop.appendChild(card);
    vp.appendChild(pop);
    // 点击弹窗空白处关闭
    pop.addEventListener('click', (e) => { if (e.target === pop) pop.remove(); });
}

function renderInvPager(total) {
    const pager = document.getElementById('invPager');
    if (!pager) return;
    if (total < 1) {
        pager.hidden = true;
        return;
    }
    pager.hidden = false;
    pager.innerHTML =
        `<button type="button" class="inv-page-nav inv-page-prev" ${invPage <= 1 ? 'disabled' : ''}>◀</button>` +
        `<span class="inv-page-num">${invPage}/${total}</span>` +
        `<button type="button" class="inv-page-nav inv-page-next" ${invPage >= total ? 'disabled' : ''}>▶</button>`;
    const prev = pager.querySelector('.inv-page-prev');
    const next = pager.querySelector('.inv-page-next');
    if (prev) prev.addEventListener('click', () => {
        if (invPage > 1) {
            invPage--;
            renderInvRecords();
        }
    });
    if (next) next.addEventListener('click', () => {
        if (invPage < total) {
            invPage++;
            renderInvRecords();
        }
    });
}

const INV_COLOR_ORDER = ['yellow', 'blue', 'green', 'pink', 'white'];

function renderGroupedItems(container, items, buildBtn) {
    const groups = new Map();
    items.forEach((item) => {
        const key = item.color || 'white';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });
    const appendGroup = (color, list) => {
        const group = document.createElement('div');
        group.className = 'inv-cat-group';
        list.forEach((item) => group.appendChild(buildBtn(item)));
        container.appendChild(group);
    };
    INV_COLOR_ORDER.forEach((color) => {
        const list = groups.get(color);
        if (list && list.length) appendGroup(color, list);
    });
    groups.forEach((list, color) => {
        if (!INV_COLOR_ORDER.includes(color)) appendGroup(color, list);
    });
}

function updateInvKindCount() {
    const el = document.getElementById('invKindCount');
    if (el) el.textContent = '种类: ' + invItems.length;
}

function buildInvRecordBox(rec) {
    const box = document.createElement('div');
    const typeClass = rec.type === 'in' ? 'inv-record-in' : (rec.type === 'out' ? 'inv-record-out' : 'inv-record-panelz');
    box.className = `inv-stock-box ${typeClass}`;

    const head = document.createElement('div');
    head.className = 'inv-record-head';
    const timeEl = document.createElement('div');
    timeEl.className = 'inv-update-time';
    const timeLabel = rec.type === 'in' ? '入库时间:' : (rec.type === 'out' ? '出库时间:' : '更新时间:');
    timeEl.textContent = `${timeLabel}${rec.time}`;
    head.appendChild(timeEl);

    if (rec.type === 'in' || rec.type === 'out' || rec.type === 'panelZ') {
        const summary = document.createElement('div');
        summary.className = 'inv-record-summary';

        const panel = document.createElement('div');
        panel.className = 'inv-detail-panel';
        panel.hidden = true;
        const typeSpan = document.createElement('span');
        typeSpan.className = 'inv-record-type';
        typeSpan.textContent = rec.type === 'panelZ' ? 'panelZ' : (rec.type === 'in' ? '入库' : '出库');
        panel.appendChild(typeSpan);
        (rec.changed || []).forEach((c) => {
            const item = document.createElement('span');
            item.className = `inv-stock-btn inv-cat-${c.color}`;
            item.textContent = c.del ? `${c.name} del` : `${c.name}${c.qty}`;
            panel.appendChild(item);
        });
        summary.appendChild(panel);

        const detailBtn = document.createElement('button');
        detailBtn.type = 'button';
        detailBtn.className = 'inv-detail-btn';
        detailBtn.textContent = '详情';
        summary.appendChild(detailBtn);

        detailBtn.addEventListener('click', () => {
            openInvDetail(rec);
        });
        head.appendChild(summary);
    }
    box.appendChild(head);

    const list = document.createElement('div');
    list.className = 'inv-stock-list';
    let items;
    if (Array.isArray(rec.items) && rec.items.length) {
        items = rec.items;
    } else if (rec.stock && typeof rec.stock === 'object') {
        items = Object.keys(rec.stock).map((name) => {
            const cur = invItems.find((it) => it.name === name);
            return { name, color: cur ? cur.color : 'white' };
        });
    } else {
        items = invItems;
    }
    renderGroupedItems(list, items, (item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `inv-stock-btn inv-cat-${item.color}`;
        btn.innerHTML = `<span class="inv-stock-name">${escapeHtml(item.name)}</span><span class="inv-qty">${rec.stock[item.name] || 0}</span>` + (['牛','羊','鸡','鸡翅'].includes(item.name) ? '<span class="inv-star">★</span>' : '');
        return btn;
    });
    box.appendChild(list);
    return box;
}

(async () => {
    if (typeof loadAppPref !== 'function') return;
    const prefs = await loadAppPref('inv_panel');
    if (prefs && typeof prefs === 'object') {
        if (Array.isArray(prefs.items) && prefs.items.length) {
            invItems.length = 0;
            prefs.items.forEach((it) => {
                if (it && it.name) invItems.push({ name: String(it.name), color: String(it.color || 'white') });
            });
        }
        if (prefs.units && typeof prefs.units === 'object') {
            Object.entries(prefs.units).forEach(([name, val]) => {
                const v = Number(val);
                if (name && !isNaN(v) && v > 0) invUnits[name] = v;
            });
        }
        if (prefs.stock && typeof prefs.stock === 'object') {
            Object.entries(prefs.stock).forEach(([name, val]) => {
                const v = Number(val);
                if (name && !isNaN(v) && v >= 0) invStock[name] = v;
            });
        }
        if (Array.isArray(prefs.records)) {
            invRecords = prefs.records
                .filter((r) => r && r.time)
                .map((r) => ({
                    time: String(r.time),
                    type: String(r.type || 'in'),
                    changed: Array.isArray(r.changed) ? r.changed : [],
                    stock: (r.stock && typeof r.stock === 'object') ? r.stock : {},
                    items: Array.isArray(r.items) ? r.items : null,
                    srcKey: r.srcKey ? String(r.srcKey) : null,
                }));
        }
    }
    renderInvRecords();
    updateInvKindCount();
})();

function getInvUnit(name) {
    return invUnits[name] || 1;
}

let invSelectedColor = null;

const invNewBtn = document.getElementById('invNewBtn');
invNewBtn.addEventListener('click', () => showInvNewForm(true));

function showInvNewForm(show) {
    invNewForm.hidden = !show;
    if (show) {
        invNewInput.value = '';
        invSelectedColor = null;
        invColorDots.querySelectorAll('.inv-dot').forEach((d) => d.classList.remove('selected'));
        invNewInput.focus();
    }
}

invColorDots.addEventListener('click', (e) => {
    const dot = e.target.closest('.inv-dot');
    if (!dot) return;
    invColorDots.querySelectorAll('.inv-dot').forEach((d) => d.classList.remove('selected'));
    dot.classList.add('selected');
    invSelectedColor = dot.dataset.color;
});

invNewCancel.addEventListener('click', () => showInvNewForm(false));

invNewOk.addEventListener('click', () => {
    const name = invNewInput.value.trim();
    if (!name || !invSelectedColor) return;

    invItems.push({ name, color: invSelectedColor });
    saveInvPanel();
    updateInvKindCount();
    showInvNewForm(false);
    showGlobalSaveToast('保存成功', 100002, 2000);
});

//#endregion

//#region 入库 / 出库

function createInvEditBox(type) {
    const box = document.createElement('div');
    box.className = `inv-stock-box inv-edit-box ${type === 'in' ? 'inv-edit-in' : 'inv-edit-out'}`;
    box.dataset.mode = 'quick';

    const head = document.createElement('div');
    head.className = 'inv-edit-head';
    const title = document.createElement('div');
    title.className = 'inv-edit-title';
    const label = document.createElement('span');
    label.className = 'inv-edit-label-text';
    label.textContent = type === 'in' ? '入库' : '出库';
    const manualBtn = document.createElement('button');
    manualBtn.type = 'button';
    manualBtn.className = 'inv-edit-manual';
    manualBtn.textContent = '手动输入';
    title.appendChild(label);
    title.appendChild(manualBtn);
    head.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'inv-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'inv-edit-save';
    saveBtn.textContent = '保存';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'inv-edit-cancel';
    cancelBtn.textContent = '取消';
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    box.appendChild(head);

    const list = document.createElement('div');
    list.className = 'inv-stock-list';
    renderGroupedItems(list, invItems, (item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `inv-stock-btn inv-cat-${item.color}`;
        btn.dataset.name = item.name;
        btn.innerHTML =
            `<span class="inv-settings-name">${escapeHtml(item.name)}</span>` +
            `<span class="inv-settings-qty">0</span>` +
            (['牛','羊','鸡','鸡翅'].includes(item.name) ? '<span class="inv-star">★</span>' : '');
        return btn;
    });
    box.appendChild(list);
    box.appendChild(actions);

    // 快速录入：点任意位置一次 + 一个单位
    list.addEventListener('click', (e) => {
        if (box.dataset.mode === 'manual') return;
        const btn = e.target.closest('.inv-stock-btn[data-name]');
        if (!btn) return;
        const qtyEl = btn.querySelector('.inv-settings-qty');
        if (!qtyEl) return;
        qtyEl.textContent = Number(qtyEl.textContent || 0) + getInvUnit(btn.dataset.name);
        box.dataset.dirty = '1';
    });

    // 手动输入：显示所有输入框；再点收起并保存已输入数字，返回快速录入
    manualBtn.addEventListener('click', () => {
        if (box.dataset.mode === 'manual') {
            exitInvManualMode(box);
            box.dataset.mode = 'quick';
            manualBtn.textContent = '手动输入';
        } else {
            enterInvManualMode(box);
            box.dataset.mode = 'manual';
            manualBtn.textContent = '快速录入';
        }
    });

    saveBtn.addEventListener('click', () => {
        // 手动输入模式：第一次保存只收起输入框、保存已输入数字，返回快速录入
        if (box.dataset.mode === 'manual') {
            exitInvManualMode(box, { deleteDel: true });
            box.dataset.mode = 'quick';
            manualBtn.textContent = '手动输入';
            return;
        }
        saveInvEdit(type);
        (box.closest('.inv-edit-overlay') || box).remove();
        showGlobalSaveToast('保存成功', 100002, 2000);
    });
    cancelBtn.addEventListener('click', () => (box.closest('.inv-edit-overlay') || box).remove());

    return box;
}

function enterInvManualMode(box) {
    box.querySelectorAll('.inv-stock-btn[data-name]').forEach((btn) => {
        const qtyEl = btn.querySelector('.inv-settings-qty');
        if (!qtyEl) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.name = 'inv_edit_qty';
        input.className = 'inv-settings-unit';
        input.value = qtyEl.textContent;
        input.addEventListener('input', () => { box.dataset.dirty = '1'; });
        // 点击输入框自动选中已有数字，可直接覆盖
        input.addEventListener('click', () => input.select());
        input.addEventListener('focus', () => input.select());
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        });
        qtyEl.replaceWith(input);
    });
}

function exitInvManualMode(box, options) {
    box.querySelectorAll('.inv-stock-btn[data-name]').forEach((btn) => {
        const input = btn.querySelector('.inv-settings-unit');
        if (!input) return;
        // 入库/出库：输入框填 del / DEL（忽略大小写）→ 保存时删除此项目
        if (options && options.deleteDel && input.value.trim().toLowerCase() === 'del') {
            const name = btn.dataset.name;
            const idx = invItems.findIndex((it) => it.name === name);
            if (idx >= 0) {
                invEditDeleted.push({ name, color: invItems[idx].color });
                invItems.splice(idx, 1);
                delete invStock[name];
                delete invUnits[name];
                saveInvPanel();
                updateInvKindCount();
            }
            btn.remove();
            return;
        }
        const span = document.createElement('span');
        span.className = 'inv-settings-qty';
        const v = parseFloat(input.value.replace(/[^0-9.]/g, ''));
        span.textContent = (isNaN(v) || v < 0) ? 0 : v;
        input.replaceWith(span);
    });
}

function openInvEdit(type) {
    invEditDeleted = [];
    const viewport = document.getElementById('invViewport');
    const existing = viewport ? viewport.querySelector('.inv-edit-overlay') : null;
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'inv-edit-overlay';
    const box = createInvEditBox(type);

    overlay.appendChild(box);
    if (viewport) viewport.prepend(overlay);
    box.scrollIntoView({ block: 'nearest' });
}

function saveInvEdit(type) {
    const changed = [];
    document.querySelectorAll('.inv-edit-box .inv-stock-btn[data-name]').forEach((btn) => {
        const name = btn.dataset.name;
        const qtyEl = btn.querySelector('.inv-settings-qty');
        const qtyVal = qtyEl ? Number(qtyEl.textContent) || 0 : 0;
        const prev = invStock[name] || 0;
        const next = type === 'in' ? prev + qtyVal : Math.max(0, prev - qtyVal);
        if (qtyVal > 0) {
            const invItem = invItems.find((it) => it.name === name);
            changed.push({ name, qty: qtyVal, color: invItem ? invItem.color : 'white' });
        }
        invStock[name] = next;
    });

    // 本次 del 删除的项目：在记录详情中以“name del”显示
    invEditDeleted.forEach((d) => {
        changed.push({ name: d.name, qty: 'del', color: d.color, del: true });
    });

    const stock = {};
    invItems.forEach((it) => { stock[it.name] = invStock[it.name] || 0; });
    invRecords.unshift({
        time: formatInvTime(new Date()),
        type,
        changed,
        stock,
        items: invItems.map((it) => ({ name: it.name, color: it.color })),
    });
    if (window.matchMedia('(max-width: 480px)').matches) invPage = 1;
    renderInvRecords();
    saveInvPanel();
}

document.getElementById('invInBtn').addEventListener('click', () => openInvEdit('in'));
document.getElementById('invOutBtn').addEventListener('click', () => openInvEdit('out'));

//#endregion

//#region 单位数量设置

const invSettingsOverlay = document.getElementById('invSettingsOverlay');
const invSettingsList = document.getElementById('invSettingsList');

function openInvSettings() {
    invSettingsList.innerHTML = '';
    renderGroupedItems(invSettingsList, invItems, (item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `inv-stock-btn inv-cat-${item.color}`;
        btn.dataset.name = item.name;
        btn.innerHTML =
            `<span class="inv-settings-name">${escapeHtml(item.name)}</span>` +
            `<span class="inv-settings-qty">${getInvUnit(item.name)}</span>` +
            (['牛','羊','鸡','鸡翅'].includes(item.name) ? '<span class="inv-star">★</span>' : '');
        return btn;
    });
    invSettingsOverlay.classList.add('active');
}

invSettingsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.inv-stock-btn[data-name]');
    if (!btn) return;
    if (btn.querySelector('input.inv-settings-unit')) return;
    const qtyEl = btn.querySelector('.inv-settings-qty');
    if (!qtyEl) return;
    const oldVal = qtyEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'inv_settings_unit';
    input.className = 'inv-settings-unit';
    input.value = oldVal;
    qtyEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        const v = parseFloat(input.value.replace(/[^0-9.]/g, ''));
        const span = document.createElement('span');
        span.className = 'inv-settings-qty';
        span.textContent = isNaN(v) ? oldVal : v;
        input.replaceWith(span);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            input.blur();
        }
    });
});

function closeInvSettings() {
    invSettingsOverlay.classList.remove('active');
}

document.getElementById('invSettingsBtn').addEventListener('click', openInvSettings);
document.getElementById('invSettingsCancel').addEventListener('click', closeInvSettings);
document.getElementById('invSettingsOk').addEventListener('click', () => {
    invSettingsList.querySelectorAll('.inv-stock-btn[data-name]').forEach((item) => {
        const input = item.querySelector('input.inv-settings-unit');
        const raw = input ? input.value : item.querySelector('.inv-settings-qty').textContent;
        const v = parseInt(raw, 10);
        if (!isNaN(v) && v > 0) {
            invUnits[item.dataset.name] = v;
        } else {
            delete invUnits[item.dataset.name];
        }
    });
    saveInvPanel();
    closeInvSettings();
    showGlobalSaveToast('保存成功', 100002, 2000);
});
invSettingsOverlay.addEventListener('click', (e) => {
    if (e.target === invSettingsOverlay) closeInvSettings();
});

//#endregion

//#region 完整记录

const invFullBtn = document.getElementById('invFullBtn');
const invFullLayer = document.getElementById('invFullLayer');
const invFullTable = document.getElementById('invFullTable');
const invFullClose = document.getElementById('invFullClose');

// 汇总所有出现过/当前存在的项目（保持当前项目顺序在前）。
function collectInvFullItems() {
    const map = new Map();
    invItems.forEach((it) => { map.set(it.name, it.color); });
    invRecords.forEach((rec) => {
        (rec.items || []).forEach((it) => {
            if (it && it.name && !map.has(it.name)) map.set(it.name, it.color);
        });
    });
    const items = Array.from(map, ([name, color]) => ({ name, color }));
    // 同色连在一起，按 INV_COLOR_ORDER 颜色顺序分组
    const ordered = [];
    INV_COLOR_ORDER.forEach((color) => {
        items.forEach((it) => { if (it.color === color) ordered.push(it); });
    });
    items.forEach((it) => { if (INV_COLOR_ORDER.indexOf(it.color) === -1) ordered.push(it); });
    return ordered;
}

function shortInvFullTime(t) {
    return String(t || '').replace(/^\d{4}\//, '');
}

function openInvFull() {
    if (!invFullLayer) return;
    const items = collectInvFullItems();
    const records = invRecords.slice(); // invRecords[0] 即最新，直接使用保持最新在上
    // 行列对换：项目为行（同色分组，组间空行），记录时间为列
    const rowEntries = items.slice();
    const colCls = (rec) => rec.type === 'in' ? 'inv-full-col-in' : (rec.type === 'out' ? 'inv-full-col-out' : 'inv-full-col-panelz');
    let html = '<div class="inv-full-grid">';
    // 第一列：项目名
    html += '<div class="inv-full-col-first">';
    html += '<div class="inv-full-head"></div>';
    rowEntries.forEach((en) => {
        const star = ['牛','羊','鸡','鸡翅'].includes(en.name) ? '<span class="inv-star">★</span>' : '';
        html += `<div class="inv-full-cell"><span class="inv-stock-btn inv-cat-${en.color}">${escapeHtml(en.name)}${star}</span></div>`;
    });
    html += '</div>';
    // 数据列统一放进独立滚动容器，横向滚动时类名列不重叠、不遮挡
    html += '<div class="inv-full-cols">';
    // 每个记录一列：整列单一背景（从日期行下方开始）
    records.forEach((rec, ri) => {
        const older = records[ri + 1];
        const headColor = `hsl(${(ri * 137) % 360},65%,82%)`;
        html += `<div class="inv-full-col">`;
        html += `<div class="inv-full-head"> <span class="inv-stock-btn inv-full-time" style="background:${headColor}">${escapeHtml(shortInvFullTime(rec.time))}</span></div>`;
        html += `<div class="inv-full-col-body ${colCls(rec)}">`;
        rowEntries.forEach((en) => {
            const q = (rec.stock && rec.stock[en.name] != null) ? rec.stock[en.name] : 0;
            let diffMark = '';
            if (older) {
                const prevQ = (older.stock && older.stock[en.name] != null) ? older.stock[en.name] : 0;
                const diff = q - prevQ;
                if (diff !== 0) {
                    diffMark = `<span class="inv-full-diff ${diff > 0 ? 'inv-diff-pos' : 'inv-diff-neg'}">${diff > 0 ? '+' : ''}${diff}</span>`;
                }
            }
            html += `<div class="inv-full-cell"><span class="inv-stock-btn inv-cat-${en.color}">${q}${diffMark}</span></div>`;
        });
        html += '</div>';
        html += '</div>';
    });
    html += '</div>';
    html += '</div>';
    invFullTable.innerHTML = html;
    fitInvFullContent();
    invFullLayer.classList.add('active');
}

function fitInvFullContent() {
    const table = document.getElementById('invFullTable');
    if (!table) return;
    if (!window.matchMedia || !window.matchMedia('(max-width: 480px)').matches) return;
    const scroller = document.getElementById('invFullScroll');
    const grid = table.querySelector('.inv-full-grid');
    const first = grid ? grid.querySelector('.inv-full-col-first') : null;
    if (!scroller || !grid || !first) return;
    grid.style.transform = '';
    grid.style.transformOrigin = '';
    grid.style.height = '';
    table.style.overflow = '';
    table.style.height = '';
    const avail = scroller.clientHeight
        - ((parseFloat(getComputedStyle(scroller).paddingTop) || 0)
        + (parseFloat(getComputedStyle(scroller).paddingBottom) || 0));
    let natural = 0;
    Array.from(first.children).forEach((el) => { natural += el.getBoundingClientRect().height; });
    if (!avail || !natural) return;
    const scale = Math.min(1, avail / natural);
    if (scale >= 1) return;
    grid.style.transformOrigin = 'top left';
    grid.style.transform = `scale(${scale})`;
    grid.style.height = `${natural}px`;
    const scaledH = Math.round(natural * scale);
    table.style.height = `${scaledH}px`;
    table.style.overflow = 'hidden';
}

function closeInvFull() {
    if (invFullLayer) invFullLayer.classList.remove('active');
}

if (invFullBtn) invFullBtn.addEventListener('click', openInvFull);
if (invFullClose) invFullClose.addEventListener('click', closeInvFull);
if (invFullLayer) invFullLayer.addEventListener('click', (e) => { if (e.target === invFullLayer) closeInvFull(); });
window.addEventListener('resize', () => {
    if (invFullLayer && invFullLayer.classList.contains('active')) fitInvFullContent();
});

function invFullStep(dir) {
    const scroller = document.querySelector('.inv-full-cols');
    if (!scroller) return;
    const cols = scroller.querySelectorAll('.inv-full-col');
    if (cols.length < 2) return;
    const step = cols[1].offsetLeft - cols[0].offsetLeft;
    const max = scroller.scrollWidth - scroller.clientWidth;
    let target = Math.max(0, Math.min(max, Math.round(scroller.scrollLeft / step + dir) * step));
    scroller.scrollTo({ left: target, behavior: 'auto' });
}

const invFullPrev = document.getElementById('invFullPrev');
const invFullNext = document.getElementById('invFullNext');
if (invFullPrev) invFullPrev.addEventListener('click', () => invFullStep(-1));
if (invFullNext) invFullNext.addEventListener('click', () => invFullStep(1));

//#endregion

//#region Panel-Z 联动出库

function qzRecordKey(rec) {
    return [rec && rec.date, rec && rec.beef, rec && rec.lamb, rec && rec.chicken, rec && rec.wing].join('|');
}

function applyPanelZOutRecord(rec) {
    const keys = [['牛', 'beef'], ['羊', 'lamb'], ['鸡', 'chicken'], ['鸡翅', 'wing']];
    const changed = [];
    keys.forEach(([name, key]) => {
        const q = Number(rec && rec[key]) || 0;
        if (q > 0) {
            invStock[name] = Math.max(0, (invStock[name] || 0) - q);
            const invItem = invItems.find((it) => it.name === name);
            changed.push({ name, qty: q, color: invItem ? invItem.color : 'white' });
        }
    });
    if (changed.length === 0) return;

    const stock = {};
    invItems.forEach((it) => { stock[it.name] = invStock[it.name] || 0; });
    invRecords.unshift({
        time: formatInvTime(new Date()),
        type: 'panelZ',
        changed,
        stock,
        items: invItems.map((it) => ({ name: it.name, color: it.color })),
        srcKey: qzRecordKey(rec),
    });
    if (window.matchMedia('(max-width: 480px)').matches) invPage = 1;
    renderInvRecords();
    saveInvPanel();
}

(function watchPanelZ() {
    const orig = window.qzSaveLocal;
    if (typeof orig === 'function') {
        let prevKeys = null;
        const setBaseline = () => {
            if (prevKeys) return;
            prevKeys = new Set((Array.isArray(window.qzData) ? window.qzData : []).map(qzRecordKey));
        };
        const waitBaseline = () => {
            if (window.qzLoaded) {
                setBaseline();
            } else {
                setTimeout(waitBaseline, 200);
            }
        };
        waitBaseline();
        window.qzSaveLocal = function () {
            setBaseline();
            const before = prevKeys;
            const result = orig.apply(this, arguments);
            const after = new Set((Array.isArray(window.qzData) ? window.qzData : []).map(qzRecordKey));

            const removed = [];
            before.forEach((k) => { if (!after.has(k)) removed.push(k); });
            const added = [];
            after.forEach((k) => { if (!before.has(k)) added.push(k); });

            if (removed.length && invRecords.length) {
                const lenBefore = invRecords.length;
                invRecords = invRecords.filter((r) => !(r.type === 'panelZ' && r.srcKey && removed.indexOf(r.srcKey) !== -1));
                if (invRecords.length !== lenBefore) {
                    renderInvRecords();
                    saveInvPanel();
                }
            }
            if (added.length) {
                const byKey = new Map((Array.isArray(window.qzData) ? window.qzData : []).map((r) => [qzRecordKey(r), r]));
                added.forEach((k) => {
                    const rec = byKey.get(k);
                    if (rec) applyPanelZOutRecord(rec);
                });
            }
            prevKeys = after;
            return result;
        };
    }

    const origAppend = window.qzAppendRecordToYear;
    if (typeof origAppend === 'function') {
        window.qzAppendRecordToYear = function (targetYear, rec) {
            applyPanelZOutRecord(rec);
            return origAppend.apply(this, arguments);
        };
    }
})();

//#endregion

//#region ESC 键

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const settingsActive = invSettingsOverlay && invSettingsOverlay.classList.contains('active');
    const hasActiveLayer = !!document.querySelector('.modal-layer.active');
    if (settingsActive) {
        e.preventDefault();
        e.stopPropagation();
        closeInvSettings();
        return;
    }
    const verifyOverlay = document.getElementById('verifyOverlay');
    const mainPanelVisible = verifyOverlay && verifyOverlay.classList.contains('hidden') && !hasActiveLayer;
    if (mainPanelVisible && typeof returnToVerifyPanel === 'function') {
        e.preventDefault();
        e.stopPropagation();
        returnToVerifyPanel();
    }
}, true);

//#endregion

//#region 弹窗外关闭


document.addEventListener('click', (e) => {
    const eb = invViewport ? invViewport.querySelector('.inv-edit-box') : null;
    // 有改动时禁用“点击空白处关闭”，防止手抖点空丢数据
    if (eb && !eb.contains(e.target) && eb.dataset.dirty !== '1') {
        (eb.closest('.inv-edit-overlay') || eb).remove();
        return;
    }
    if (!window.matchMedia('(max-width: 480px)').matches) return;
    const overlay = document.getElementById('invSettingsOverlay');
    if (overlay && overlay.classList.contains('active') && !overlay.contains(e.target)) {
        closeInvSettings();
        return;
    }
    const form = document.getElementById('invNewForm');
    if (form && !form.hidden && (e.target === form || !form.contains(e.target))) {
        showInvNewForm(false);
        return;
    }
    const pop = invViewport ? invViewport.querySelector('.inv-detail-pop') : null;
    if (pop && (e.target === pop || !pop.contains(e.target))) {
        pop.remove();
    }
}, true);

//#endregion

//#endregion

//#region 导入面板
(function () {
    'use strict';

    var container = document.getElementById('importBody');
    if (!container) return;

    function boot() {
    var layer = document.getElementById('importLayer') || container;
    var $ = function (id) {
        var el = layer.querySelector('#' + id);
        if (!el) el = container.querySelector('#' + id);
        return el;
    };
    var statusEl = $('ipStatus'), resultView = $('ipResult'),
        compareView = $('ipCompare'), cLeft = $('ipLeft'), cRight = $('ipRight'),
        fileInput = $('ipFile'), pickBtn = $('ipPick'),
        toggleDrop = $('ipToggle'), closeCompareBtn = $('ipClose');
    var historyView = $('ipHistory');

    var lastFmt = null;
    var importReady = false;
    var coloredOnly = false;
    var rightMeta = [];
    var visibleKeep = [];
    var checkBtn = null;
    var checkList = [];
    var lastCheckReport = null;
    var lastPdfDoc = null;
    var thumbCache = {};
    var scanSessionId = 0;
    var currentScanPromise = null;
    var checkButtonState = { hidden: true, disabled: false, text: '支票图片' };

    function applyCheckButtonState() {
        if (!checkBtn) return;
        checkBtn.hidden = !!checkButtonState.hidden;
        checkBtn.disabled = !!checkButtonState.disabled;
        checkBtn.textContent = checkButtonState.text || '支票图片';
    }
    function setCheckButtonState(hidden, disabled, text) {
        checkButtonState = { hidden: !!hidden, disabled: !!disabled, text: text || '支票图片' };
        applyCheckButtonState();
    }
    function clearChecks() {
        (checkList || []).forEach(function (c) { if (c.url && /^blob:/i.test(c.url)) URL.revokeObjectURL(c.url); });
        checkList = [];
        lastCheckReport = null;
        setCheckButtonState(true, false, '支票图片');
    }
    function applyChecks(items) {
        clearChecks();
        (items || []).forEach(function (it, i) {
            var no = it.no || '';
            checkList.push({
                name: '支票' + String(i + 1).padStart(3, '0') + (no ? ' - ' + no : ''),
                no: no,
                caption: it.caption || '',
                url: it.dataUrl || ''
            });
        });
    }

    var openBtn = document.getElementById('importBtn');
    if (openBtn) {
        openBtn.addEventListener('click', function () {
            if (typeof window.openOverlay === 'function') {
                try { window.openOverlay('importLayer'); } catch (_) { }
            }
        });
    }

    var actionsEl = document.getElementById('importActions');
    var saveBtn = document.getElementById('importSaveBtn');
    var clearBtn = document.getElementById('importClearBtn');
    var setActions = function (show) {
        if (actionsEl) actionsEl.classList.toggle('show', !!show);
        var layer = document.getElementById('importLayer');
        if (layer) layer.classList.toggle('import-ready', !!show);
    };
    setActions(false);
    var setImportEnabled = function (ok) {
        if (saveBtn) saveBtn.disabled = !ok;
    };
    if (saveBtn) {
        saveBtn.addEventListener('click', function () {
            if (importReady) showImportConfirm();
            else pickBtn.click();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            window.resetImportPanel();
        });
    }
    
    function releasePreview() {
        scanSessionId++;
        currentScanPromise = null;
        if (lastPdfDoc) { try { lastPdfDoc.destroy(); } catch (_) { } lastPdfDoc = null; }
        thumbCache = {};
        clearChecks();
        lastFmt = null;
        lastCheckReport = null;
        rightMeta = [];
        closeCheckLayer();
    }

    window.resetImportPanel = function () {
        importReady = false;
        pickBtn.textContent = '选择文件';
        if (fileInput) fileInput.value = '';
        if (statusEl) statusEl.textContent = '';
        if (resultView) resultView.hidden = true;
        if (compareView) compareView.hidden = true;
        if (layer) {
            var mh = layer.querySelector('.panel-header .total-text');
            if (mh) mh.remove();
        }
        setActions(false);
        setImportEnabled(true);
        showHistoryView();
        releasePreview();
    };

    var ipLayer = document.getElementById('importLayer');
    var ipWasActive = !!(ipLayer && ipLayer.classList.contains('active'));
    if (ipLayer && typeof MutationObserver === 'function') {
        var ipObserver = new MutationObserver(function () {
            var now = ipLayer.classList.contains('active');
            if (now === ipWasActive) return;
            ipWasActive = now;
            window.resetImportPanel();
        });
        ipObserver.observe(ipLayer, { attributes: true, attributeFilter: ['class'] });
    }

    // #region 导入记录（历史）
    var HISTORY_KEY = 'import_history';
    var historyList = [];

    function loadImportHistory() {
        historyList = [];
        if (typeof window.loadAppPref === 'function') {
            return window.loadAppPref(HISTORY_KEY)
                .then(function (data) {
                    historyList = (data && Array.isArray(data.list)) ? data.list.slice() : [];
                    return historyList;
                })
                .catch(function () { historyList = []; return historyList; });
        }
        return Promise.resolve(historyList);
    }

    function persistImportHistory() {
        try {
            fetchJsonSafe(LEDGER_API_BASE + '/prefs/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: HISTORY_KEY, data: { list: historyList } })
            });
        } catch (_) { }
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    function nowTime() {
        var d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
            + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    var MON_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    function monthAbbrText(s) {
        return String(s == null ? '' : s)
            .replace(/(\d{4})年(\d{1,2})月|(\d{4})-(\d{1,2})/g, function (m, y1, m1, y2, m2) {
                var y = y1 || y2, mm = Number(m1 || m2);
                return (mm >= 1 && mm <= 12) ? y + ' ' + MON_ABBR[mm - 1] : m;
            });
    }

    function makeImportRecord(fmt) {
        if (!fmt || !fmt.months || !fmt.months.length) return null;
        var months = [];
        fmt.months.forEach(function (mo) {
            var ymParts = String(mo.ym || '').split('-');
            var y = Number(ymParts[0]), m = Number(ymParts[1]);
            if (Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) months.push(mo.ym);
        });
if (!months.length) return null;
        return {
            months: months,
            time: nowTime(),
            fmt: { months: fmt.months }
        };
    }

    function openHistoryDetail(rec) {
        if (!historyView || !resultView) return;
        historyView.hidden = true;
        if (compareView) compareView.hidden = true;
        resultView.hidden = false;
        resultView.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'ip-detail-wrap';
        var body = document.createElement('div');
        body.className = 'ip-detail-body';
        wrap.appendChild(body);
        resultView.appendChild(wrap);
        if (rec.fmt && rec.fmt.months && rec.fmt.months.length) {
            renderBrief(body, rec.fmt.months, false, null, { fmt: rec.fmt }, false, undefined, true);
            setCheckButtonState(true, true, '支票图片');
            var actions = body.querySelector('.mrow-head-actions');
            if (actions) {
                var back = document.createElement('button');
                back.type = 'button';
                back.className = 'mini ip-detail-back';
                back.textContent = '返回';
                back.addEventListener('click', function () { showHistoryView(); });
                actions.insertBefore(back, actions.firstChild);
            }
        } else {
            var bar = document.createElement('div');
            bar.className = 'ip-detail-bar';
            var b2 = document.createElement('button');
            b2.type = 'button';
            b2.className = 'mini ip-detail-back';
            b2.textContent = '返回记录';
            b2.addEventListener('click', function () { showHistoryView(); });
            bar.appendChild(b2);
            body.appendChild(bar);
            var txt = document.createElement('div');
            txt.textContent = rec.text || '';
            body.appendChild(txt);
        }
    }

    function renderHistory() {
        if (!historyView) return;
        historyView.innerHTML = '';
        if (!historyList.length) {
            var empty = document.createElement('div');
            empty.className = 'import-history-empty';
            empty.textContent = '暂无导入记录';
            historyView.appendChild(empty);
            return;
        }
        historyList.forEach(function (rec) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'import-history-item';
            var icon = document.createElement('div');
            icon.className = 'import-history-icon';
            icon.textContent = '📄';
            var title = document.createElement('div');
            title.className = 'import-history-title';
            title.textContent = monthAbbrText((rec.months || []).join(' / '));
            var time = document.createElement('div');
            time.className = 'import-history-time';
            time.textContent = String(rec.time || '').replace(/-/g, '/');
            var del = document.createElement('span');
            del.className = 'import-history-del';
            del.textContent = '✕';
            del.title = '删除记录';
            del.addEventListener('click', function (ev) {
                ev.stopPropagation();
                showDelConfirm(rec);
            });
            item.appendChild(icon);
            item.appendChild(title);
            item.appendChild(time);
            icon.appendChild(del);
            item.addEventListener('click', function () { openHistoryDetail(rec); });
            historyView.appendChild(item);
        });
    }

    var delRecord = null;
    var delLayer = null, delCancelBtn = null, delOkBtn = null;

    function showDelConfirm(rec) {
        delRecord = rec;
        if (!delLayer) {
            delLayer = $('ipDelLayer');
            delCancelBtn = $('ipDelCancel');
            delOkBtn = $('ipDelOk');
            if (delCancelBtn) delCancelBtn.addEventListener('click', hideDelConfirm);
            if (delOkBtn) delOkBtn.addEventListener('click', confirmDeleteRecord);
            if (delLayer) delLayer.addEventListener('click', function (e) { if (e.target === delLayer) hideDelConfirm(); });
        }
        if (delLayer) {
            delLayer.classList.add('open');
            delLayer.setAttribute('aria-hidden', 'false');
        }
    }

    function hideDelConfirm() {
        delRecord = null;
        if (delLayer) {
            delLayer.classList.remove('open');
            delLayer.setAttribute('aria-hidden', 'true');
        }
    }

    function confirmDeleteRecord() {
        if (!delRecord) { hideDelConfirm(); return; }
        historyList = historyList.filter(function (r) { return r !== delRecord; });
        persistImportHistory();
        hideDelConfirm();
        renderHistory();
    }

    function showHistoryView() {
        if (!historyView) return;
        historyView.hidden = false;
        if (resultView) resultView.hidden = true;
        if (compareView) compareView.hidden = true;
        renderHistory();
    }
    // #endregion

    // #region 主站状态
    function ledgerState() {
        try {
            return { year: currentYear, month: currentMonth, data: monthData };
        } catch (_) {
            return { year: new Date().getFullYear(), month: new Date().getMonth(), data: null };
        }
    }
    // #endregion

    // #region PDF.js（动态加载）
    var PDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    var WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    var pdfReady = null;

    function loadPdfJs() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (pdfReady) return pdfReady;
        pdfReady = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = PDF_CDN;
            s.onload = function () { resolve(window.pdfjsLib); };
            s.onerror = function () { pdfReady = null; reject(new Error('pdf.js 加载失败，请检查网络')); };
            document.head.appendChild(s);
        });
        return pdfReady;
    }

    async function initPdfJs() {
        await loadPdfJs();
        if (!window.pdfjsLib) throw new Error('pdf.js 未加载——请确认能访问 cdnjs.cloudflare.com');
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            try {
                var resp = await fetch(WORKER_URL);
                if (resp.ok) {
                    var code = await resp.text();
                    pdfjsLib.GlobalWorkerOptions.workerSrc =
                        URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
                    return;
                }
            } catch (_) { }
            pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
        }
    }
    // #endregion

    // #region BOA 账单解析
    var MONEY = /(-?\$?[\d,]+\.\d{2})/g;
    var money = function (s) { var m = s.match(MONEY); return m ? m[m.length - 1] : null; };
    var toNum = function (t) {
        if (t == null) return null;
        var neg = /^-\$/.test(t) || (t.indexOf('-') === 0);
        var n = parseFloat(t.replace(/[$,]/g, ''));
        return isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
    };
    var fmtN = function (n) {
        if (n == null || isNaN(n)) return '';
        return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    var SHORT = function (s, n) {
        s = String(s || '').replace(/\\+$/, '').replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n) + '…' : s;
    };
    var cleanDesc = function (d) { return d.replace(/\s*(DES:|\bID:|\bPMT INFO:|\bConf#|\bConfirmation#)[\s\S]*$/i, '').trim(); };
    var descCut = function (raw) {
        var s = String(raw || '');
        var cuts = [
            s.search(/\bDES:|\bID:|\bPMT INFO:|\bConf#|\bConfirmation#|\bCKCD\b|RECURRING|Subtotal for card/i),
            s.search(/-?\$?[\d,]+\.\d{2}/),
            s.search(/\d{10,}/)
        ].filter(function (i) { return i > 0; });
        return (cuts.length ? s.slice(0, Math.min.apply(null, cuts)) : s).replace(/\s+/g, ' ').trim();
    };
    var isDateLine = function (l) { return /^\d{2}\/\d{2}\/\d{2}\b/.test(l); };
    var isNoise = function (l) { return /^(ID:|PPD\s*$|CCD\s*$|WEB\s*$|CKCD\s*$|RECURRING|Subtotal for card|Card account #|Date Description|continued on|^\* )/i.test(l.trim()); };
    var isSummaryUse = function (l) { return /Beginning balance|Ending balance|Total deposits and other credits|Total withdrawals and other debits|Total checks|Total service fees|^# of deposits\/credits:|^# of withdrawals\/debits:/i.test(l.trim()); };
    var SECTION = {
        deposits: /^Deposits and other credits/,
        withdrawals: /^Withdrawals and other debits/,
        checks: /^Checks\s*$/,
        fees: /^Service fees\s*$/,
        balances: /^Daily ledger balances/
    };
    var depCat = function (d) {
        if (/YELP|CHOWBUS/i.test(d)) return '刷卡(yelp/chowbus)';
        if (/UBER/i.test(d)) return '外卖·Uber';
        if (/RICEBALL|饭团/i.test(d)) return '外卖·饭团';
        if (/HUNGRYPANDA|熊猫/i.test(d)) return '外卖·熊猫';
        if (/BEYOND MENU/i.test(d)) return '外卖·Beyond';
        return 'others credit';
    };
    var wdCat = function (d) {
        if (/IRS|IL DEPT|CITY OF CHICAGO|SALES TAX|DEPARTMENT/i.test(d)) return '税政府';
        if (/CHOWBUS|S J DISTRIBUTOR/i.test(d)) return '账单';
        if (/BILT|Online Banking payment|CRD|CITI|AMERICAN EXPRESS|AMEX|COMCAST|COMED|XFINITY|CHIPAYPAR|VERIZON|T-MOBILE|AT&T/i.test(d)) return '账单';
        if (/CHECKCARD|PURCHASE/i.test(d)) return '借记卡';
        if (/Zelle payment to/i.test(d)) return 'zelle';
        return 'others debit';
    };
    var parseChecks = function (lines) {
        var re = /(\d{2})\/(\d{2})\/\d{2}\s+(\d{3,4})\*?\s+(-?\$?[\d,]+\.\d{2})/g;
        var cols = [];
        lines.forEach(function (l) {
            re.lastIndex = 0;
            var m, col = 0;
            while ((m = re.exec(l)) !== null) {
                (cols[col] = cols[col] || []).push({ mm: m[1], dd: m[2], no: m[3], amt: toNum(m[4]), txt: m[0] });
                col++;
            }
        });
        var out = [];
        cols.forEach(function (arr) { Array.prototype.push.apply(out, arr); });
        return out;
    };

    function formatStatement(raw) {
        var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
        var firstSummary = lines.findIndex(function (l) { return /Account summary/.test(l); });
        if (firstSummary === -1) return { text: raw, dropped: [], months: [] };
        var dropped = lines.slice(0, firstSummary);

        var periods = [];
        var cur = null;
        var range = '';
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (/Account summary/.test(l)) {
                cur = { lines: [], range: range };
                periods.push(cur);
                range = '';
                continue;
            }
            if (cur) cur.lines.push(l);
            if (/for\s+\w+\s+\d{1,2},\s*\d{4}\s+to\s+\w+\s+\d{1,2},\s*\d{4}\s+Account number/i.test(l)) range = l;
        }
        if (!periods.length) return { text: raw, dropped: [], months: [] };

        var MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
        var months = [];

        periods.forEach(function (pd, pi) {
            var L = pd.lines;
            var rM = (pd.range || '').match(/for\s+(\w+)\s+(\d{1,2}),\s*(\d{4})\s+to\s+(\w+)\s+(\d{1,2}),\s*(\d{4})/);
            var head = rM
                ? rM[3] + '年' + (MON[rM[1].slice(0, 3)] || '?') + '月（' + rM[2] + '–' + rM[5] + '日）'
                : '第 ' + (pi + 1) + ' 期';
            var headShort = rM
                ? rM[3] + '-' + (MON[rM[1].slice(0, 3)] || '?') + ' (' + rM[2] + '-' + rM[5] + ')'
                : head;
            var ym = rM ? rM[3] + '-' + String(MON[rM[1].slice(0, 3)] || '').padStart(2, '0') : '';

            var begin = null, end = null, nDep = null, nWd = null,
                tDep = null, tWd = null, tChk = null, tFee = null;
            L.forEach(function (l) {
                if (/Beginning balance/.test(l)) begin = toNum(money(l));
                else if (/Ending balance/.test(l)) end = toNum(money(l));
                else if (/Total deposits and other credits/.test(l)) tDep = toNum(money(l));
                else if (/Total withdrawals and other debits/.test(l)) tWd = toNum(money(l));
                else if (/Total checks/.test(l)) tChk = toNum(money(l));
                else if (/Total service fees/.test(l)) tFee = toNum(money(l));
                else if (/^# of deposits\/credits:\s*(\d+)/.test(l)) nDep = +l.match(/^# of deposits\/credits:\s*(\d+)/)[1];
                else if (/^# of withdrawals\/debits:\s*(\d+)/.test(l)) nWd = +l.match(/^# of withdrawals\/debits:\s*(\d+)/)[1];
            });

            var entries = { deposits: [], withdrawals: [] };
            var sec = null;
            var chkRows = [];
            var feeRows = [];
            var keepLines = [];
            var feed = function (l) {
                if (isSummaryUse(l)) return;
                if (/continued/.test(l)) { dropped.push(l); return; }
                var secStart = Object.keys(SECTION).find(function (k) { return SECTION[k].test(l.trim()); });
                if (secStart) { sec = secStart; dropped.push(l); return; }
                if (/Total deposits/.test(l) || /Total withdrawals/.test(l)) { sec = 'after'; dropped.push(l); return; }
                if (/^Total (checks|service fees)/.test(l)) { dropped.push(l); return; }
                if (sec === 'checks') { chkRows.push(l); return; }
                if (sec === 'fees') { feeRows.push(l); return; }
                if (sec === 'balances' || sec === 'after') { dropped.push(l); return; }
                if (sec !== 'deposits' && sec !== 'withdrawals') { dropped.push(l); return; }
                if (isNoise(l)) { dropped.push(l); return; }
                if (isDateLine(l)) {
                    var amt = toNum(money(l));
                    var descRaw = l.replace(/^\d{2}\/\d{2}\/\d{2}\s+/, '');
                    if (amt == null) { dropped.push(l); return; }
                    entries[sec].push({ date: l.slice(0, 5), amt: amt, desc: descCut(descRaw), sec: sec });
                    keepLines.push(l);
                } else {
                    dropped.push(l);
                }
            };
            L.forEach(feed);

            var groupCats = function (list, catFn) {
                var groups = {};
                list.forEach(function (e) {
                    var c = catFn(e.desc);
                    (groups[c] = groups[c] || []).push(e);
                });
                return Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; }).map(function (cat) {
                    return {
                        name: cat,
                        n: groups[cat].length,
                        sum: groups[cat].reduce(function (s, e) { return s + e.amt; }, 0),
                        rows: groups[cat].map(function (e) { return { date: e.date, desc: e.desc, amt: e.amt }; })
                    };
                });
            };
            var depCats = groupCats(entries.deposits, depCat);
            var wdCats = groupCats(entries.withdrawals, wdCat);
            wdCats.sort(function (a, b) {
                var pref = ['税/政府', '账单/信用卡'];
                var ka = pref.indexOf(a.name) < 0 ? 99 : pref.indexOf(a.name);
                var kb = pref.indexOf(b.name) < 0 ? 99 : pref.indexOf(b.name);
                return (ka - kb) || (b.n - a.n);
            });
            var checks = parseChecks(chkRows);
            var feeParsed = feeRows
                .map(function (l) { return { date: l.slice(0, 5), amt: toNum(money(l)) }; })
                .filter(function (x) { return /^\d{2}\/\d{2}$/.test(x.date) && x.amt != null; });
            checks.forEach(function (c) {
                if (c.txt) keepLines.push(c.txt);
            });
            var fi = 0;
            feeParsed.forEach(function (f) {
                while (fi < feeRows.length && !(feeRows[fi].slice(0, 5) === f.date && toNum(money(feeRows[fi])) === f.amt)) fi++;
                if (fi < feeRows.length) { keepLines.push(feeRows[fi]); fi++; }
            });

            var checkCountOrig = null;
            var chkCntRe = /Total\s*#\s*of\s*checks\s*:?\s*(\d+)/i;
            L.forEach(function (l) {
                var cm = l.match(chkCntRe);
                if (cm) checkCountOrig = +cm[1];
            });
            var feeNum = feeParsed.length;
            var tOrig = (nDep != null && nWd != null) ? nDep + nWd : null;
            var wdOrig = (nWd != null && checkCountOrig != null) ? nWd - checkCountOrig - feeNum : null;

            months.push({
                head: head, headShort: headShort, ym: ym, begin: begin, end: end,
                nDep: nDep, tDep: tDep, nWd: nWd, tWd: tWd, tChk: tChk, tFee: tFee,
                depOrig: nDep, wdOrig: wdOrig, chkOrig: checkCountOrig, tOrig: tOrig,
                keepLines: keepLines,
                depCats: depCats,
                wdCats: wdCats,
                checks: checks.map(function (c) { return { date: c.mm + '/' + c.dd, no: c.no, amt: c.amt }; }),
                fee: feeParsed.map(function (f) { return { date: f.date, amt: f.amt }; })
            });
        });
        return { text: raw, dropped: dropped, months: months };
    }
    // #endregion

    // #region 抽取 PDF / TXT 文本
    function orderText(items) {
        var rows = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var s = (it.str || '').replace(/\u00a0/g, ' ');
            if (!s.trim()) continue;
            var x = it.transform ? it.transform[4] : 0;
            var y = it.transform ? it.transform[5] : 0;
            var row = null;
            for (var j = 0; j < rows.length; j++) {
                if (Math.abs(rows[j].y - y) <= 1.5) { row = rows[j]; break; }
            }
            if (!row) { row = { y: y, cells: [] }; rows.push(row); }
            row.cells.push({ x: x, s: s });
        }
        rows.sort(function (a, b) { return b.y - a.y; });
        return rows.map(function (r) {
            return r.cells.sort(function (a, b) { return a.x - b.x; }).map(function (c) { return c.s; }).join(' ');
        });
    }

    async function extractPdfText(buf, onProgress) {
        var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        var lines = [];
        var pagesData = [];
        for (var p = 1; p <= pdf.numPages; p++) {
            if (onProgress) onProgress('正在提取全文：第 ' + p + ' / ' + pdf.numPages + ' 页…');
            var page = await pdf.getPage(p);
            var vp1 = page.getViewport({ scale: 1 });
            var tc = await page.getTextContent();
            lines.push.apply(lines, orderText(tc.items));
            pagesData.push({ p: p, page: page, items: tc.items, vp: vp1 });
        }
        return { text: lines.join('\n'), pages: pdf.numPages, pagesData: pagesData, pdf: pdf };
    }

    async function startBackgroundCheckScan(pagesData, sessionId) {
        if (!pagesData || !pagesData.length) return;
        setCheckButtonState(false, true, '支票图片 (0/' + pagesData.length + ')');
        setImportEnabled(false);
        var matched = [], umImgs = [], umCaps = [];
        var WANT = 2;
        for (var i = 0; i < pagesData.length; i++) {
            if (sessionId !== scanSessionId) return;
            var pg = pagesData[i];
            var p = pg.p, page = pg.page, items = pg.items, vp = pg.vp;
            setCheckButtonState(false, true, '支票图片 (' + (i + 1) + '/' + pagesData.length + ')');
            var textRows = collectTextLines(items, vp);
            var ops = await page.getOperatorList();
            var rects = collectImageRects(ops, vp);
            if (!rects.length) continue;
            var caps = [];
            textRows.forEach(function (ln) {
                columnizeRow(ln).forEach(function (g) {
                    var m = g.text.match(CHECK_CAPTION_RE);
                    if (m) {
                        caps.push({
                            no: m[1], text: g.text, x0: g.x0, x1: g.x1,
                            yTop: ln.yBot - ln.lineH * 1.6, yBot: ln.yBot, lineH: ln.lineH
                        });
                    }
                });
            });
            var res = pairPageImages(rects, caps);
            if (res.matched.length) {
                var vp2 = page.getViewport({ scale: WANT });
                var cv = document.createElement('canvas');
                cv.width = Math.ceil(vp2.width);
                cv.height = Math.ceil(vp2.height);
                await page.render({ canvasContext: cv.getContext('2d'), viewport: vp2 }).promise;
                res.matched.forEach(function (m) {
                    var r = m.img;
                    var c = document.createElement('canvas');
                    var srcW = Math.max(1, Math.round((r.x1 - r.x0) * WANT));
                    var srcH = Math.max(1, Math.round((r.y1 - r.y0) * WANT));
                    c.width = srcW;
                    c.height = srcH;
                    c.getContext('2d').drawImage(cv, r.x0 * WANT, r.y0 * WANT, srcW, srcH, 0, 0, srcW, srcH);
                    matched.push({
                        page: p,
                        no: m.cap.no,
                        caption: '#' + m.cap.no + '  ' + m.cap.text,
                        dataUrl: c.toDataURL('image/png')
                    });
                });
            }
            res.umI.forEach(function (im) {
                umImgs.push({
                    page: p,
                    x: Math.round(im.x0),
                    y: Math.round(im.y0),
                    w: Math.round(im.x1 - im.x0),
                    h: Math.round(im.y1 - im.y0)
                });
            });
            res.umC.forEach(function (c) { umCaps.push({ page: p, text: c.text.slice(0, 80) }); });
        }
        if (sessionId !== scanSessionId) return;
        applyChecks(matched);
        lastCheckReport = { umImgs: umImgs, umCaps: umCaps };
        var has = matched.length > 0;
        var un = umImgs.length;
        setCheckButtonState(false, false, has ? ('支票图片(' + matched.length + ')') : (un ? ('未认定图片(' + un + ')') : '支票图片(0)'));
        setImportEnabled(true);
    }

    var CHECK_CAPTION_RE = /(?:check|cheque|支票)\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{2,})\b/i;

    function ctmMul(m, n) {
        return [
            m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
        ];
    }

    function collectImageRects(ops, vp) {
        var IMG = new Set([
            pdfjsLib.OPS.paintImageXObject,
            pdfjsLib.OPS.paintInlineImageXObject,
            pdfjsLib.OPS.paintImageMaskXObject
        ]);
        if (pdfjsLib.OPS.paintImageXObjectRepeat) IMG.add(pdfjsLib.OPS.paintImageXObjectRepeat);
        var rects = [];
        var ctm = [1, 0, 0, 1, 0, 0];
        var stack = [];
        for (var i = 0; i < ops.fnArray.length; i++) {
            var fn = ops.fnArray[i];
            if (fn === pdfjsLib.OPS.save) { stack.push(ctm.slice()); continue; }
            if (fn === pdfjsLib.OPS.restore) { if (stack.length) ctm = stack.pop(); continue; }
            if (fn === pdfjsLib.OPS.transform) { ctm = ctmMul(ctm, ops.argsArray[i]); continue; }
            if (!IMG.has(fn)) continue;
            var a = vp.convertToViewportPoint(ctm[4], ctm[5]);
            var b = vp.convertToViewportPoint(ctm[4] + ctm[0], ctm[5] + ctm[3]);
            rects.push({
                x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]),
                x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1])
            });
        }
        return rects;
    }

    function collectTextLines(items, vp) {
        var rows = [];
        items.forEach(function (it) {
            var s = (it.str || '').replace(/\u00a0/g, ' ').trim();
            if (!s) return;
            var p = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
            var yBot = p[1];
            var row = rows.find(function (r) { return Math.abs(r.yBot - yBot) <= 3; });
            if (!row) { row = { yBot: yBot, cells: [], lineH: 0 }; rows.push(row); }
            row.cells.push({ x0: p[0], x1: p[0] + (it.width || 0) * vp.scale, s: s, h: (it.height || 0) * vp.scale });
        });
        rows.forEach(function (r) {
            r.cells.sort(function (a, b) { return a.x0 - b.x0; });
            r.lineH = Math.max.apply(null, [1].concat(r.cells.map(function (c) { return c.h || 1; })));
        });
        return rows;
    }

    function columnizeRow(row) {
        var split = Math.max(24, row.lineH * 6);
        var groups = [];
        var cur = null;
        row.cells.forEach(function (c) {
            if (cur && c.x0 - cur.x1 > split) { groups.push(cur); cur = null; }
            if (!cur) cur = { x0: c.x0, x1: c.x1, text: c.s };
            else { cur.x1 = Math.max(cur.x1, c.x1); cur.text += ' ' + c.s; }
        });
        if (cur) groups.push(cur);
        return groups;
    }

    function bandRows(items, y0f, y1f, tol) {
        var arr = items.map(function (it) { return { it: it, y0: y0f(it), y1: y1f(it) }; }).sort(function (a, b) { return a.y0 - b.y0; });
        var rows = [];
        arr.forEach(function (e) {
            if (rows.length && e.y0 - rows[rows.length - 1].y1 <= tol) {
                var r = rows[rows.length - 1];
                r.items.push(e.it);
                r.y1 = Math.max(r.y1, e.y1);
            } else {
                rows.push({ y0: e.y0, y1: e.y1, items: [e.it] });
            }
        });
        return rows;
    }

    function pairPageImages(imageRects, captions) {
        var empty = { matched: [], umI: imageRects.slice(), umC: captions.slice() };
        if (!imageRects.length || !captions.length) return empty;
        var imgRows = bandRows(imageRects, function (r) { return r.y0; }, function (r) { return r.y1; }, 3);
        var capRows = bandRows(captions, function (c) { return c.yTop; }, function (c) { return c.yBot; }, 4);
        var spanTop = function (o) { return o.yTop != null ? o.yTop : o.y0; };
        var spanBot = function (o) { return o.yBot != null ? o.yBot : o.y1; };
        var rowImg = function (o, below) {
            var top = spanTop(o), bot = spanBot(o);
            var cand = imgRows.filter(function (ir) { return below ? ir.y0 >= bot : ir.y1 <= top; });
            if (!cand.length) return null;
            return cand.reduce(function (m, r) {
                return (below ? r.y0 - bot : top - r.y1) < (below ? m.y0 - bot : top - m.y1) ? r : m;
            }, cand[0]);
        };
        var sideGap = function (cap, below) {
            var ir = rowImg(cap, below);
            if (!ir) return null;
            return below ? ir.y0 - cap.yBot : cap.yTop - ir.y1;
        };
        var gapSet = function (below) {
            var g = captions.map(function (c) { return sideGap(c, below); }).filter(function (v) { return v != null; });
            if (!g.length) return null;
            return { spread: Math.max.apply(null, g) - Math.min.apply(null, g), avg: g.reduce(function (a, b) { return a + b; }, 0) / g.length };
        };
        var gA = gapSet(true), gB = gapSet(false);
        var below = !gB || (gA && (gA.spread < gB.spread || (gA.spread === gB.spread && gA.avg <= gB.avg)));
        var usedImg = new Set(), usedCap = new Set(), matched = [];
        capRows.forEach(function (cr) {
            var ir = rowImg(cr, below);
            if (!ir) return;
            cr.items.forEach(function (cap) {
                var free = ir.items.filter(function (im) { return !usedImg.has(im); });
                if (!free.length) return;
                var center = function (im) { return (im.x0 + im.x1) / 2; };
                var best = free.reduce(function (m, im) {
                    return Math.abs(center(im) - (cap.x0 + cap.x1) / 2) < Math.abs(center(m) - (cap.x0 + cap.x1) / 2) ? im : m;
                }, free[0]);
                var ov = Math.min(best.x1, cap.x1) - Math.max(best.x0, cap.x0);
                if (ov <= 0) return;
                var gap = below ? ir.y0 - cap.yBot : cap.yTop - ir.y1;
                if (gap > Math.max(40, 8 * cap.lineH) || gap > (best.y1 - best.y0)) return;
                matched.push({ cap: cap, img: best, gap: gap });
                usedImg.add(best);
                usedCap.add(cap);
            });
        });
        return {
            matched: matched,
            umI: imageRects.filter(function (im) { return !usedImg.has(im); }),
            umC: captions.filter(function (c) { return !usedCap.has(c); })
        };
    }

    function isReadableText(text) {
        if (!text) return false;
        var weird = 0, total = 0;
        for (var i = 0; i < text.length; i++) {
            var c = text.codePointAt(i);
            if (c >= 32) total++;
            var ok = (c >= 0x20 && c <= 0x7E) || (c >= 0xA0 && c <= 0xFF) ||
                (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xFF00 && c <= 0xFFEF);
            if (!ok) weird++;
        }
        return total > 0 && weird / total < 0.05;
    }
    // #endregion

    // #region 对比视图：右栏原文上色 / 过滤
    var openCompare = function () {
        coloredOnly = false;
        toggleDrop.textContent = '隐藏过滤内容';
        if (cLeft) cLeft.style.overflowY = '';
        renderRight(false);
        resultView.hidden = true;
        compareView.hidden = false;
    };
    closeCompareBtn.addEventListener('click', function () {
        compareView.hidden = true;
        resultView.hidden = false;
    });
    cRight.addEventListener('scroll', function () {
        if (coloredOnly && cLeft) cLeft.scrollTop = cRight.scrollTop;
    });

    function ancestorScale(el) {
        var s = 1, n = el;
        while (n && n.tagName !== 'BODY') {
            var cs = getComputedStyle(n);
            var z = parseFloat(cs.zoom);
            if (z) s *= z;
            var t = cs.transform;
            if (t && t !== 'none') {
                var mM = t.match(/matrix\(([^)]+)\)/);
                if (mM) {
                    var p = mM[1].split(',');
                    var a = parseFloat(p[0]), b = parseFloat(p[1]);
                    var sc = Math.sqrt(a * a + b * b);
                    if (sc) s *= sc;
                }
            }
            n = n.parentElement;
        }
        return s;
    }

    function renderRight(coloredOnly) {
        cRight.innerHTML = '';
        if (coloredOnly) {
            var recs = visibleKeep.slice();
            var pos = 1, lastH = 0, seenRec = false;
            var pushRow = function (h, use) {
                var num = use == null ? '' : String(pos);
                var d = document.createElement('div');
                d.className = 'lx' + (use == null ? ' blank' : '');
                d.dataset.line = num;
                var hh = h && h > 0 ? h : (use != null ? lastH : 0);
                if (hh > 0) {
                    d.style.height = hh + 'px';
                    d.style.display = 'flex';
                    d.style.alignItems = 'center';
                }
                d.textContent = use == null ? ' ' : use;
                cRight.appendChild(d);
            };
            var firstRec = cLeft.querySelector('.dl:not(.cat)');
            var pad = 0;
            if (firstRec) {
                var S = ancestorScale(cRight);
                var fr = firstRec.getBoundingClientRect();
                var rr = cRight.getBoundingClientRect();
                pad = (fr.top - rr.top) / S - (cLeft.scrollTop - cRight.scrollTop);
            }
            if (pad > 0) cRight.style.paddingTop = pad + 'px';
            Array.prototype.forEach.call(cLeft.children, function (el) {
                if (el.classList.contains('mdet')) {
                    Array.prototype.forEach.call(el.children, function (d) {
                        if (d.classList.contains('cat') || d.classList.contains('gap')) {
                            if (seenRec) pushRow(d.clientHeight, null);
                        } else {
                            pushRow(d.clientHeight, recs[pos - 1]);
                            lastH = d.clientHeight;
                            seenRec = true;
                            pos++;
                        }
                    });
                } else {
                    if (seenRec) pushRow(el.clientHeight, null);
                }
            });
            while (pos <= recs.length) {
                pushRow(lastH, recs[pos - 1]);
                pos++;
            }
            return;
        }
        var n = 0;
        rightMeta.forEach(function (m) {
            n++;
            var d = document.createElement('div');
            d.className = 'lx' + (m.keep ? '' : ' drop');
            d.dataset.line = String(n);
            d.textContent = m.line || ' ';
            cRight.appendChild(d);
        });
    }

    function buildRightMeta(keepList) {
        return function (l) {
            if (keepList.length && l === keepList[0]) {
                keepList.shift();
                return { keep: true, line: l };
            }
            return { keep: false, line: l };
        };
    }

    toggleDrop.addEventListener('click', function () {
        coloredOnly = !coloredOnly;
        if (cLeft) cLeft.style.overflowY = coloredOnly ? 'hidden' : '';
        renderRight(coloredOnly);
        toggleDrop.textContent = coloredOnly ? '显示全部内容' : '隐藏过滤内容';
    });
    // #endregion

    // #region 简报渲染：默认收起，点开展开
    function renderBrief(container, months, expanded, onRaw, source, showCheck, totalText, nested) {
        container.innerHTML = '';
        if (!months || !months.length) return false;
        var catLines = function (cats) {
            return (cats || []).map(function (c) {
                return ['▸ ' + c.name + '（' + c.n + '笔　' + fmtN(c.sum) + '）']
                    .concat(c.rows.map(function (r) {
                        return '      ' + r.date + '  ' + SHORT(r.desc, 70) + '  ' + fmtN(r.amt);
                    }));
            }).reduce(function (a, b) { return a.concat(b); }, []);
        };
        var catGroups = function (cats) {
            return (cats || []).map(function (c) {
                return {
                    name: c.name,
                    n: c.n,
                    sum: c.sum,
                    rows: c.rows.map(function (r) {
                        return '      ' + r.date + '  ' + SHORT(r.desc, 70) + '  ' + fmtN(r.amt);
                    })
                };
            });
        };
        var showCount = function (parsed, orig) {
            if (orig == null) return parsed != null ? String(parsed) : null;
            return parsed !== orig ? String(parsed) + '/' + orig : String(parsed);
        };
        var mkRow = function (label, cnt, sum, detailLines) {
            var row = document.createElement('div');
            row.className = 'mrow' + (expanded ? ' static' : '');
            var arrow = document.createElement('span');
            arrow.className = 'arrow';
            arrow.textContent = expanded ? '▾' : '▸';
            var lbl = document.createElement('span');
            lbl.className = 'lbl';
            lbl.textContent = label;
            var val = document.createElement('span');
            val.className = 'val';
            val.textContent = fmtN(sum);
            var cntEl = document.createElement('span');
            cntEl.className = 'cnt';
            cntEl.textContent = cnt != null ? '(' + cnt + ')' : '';
            row.append(arrow, lbl, val, cntEl);
            var det = document.createElement('div');
            det.className = 'mdet' + (expanded ? ' open' : '');
            var grouped = detailLines && detailLines.length && typeof detailLines[0] === 'object';
            if (grouped) {
                detailLines.forEach(function (g) {
                    var hd = document.createElement('div');
                    hd.className = 'dl cat cat-hd';
                    var arr = document.createElement('span');
                    arr.className = 'carr';
                    arr.textContent = '▸';
                    var txt = document.createElement('span');
                    txt.textContent = g.name + '（' + g.n + '笔　' + fmtN(g.sum) + '）';
                    hd.appendChild(arr);
                    hd.appendChild(txt);
                    var sub = document.createElement('div');
                    sub.className = 'cat-sub';
                    (g.rows && g.rows.length ? g.rows : ['（无明细）']).forEach(function (r) {
                        var d = document.createElement('div');
                        d.className = 'dl';
                        d.textContent = r;
                        sub.appendChild(d);
                    });
                    hd.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        var open = sub.classList.toggle('open');
                        arr.textContent = open ? '▾' : '▸';
                    });
                    det.appendChild(hd);
                    det.appendChild(sub);
                });
            } else {
                (detailLines && detailLines.length ? detailLines : ['（无明细）']).forEach(function (t) {
                    var d = document.createElement('div');
                    d.className = 'dl' + (/^\s*▸/.test(t) ? ' cat' : (t === '' ? ' gap' : ''));
                    d.textContent = t;
                    det.appendChild(d);
                });
            }
            if (!expanded) {
                row.addEventListener('click', function () {
                    var open = det.classList.toggle('open');
                    arrow.textContent = open ? '▾' : '▸';
                });
            }
            container.appendChild(row);
            container.appendChild(det);
        };

        var totalHost = null;
        if (!expanded && totalText != null) {
            totalHost = document.createElement('div');
            totalHost.className = 'mrow mrow-total';
            var totalVal = document.createElement('span');
            totalVal.className = 'total-text';
            totalVal.textContent = totalText;
            totalHost.appendChild(totalVal);
            container.appendChild(totalHost);
            if (window.innerWidth <= 480 && container.parentElement) {
                container.parentElement.insertBefore(totalHost, container);
            }
        }

        months.forEach(function (mo, idx) {
            var hrow = document.createElement('div');
            hrow.className = 'mrow mrow-head' + (expanded ? ' static' : '');
            var head = document.createElement('div');
            head.className = 'mhead';
            var headL1 = document.createElement('span');
            headL1.className = 'mhead-l1';
            headL1.textContent = monthAbbrText(((window.innerWidth <= 480) && mo.headShort) ? mo.headShort : mo.head);
            var headL2 = document.createElement('span');
            headL2.className = 'mhead-l2';
            headL2.textContent = '  Beginning ' + fmtN(mo.begin) + '   Ending ' + fmtN(mo.end);
            head.append(headL1, headL2);
            hrow.appendChild(head);
            if (!expanded && idx === 0) {
                var actions = document.createElement('span');
                actions.className = 'mrow-head-actions';
                if (showCheck !== false) {
                    checkBtn = document.createElement('button');
                    checkBtn.className = 'mini mrow-check';
                    checkBtn.type = 'button';
                    checkBtn.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        openCheckLayer((source && source.fmt) || lastFmt, (source && source.checks) || checkList);
                    });
                    actions.appendChild(checkBtn);
                    applyCheckButtonState();
                }
                if (onRaw) {
                    var b = document.createElement('button');
                    b.className = 'mini mrow-raw';
                    b.textContent = '原文内容';
                    b.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        onRaw();
                    });
                    actions.appendChild(b);
                }
                (window.innerWidth <= 480 ? (totalHost || hrow) : hrow).appendChild(actions);
            }
            container.appendChild(hrow);
            if (mo.fee && mo.fee.length) {
                var feeNote = document.createElement('div');
                feeNote.className = 'import-fee';
                feeNote.textContent = '*     Monthly Fee  ' + fmtN(mo.fee.reduce(function (s, f) { return s + f.amt; }, 0));
                container.appendChild(feeNote);
            }
            mkRow('【Deposits】', showCount(mo.depCats.reduce(function (s, c) { return s + c.n; }, 0), mo.depOrig), mo.tDep, nested ? catGroups(mo.depCats) : catLines(mo.depCats));
            mkRow('【Withdrawals】', showCount((mo.wdCats || []).reduce(function (s, c) { return s + c.n; }, 0), mo.wdOrig), mo.tWd, nested ? catGroups(mo.wdCats) : catLines(mo.wdCats));
            mkRow('【Checks】', showCount(mo.checks.length, mo.chkOrig), mo.checks.reduce(function (s, c) { return s + c.amt; }, 0),
                mo.checks.map(function (c) { return '      ' + c.date + '  check ' + c.no + '  ' + fmtN(c.amt); })
                    .concat((mo.fee && mo.fee.length ? [''] : []))
                    .concat((mo.fee || []).map(function (f) { return '      ' + f.date + '  Monthly Fee  ' + fmtN(f.amt); })));
        });
        return true;
    }

    function showResult(res) {
        resultView.hidden = false;
        var months = res && res.months;
        var totalLabel = null;
        if (months && months.length) {
            var txn = months.reduce(function (a, m) {
                return a
                    + m.depCats.reduce(function (x, c) { return x + c.n; }, 0)
                    + m.wdCats.reduce(function (x, c) { return x + c.n; }, 0)
                    + m.checks.length
                    + m.fee.length;
            }, 0);
            var tAll = months.every(function (m) { return m.tOrig != null; });
            var tOrig = tAll ? months.reduce(function (a, m) { return a + m.tOrig; }, 0) : null;
            totalLabel = 'Total Trans: ' + (tOrig != null && txn !== tOrig ? txn + '/' + tOrig : txn);
        }
        if (!renderBrief(resultView, months, false, openCompare, undefined, undefined, totalLabel, true)) {
            resultView.textContent = (res && res.text) || '';
        } else if (window.innerWidth <= 480) {
            // mobile: total stays in body row with buttons; moveTotalToHeader disabled
        }
    }

    function moveTotalToHeader() {
        var hdr = layer.querySelector && layer.querySelector('.panel-header');
        if (!hdr) return;
        var old = hdr.querySelector('.total-text');
        if (old) old.remove();
        var totalText = resultView.querySelector('.mrow-total .total-text');
        if (!totalText) return;
        hdr.insertBefore(totalText, hdr.querySelector('.import-preview-title') || null);
    }

    function showCompare(res, rawLines) {
        compareView.hidden = true;
        if (!renderBrief(cLeft, res && res.months, true)) {
            cLeft.textContent = (res && res.text) || '';
        }
        visibleKeep = [];
        ((res && res.months) || []).forEach(function (m) {
            (m.keepLines || []).forEach(function (l) { visibleKeep.push(l); });
        });
        rightMeta = rawLines.map(buildRightMeta(visibleKeep.slice()));
        renderRight(coloredOnly);
    }

    async function ensureThumbUrl(u) {
        if (u.dataUrl) return u.dataUrl;
        if (!lastPdfDoc) return '';
        var key = u.page;
        if (!thumbCache[key]) {
            var page = await lastPdfDoc.getPage(u.page);
            var vp = page.getViewport({ scale: 1 });
            var cv = document.createElement('canvas');
            cv.width = Math.ceil(vp.width);
            cv.height = Math.ceil(vp.height);
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            thumbCache[key] = cv;
        }
        var base = thumbCache[key];
        var sc = Math.min(1, 260 / Math.max(u.w, u.h, 1));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(u.w * sc));
        c.height = Math.max(1, Math.round(u.h * sc));
        c.getContext('2d').drawImage(base, u.x, u.y, u.w, u.h, 0, 0, c.width, c.height);
        u.dataUrl = c.toDataURL('image/png');
        return u.dataUrl;
    }

    async function openCheckLayer(fmtArg, checksArg) {
        var grid = $('ipCheckGrid');
        var checkLayer = $('ipCheckLayer');
        if (!grid || !checkLayer) return;
        grid.innerHTML = '';
        var mkItem = function (capText, imgUrl, box) {
            var item = document.createElement('div');
            item.className = 'import-check-item';
            var cap = document.createElement('div');
            cap.className = 'import-check-cap';
            cap.textContent = capText;
            var img = document.createElement('img');
            img.src = imgUrl || '';
            item.append(cap, img);
            (box || grid).appendChild(item);
        };
        var fmt = fmtArg || lastFmt;
        var checks = checksArg || checkList;
        var months = (fmt && fmt.months) || [];
        var monthOfNo = {};
        months.forEach(function (mo) {
            (mo.checks || []).forEach(function (c) {
                if (c.no != null && monthOfNo[c.no] === undefined) monthOfNo[c.no] = mo;
            });
        });
        var used = new Set();
        var gi = 0;
        months.forEach(function (mo) {
            var group = checks.filter(function (c) { return !used.has(c) && monthOfNo[c.no] === mo; });
            if (!group.length) return;
            group.forEach(function (c) { used.add(c); });
            var h = document.createElement('div');
            h.className = 'import-check-sec';
            h.textContent = mo.head + '（' + group.length + '张）';
            grid.appendChild(h);
            group.forEach(function (c) { mkItem((++gi) + '. ' + (c.caption || c.name), c.url); });
        });
        var rest = checks.filter(function (c) { return !used.has(c); });
        if (rest.length) {
            var h = document.createElement('div');
            h.className = 'import-check-sec';
            h.textContent = '未配对月份的支票（' + rest.length + '张）';
            grid.appendChild(h);
            rest.forEach(function (c) { mkItem((++gi) + '. ' + (c.caption || c.name), c.url); });
        }
        var rep = lastCheckReport;
        if (!fmtArg && rep && ((rep.umImgs && rep.umImgs.length) || (rep.umCaps && rep.umCaps.length))) {
            var sec = document.createElement('div');
            sec.className = 'import-check-sec warn';
            var arrow = document.createElement('span');
            arrow.textContent = '▸';
            sec.appendChild(arrow);
            sec.appendChild(document.createTextNode(
                ' 未认定（程序无法确认是支票，未删除、未硬配，请人工核对）：'
                + (rep.umImgs ? rep.umImgs.length : 0) + ' 张图 / ' + (rep.umCaps ? rep.umCaps.length : 0) + ' 条标题'
                + (rep.umImgs && rep.umImgs.length ? '（缩略图按需渲染中…）' : '')
            ));
            var fold = document.createElement('div');
            fold.className = 'import-check-fold';
            sec.addEventListener('click', function () {
                var open = fold.classList.toggle('open');
                arrow.textContent = open ? '▾' : '▸';
            });
            grid.appendChild(sec);
            grid.appendChild(fold);
            for (var i = 0; i < (rep.umImgs || []).length; i++) {
                var u = rep.umImgs[i];
                var url = await ensureThumbUrl(u);
                mkItem('第' + u.page + '页 (' + u.x + ',' + u.y + ') ' + u.w + 'x' + u.h + 'pt', url, fold);
            }
            (rep.umCaps || []).forEach(function (u) {
                var n = document.createElement('div');
                n.className = 'import-check-note';
                n.textContent = '第' + u.page + '页：找到支票标题但附近没有紧邻的图 → 「' + u.text + '」';
                fold.appendChild(n);
            });
        }
        checkLayer.classList.add('open');
        checkLayer.setAttribute('aria-hidden', 'false');
    }

    function closeCheckLayer() {
        var checkLayer = $('ipCheckLayer');
        if (!checkLayer) return;
        checkLayer.classList.remove('open');
        checkLayer.setAttribute('aria-hidden', 'true');
    }

    var checkCloseBtn = $('ipCheckClose');
    if (checkCloseBtn) checkCloseBtn.addEventListener('click', closeCheckLayer);
    var checkLayerEl = $('ipCheckLayer');
    if (checkLayerEl) checkLayerEl.addEventListener('click', function (e) { if (e.target === checkLayerEl) closeCheckLayer(); });
    // #endregion

    // #region 选择文件 / 解析 / 导入
    pickBtn.addEventListener('click', function () {
        if (fileInput.files && fileInput.files.length > 0) {
            fileInput.value = '';
        }
        fileInput.click();
    });

    fileInput.addEventListener('change', async function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) {
            pickBtn.textContent = '选择文件';
            return;
        }
        var thisSession = ++scanSessionId;
        if (lastPdfDoc) { try { lastPdfDoc.destroy(); } catch (_) { } lastPdfDoc = null; }
        thumbCache = {};
        currentScanPromise = null;
        clearChecks();
        closeCheckLayer();
        pickBtn.disabled = true;
        statusEl.textContent = '正在解析：' + file.name;
        resultView.hidden = true;
        compareView.hidden = true;
        if (historyView) historyView.hidden = true;
        try {
            var raw, pagesData = null, pdfDoc = null;
            if (/\.pdf$/i.test(file.name)) {
                await initPdfJs();
                var buf = await file.arrayBuffer();
                var r = await extractPdfText(buf, function (msg) { statusEl.textContent = msg; });
                raw = r.text;
                pagesData = r.pagesData;
                pdfDoc = r.pdf;
                lastPdfDoc = pdfDoc;
            } else {
                raw = await file.text();
            }

            if (!isReadableText(raw)) {
                statusEl.textContent = '该文件没有可读文字层（扫描图片版 / 加密 / 二进制）';
                resultView.hidden = false;
                resultView.textContent = '未能提取到可读文字。请确认上传的是带文字层的银行 PDF。';
                setActions(false);
                return;
            }

            var fmt = formatStatement(raw);
            var rawLines = raw.split(/\r?\n/).map(function (l) { return l.trim(); });
            lastFmt = fmt;
            lastFmt.text = rawLines.join('\n');

            if (!fmt.months || !fmt.months.length) {
                statusEl.textContent = '未能自动识别该账单结构——完整原文已保留在结果区。';
                importReady = false;
                setActions(false);
            } else {
                statusEl.textContent = '';
                importReady = true;
                setActions(true);
                pickBtn.textContent = file.name;
                showResult(fmt);
                showCompare(fmt, rawLines);
                if (pagesData && pdfDoc) {
                    currentScanPromise = startBackgroundCheckScan(pagesData, thisSession).catch(function () {
                        setImportEnabled(true);
                        if (thisSession === scanSessionId) setCheckButtonState(false, false, '支票图片提取失败');
                    });
                }
            }
        } catch (err) {
            statusEl.textContent = '出错：' + (err && err.message ? err.message : err);
            resultView.hidden = false;
            resultView.textContent = '解析出错，见上方提示。';
            importReady = false;
            pickBtn.textContent = '选择文件';
            setActions(false);
        } finally {
            pickBtn.disabled = false;
        }
    });
    // #endregion

    // #region 导入：写入对应面板并保存
    var num = function (v) {
        var t = String(v == null ? '' : v).replace(/[\u00a0,\s]/g, '');
        if (t === '' || t === '-') return null;
        var n = parseFloat(t);
        return isFinite(n) ? n : null;
    };
    var round2 = function (n) { return Math.round(n); };

    function refreshMonthTotals(data) {
        if (!data) return;
        var others = (data.othersExpenses || []).map(function (r) { return num(r && r[1]); });
        var hasothers = others.some(function (n) { return n != null; });
        data.othersTotal = hasothers
            ? round2(others.reduce(function (s, n) { return s + (n || 0); }, 0))
            : '';
        var oth = (data.costExpenses || []).map(function (r) { return num(r && r[1]); });
        var costOthers = (data.costOthersExpenses || []).map(function (r) { return num(r && r[1]); });
        var hasOth = oth.some(function (n) { return n != null; }) || costOthers.some(function (n) { return n != null; });
        var net = hasOth ? round2(
            oth.reduce(function (s, n) { return s + (n || 0); }, 0)
            - costOthers.reduce(function (s, n) { return s + Math.abs(n || 0); }, 0)
        ) : '';
        data.costTotal = net;
        data.salesBreakdown = data.salesBreakdown || {};
        data.salesBreakdown.cost = net;
    }

    function loadYearData(year) {
        return fetchJsonSafe(LEDGER_API_BASE + '/ledger/load?year=' + encodeURIComponent(year))
            .then(function (json) {
                var arr = [];
                for (var i = 0; i < 12; i++) {
                    var d = (json && json.ok && Array.isArray(json.data)) ? json.data[i] : null;
                    arr.push(d ? JSON.parse(JSON.stringify(d)) : {});
                }
                return arr;
            })
            .catch(function () {
                var arr = [];
                for (var i = 0; i < 12; i++) arr.push({});
                return arr;
            });
    }

    function saveYearData(year, data) {
        return fetchJsonSafe(LEDGER_API_BASE + '/ledger/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year: year, data: data })
        }).then(function (json) { return !!(json && json.ok); });
    }

    async function doImportCore() {
        if (!lastFmt || !lastFmt.months || !lastFmt.months.length) return;
        var st = ledgerState();
        var curYear = st.year, currentMonth = st.month;
        var written = 0, checkCount = 0;
        var importedYears = [];

        var byYear = {};
        lastFmt.months.forEach(function (mo) {
            var ymParts = String(mo.ym || '').split('-');
            var y = Number(ymParts[0]);
            if (Number.isInteger(y) && y >= 1 && y <= 9999) {
                (byYear[y] = byYear[y] || []).push(mo);
            }
        });
        var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });

        for (var yi = 0; yi < years.length; yi++) {
            var y = years[yi];
            var data = await loadYearData(y);

            var checkMonthOfNo = {};
            byYear[y].forEach(function (moo) {
                (moo.checks || []).forEach(function (c) {
                    if (c.no != null && checkMonthOfNo[c.no] === undefined) checkMonthOfNo[c.no] = moo;
                });
            });

            var yearTouched = [];
            byYear[y].forEach(function (mo) {
                var ym2 = String(mo.ym || '').split('-');
                var m = Number(ym2[1]);
                if (!Number.isInteger(m) || m < 1 || m > 12) { return; }
                var mi = m - 1;
                var d = data[mi] = data[mi] || {};
                d.deliveryDetails = d.deliveryDetails || {};
                d.costExpenses = Array.isArray(d.costExpenses) ? d.costExpenses : [];
                d.costOthersExpenses = Array.isArray(d.costOthersExpenses) ? d.costOthersExpenses : [];
                d.othersExpenses = Array.isArray(d.othersExpenses) ? d.othersExpenses : [];
                var dlv = d.deliveryDetails;
                var dk = d.deliveryKeys = d.deliveryKeys || {};
                var ymd = function (dt) { return String(dt || '').slice(0, 5); };
                var mYear = Number(ym2[0]);
                var maxDineinRows = m === 2 ? ((mYear % 4 === 0 && mYear % 100 !== 0) || mYear % 400 === 0 ? 29 : 28) : ([4, 6, 9, 11].indexOf(m) !== -1 ? 30 : 31);
                var abs2 = function (n) { return String(Math.abs(n)); };
                var desc = function (dt) { return cleanDesc(dt); };
                var pushUnique = function (arr, row) {
                    var dup = arr.some(function (e) {
                        return Array.isArray(e) && e.length === row.length && e.every(function (v, i) { return v === row[i]; });
                    });
                    if (!dup) arr.push(row);
                    return !dup;
                };

                (mo.depCats || []).forEach(function (cat) {
                    var catName = cat.name;
                    if (catName === '刷卡(yelp/chowbus)') {
                        dk.dinein = dk.dinein || [];
                        dlv.dinein = dlv.dinein || [];
                        cat.rows.forEach(function (r) {
                            if (dlv.dinein.length >= maxDineinRows) return;
                            var key = ymd(r.date) + '\u0001' + abs2(r.amt) + '\u0001' + (desc(r.desc) || '');
                            if (dk.dinein.indexOf(key) === -1) {
                                dk.dinein.push(key);
                                dlv.dinein.push(r.date + '/' + String(mo.ym || '').split('-')[0].slice(-2) + '  ' + abs2(r.amt));
                            }
                        });
                        written += cat.rows.length;
                    } else if (catName.indexOf('外卖·') === 0) {
                        var key = '';
                        if (catName.indexOf('Uber') >= 0) key = 'uber';
                        else if (catName.indexOf('饭团') >= 0) key = 'riceball';
                        else if (catName.indexOf('熊猫') >= 0) key = 'panda';
                        else if (catName.indexOf('Beyond') >= 0) key = 'bm';
                        if (key) {
                            dk[key] = dk[key] || [];
                            dlv[key] = dlv[key] || [];
                            cat.rows.forEach(function (r) {
                                var kid = ymd(r.date) + '\u0001' + abs2(r.amt) + '\u0001' + (desc(r.desc) || '');
                                if (dk[key].indexOf(kid) === -1) {
                                    dk[key].push(kid);
                                    dlv[key].push(ymd(r.date) + '  ' + abs2(r.amt));
                                }
                            });
                            written += cat.rows.length;
                        } else {
                            cat.rows.forEach(function (r) {
                                if (pushUnique(d.costExpenses, [r.date + '  ' + desc(r.desc), abs2(r.amt)])) written++;
                            });
                        }
                    } else {
                        if (cat.rows.length) pushUnique(d.costExpenses, [cat.name, '']);
                        cat.rows.forEach(function (r) {
                            if (pushUnique(d.costExpenses, [r.date + '  ' + desc(r.desc), abs2(r.amt)])) written++;
                        });
                    }
                });
                (mo.wdCats || []).forEach(function (cat) {
                    var isWd = (cat.name === '税/政府' || cat.name === '账单/信用卡');
                    if (isWd) {
                        if (cat.rows.length) pushUnique(d.costExpenses, [cat.name, '']);
                        cat.rows.forEach(function (r) {
                            if (pushUnique(d.costExpenses, [r.date + '  ' + desc(r.desc), '-' + abs2(r.amt)])) written++;
                        });
                    } else {
                        if (cat.rows.length) pushUnique(d.costOthersExpenses, [cat.name, '']);
                        cat.rows.forEach(function (r) {
                            if (pushUnique(d.costOthersExpenses, [r.date + '  ' + desc(r.desc), abs2(r.amt)])) written++;
                        });
                    }
                });
                (mo.fee || []).forEach(function (f) {
                    if (pushUnique(d.costOthersExpenses, [f.date ? f.date + '  Monthly Fee' : 'Monthly Fee', abs2(f.amt)])) written++;
                });

                d.checkTexts = Array.isArray(d.checkTexts) ? d.checkTexts : [];
                d.checks = Array.isArray(d.checks) ? d.checks : [];
                (mo.checks || []).forEach(function (c) {
                    if (pushUnique(d.checkTexts, [((c.date || '') + (c.no != null ? '  check ' + c.no : '')).trim(), abs2(c.amt)])) checkCount++;
                });
                var moChkByNo = {};
                (mo.checks || []).forEach(function (c) { if (c.no != null) moChkByNo[c.no] = c; });
                checkList.forEach(function (c) {
                    if (!c.url) return;
                    if (checkMonthOfNo[c.no] !== mo) return;
                    var mc = c.no != null ? moChkByNo[c.no] : undefined;
                    var rec = {
                        name: c.name,
                        no: c.no,
                        caption: c.caption || '',
                        url: c.url,
                        date: mc ? (mc.date || '') : '',
                        amount: mc ? (mc.amt != null ? String(mc.amt) : '') : ''
                    };
                    if (!d.checks.some(function (e) {
                        return e && e.no === rec.no && e.date === rec.date && e.amount === rec.amount && e.name === rec.name;
                    })) d.checks.push(rec);
                });

                refreshMonthTotals(d);
                yearTouched.push(mi);
            });

            await saveYearData(y, data);
            importedYears.push(y);

            if (y === curYear) {
                var gdata = null;
                try { gdata = st.data; } catch (_) { gdata = null; }
                if (gdata) {
                    data.forEach(function (md, mi) {
                        try { gdata[mi] = JSON.parse(JSON.stringify(md)); } catch (_) { }
                    });
                }
                yearTouched.forEach(function (mi) {
                    var md = (data || [])[mi];
                    if (!md) return;
                    if (typeof window.checksManager !== 'undefined' && window.checksManager) {
                        try {
                            if (Array.isArray(md.checks)) window.checksManager.setChecks(mi, md.checks);
                            if (Array.isArray(md.checkTexts)) window.checksManager.setChecksText(mi, md.checkTexts);
                        } catch (_) { }
                    }
                });
                yearTouched.forEach(function (mi) {
                    if (mi === currentMonth) return;
                    if (typeof window.recalcSalesBreakdownFromDetail === 'function') {
                        try { window.recalcSalesBreakdownFromDetail(mi); } catch (_) { }
                    }
                });
                if (typeof window.renderMonthState === 'function') {
                    try { window.renderMonthState(); } catch (_) { }
                }
                if (typeof window.saveToStorage === 'function') {
                    try { window.saveToStorage(); } catch (_) { }
                }
            }
        }

        if (!written && !checkCount) {
            statusEl.textContent = '没有可导入内容。';
            importReady = false;
            pickBtn.textContent = '选择文件';
            setActions(false);
            return;
        }

        var rec = makeImportRecord(lastFmt);
        if (rec) {
            historyList.unshift(rec);
            persistImportHistory();
        }
        showHistoryView();

        statusEl.textContent = '已导入 ' + written + ' 笔' + (checkCount ? '，支票 ' + checkCount + ' 笔' : '') + '（' + importedYears.join('、') + ' 年）';
        importReady = false;
        pickBtn.textContent = '选择文件';
        setActions(false);
        releasePreview();
    }

    // #region 导入确认
    var confirmLayer = null, confirmListEl = null, confirmOkBtn = null, confirmCancelBtn = null;

    function buildImportSummary(onlyYm) {
        var sum = { dinein: 0, dineinAmt: 0, delivery: 0, deliveryAmt: 0, income: 0, incomeAmt: 0, costPay: 0, costPayAmt: 0, othersDebit: 0, othersDebitAmt: 0, checks: 0, checksAmt: 0,
            uber: 0, panda: 0, fantuan: 0, bm: 0,
            taxGov: 0, taxGovAmt: 0, bill: 0, billAmt: 0, debitCard: 0, debitCardAmt: 0, zelle: 0, zelleAmt: 0 };
        lastFmt.months.forEach(function (mo) {
            if (onlyYm && mo.ym !== onlyYm) return;
            var ymParts = String(mo.ym || '').split('-');
            var y = Number(ymParts[0]), m = Number(ymParts[1]);
            var amt = function (n) { return Math.abs(n); };
            (mo.depCats || []).forEach(function (cat) {
                var catName = cat.name;
                if (catName === '刷卡(yelp/chowbus)') {
                    cat.rows.forEach(function (r) { sum.dinein++; sum.dineinAmt += amt(r.amt); });
                } else if (catName.indexOf('外卖·') === 0) {
                    var key = '';
                    if (catName.indexOf('Uber') >= 0) key = 'uber';
                    else if (catName.indexOf('饭团') >= 0) key = 'fantuan';
                    else if (catName.indexOf('熊猫') >= 0) key = 'panda';
                    else if (catName.indexOf('Beyond') >= 0) key = 'bm';
                    if (key) {
                        sum[key] += cat.rows.length;
                        cat.rows.forEach(function (r) { sum.delivery++; sum.deliveryAmt += amt(r.amt); });
                    } else {
                        cat.rows.forEach(function (r) { sum.income++; sum.incomeAmt += amt(r.amt); });
                    }
                } else {
                    cat.rows.forEach(function (r) { sum.income++; sum.incomeAmt += amt(r.amt); });
                }
            });
            (mo.wdCats || []).forEach(function (cat) {
                if (cat.name === '税政府') {
                    cat.rows.forEach(function (r) { sum.taxGov++; sum.taxGovAmt += amt(r.amt); sum.costPay++; sum.costPayAmt += amt(r.amt); });
                } else if (cat.name === '账单') {
                    cat.rows.forEach(function (r) { sum.bill++; sum.billAmt += amt(r.amt); sum.costPay++; sum.costPayAmt += amt(r.amt); });
                } else if (cat.name === '借记卡') {
                    cat.rows.forEach(function (r) { sum.debitCard++; sum.debitCardAmt += amt(r.amt); sum.costPay++; sum.costPayAmt += amt(r.amt); });
                } else if (cat.name === 'zelle') {
                    cat.rows.forEach(function (r) { sum.zelle++; sum.zelleAmt += amt(r.amt); sum.costPay++; sum.costPayAmt += amt(r.amt); });
                } else {
                    cat.rows.forEach(function (r) { sum.othersDebit++; sum.othersDebitAmt += amt(r.amt); sum.costPay++; sum.costPayAmt += amt(r.amt); });
                }
            });
            (mo.fee || []).forEach(function (f) { sum.othersDebit++; sum.othersDebitAmt += amt(f.amt); sum.costPay++; sum.costPayAmt += amt(f.amt); });
            (mo.checks || []).forEach(function (c) { sum.checks++; sum.checksAmt += amt(c.amt); });
        });
        return sum;
    }

    function showImportConfirm() {
        if (!lastFmt || !lastFmt.months || !lastFmt.months.length) return;
        if (!confirmLayer) {
            confirmLayer = document.getElementById('ipConfirmLayer');
            confirmListEl = document.getElementById('ipConfirmList');
            confirmOkBtn = document.getElementById('ipConfirmOk');
            confirmCancelBtn = document.getElementById('ipConfirmCancel');
            if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', hideImportConfirm);
            if (confirmOkBtn) confirmOkBtn.addEventListener('click', onConfirmOk);
            if (confirmLayer) confirmLayer.addEventListener('click', function (e) { if (e.target === confirmLayer) hideImportConfirm(); });
        }
        var months = (lastFmt.months || []).map(function (mo) { return mo.ym; }).filter(Boolean);
        var titleEl = confirmLayer && document.getElementById('ipConfirmTitle');
        var monthBtns = [];
        var activeYm = null;
        function buildCol(items) {
            var col = document.createElement('div');
            col.className = 'import-confirm-col';
            items.forEach(function (row) {
                var line = document.createElement('div');
                line.className = 'import-confirm-line';
                var lab = document.createElement('span');
                lab.className = 'lab';
                lab.textContent = row.lab;
                var cnt = document.createElement('span');
                cnt.className = 'cnt';
                cnt.textContent = String(row.cnt);
                line.append(lab, cnt);
                col.appendChild(line);
                if (row.children) {
                    row.children.forEach(function (child) {
                        var sub = document.createElement('div');
                        sub.className = 'import-confirm-line import-confirm-sub';
                        var sLab = document.createElement('span');
                        sLab.className = 'lab';
                        sLab.textContent = child.lab;
                        var sCnt = document.createElement('span');
                        sCnt.className = 'cnt';
                        sCnt.textContent = String(child.cnt);
                        sub.append(sLab, sCnt);
                        col.appendChild(sub);
                    });
                }
            });
            return col;
        }
        function renderGrid(sum) {
            var leftItems = [
                { lab: 'DINEIN', cnt: sum.dinein },
                { lab: '外卖平台', cnt: sum.delivery, children: [
                    { lab: 'Uber', cnt: sum.uber },
                    { lab: 'Panda', cnt: sum.panda },
                    { lab: 'Fantuan', cnt: sum.fantuan },
                    { lab: 'BeyondMenu', cnt: sum.bm }
                ]},
                { lab: 'others credit', cnt: sum.income }
            ];
            var rightItems = [
                { lab: '支票', cnt: sum.checks },
                { lab: 'Withdrawals', cnt: sum.costPay, children: [
                    { lab: '税政府', cnt: sum.taxGov },
                    { lab: '账单', cnt: sum.bill },
                    { lab: '借记卡', cnt: sum.debitCard },
                    { lab: 'zelle', cnt: sum.zelle },
                    { lab: 'others debit', cnt: sum.othersDebit }
                ]}
            ];
            if (confirmListEl) {
                confirmListEl.innerHTML = '';
                confirmListEl.className = 'import-confirm-grid';
                confirmListEl.append(buildCol(leftItems), buildCol(rightItems));
            }
        }
        function selectMonth(ym) {
            activeYm = ym;
            monthBtns.forEach(function (mb) { mb.el.classList.toggle('active', mb.ym === ym); });
            renderGrid(buildImportSummary(ym));
        }
        if (titleEl) {
            titleEl.innerHTML = '';
            if (months.length >= 2) {
                var allBtn = document.createElement('button');
                allBtn.type = 'button';
                allBtn.className = 'import-confirm-month-btn';
                allBtn.textContent = '全部';
                allBtn.addEventListener('click', function () { selectMonth(null); });
                titleEl.appendChild(allBtn);
                monthBtns.push({ ym: null, el: allBtn });
                months.forEach(function (ym) {
                    var b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'import-confirm-month-btn';
                    b.textContent = monthAbbrText(ym);
                    b.addEventListener('click', function () { selectMonth(ym === activeYm ? null : ym); });
                    titleEl.appendChild(b);
                    monthBtns.push({ ym: ym, el: b });
                });
            } else {
                titleEl.textContent = '';
            }
        }
        selectMonth(null);
        if (confirmLayer) {
            confirmLayer.classList.add('open');
            confirmLayer.setAttribute('aria-hidden', 'false');
        }
    }

    function hideImportConfirm() {
        if (confirmLayer) {
            confirmLayer.classList.remove('open');
            confirmLayer.setAttribute('aria-hidden', 'true');
        }
    }

    async function onConfirmOk() {
        hideImportConfirm();
        try {
            await doImportCore();
            if (typeof window.showGlobalSaveToast === 'function') {
                try { window.showGlobalSaveToast('保存成功', 60, 2000); } catch (_) { }
            }
        } catch (err) {
            statusEl.textContent = '导入失败：' + (err && err.message ? err.message : err);
            importReady = false;
            pickBtn.textContent = '选择文件';
            setActions(false);
        }
    }
    // #endregion

    // #endregion

    loadImportHistory().then(function () {
        if (historyView && !historyView.hidden) renderHistory();
    });
    }

    if (document.readyState === 'loading' || document.readyState === 'interactive') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
// #endregion
