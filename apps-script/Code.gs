/**
 * 夾公仔舖 WhatsApp 收租機械人（Google Apps Script，綁定「三間舖收租總表」Google Sheet）
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   WA_TOKEN       Meta WhatsApp Cloud API 永久存取權杖
 *   WA_PHONE_ID    WhatsApp 商業號碼嘅 Phone number ID
 *   RELAY_SECRET   同 Cloudflare Worker 共用嘅密碼（任意長字串）
 *   DRY_RUN        "1" = 唔真係發 WhatsApp，只寫入「訊息記錄」（測試用）
 *   CLAUDE_KEY     Anthropic API key（有先開 AI 對話；冇就只用固定指令）
 *   CLAUDE_MODEL   （可選）AI 用邊個模型，預設 claude-opus-5-5
 *   RECEIPT_FOLDER_ID （可選）Google Drive「04 入數紙及收據」資料夾 ID；有就自動將 WhatsApp 單據相存入去
 */

const TZ = 'Asia/Hong_Kong';
const S = {
  SET: '設定', STAFF: '同事', M: '機台總表', T: '租客', R: '收租紀錄',
  CF: '現金流', DEP: '入數紀錄', WK: '每週報表', LOG: '訊息記錄', DPT: '按金紀錄',
  FU: '跟進紀錄', BANK: '銀行月結單', COIN: '對幣紀錄', DAY: '每日結算', EPAY: '電子支付',
};
/** 唔計入租客戶口結欠嘅紀錄狀態。 */
const NOT_BILLED = ['待確認', '已確認', '分成', '舊數未核', '作廢'];
const SCHEMA_VERSION = '6';
const SCHEMA = {
  '機台總表': ['起租日', '結欠', '本月生意額', '上月生意額', '可否對幣', '累計兌幣', '兌幣次數', '最後兌幣日', '最後兌幣金額'],
  '租客': ['結欠', '逾期結欠', '按金', '最後付款日', '最後付款金額', '更新時間',
    '租客ID', '全名', '後備電話', '電郵', '聯絡偏好', '付款方式', '付款銀行', '戶口尾數', '入數名', 'FPS識別',
    '準時率', '平均遲交日數', '風險', '對數待處理', '跟進同事', '下次跟進', '標籤', 'AI', '同意日期',
    '本月生意額', '上月生意額', '平均月生意額', '租金佔生意額', '對幣狀態'],
  '按金紀錄': ['按金ID', '日期', '機號', '舖', '租客', '類別', '金額', '方式', '經手', '備註'],
  '收租紀錄': ['對數狀態', '銀行ID'],
  '跟進紀錄': ['日期', '租客', '類型', '內容', '經手', '下一步', '下次跟進'],
  '對幣紀錄': ['對幣ID', '日期', '舖', '機號', '租客', '幣數', '金額', '經手', '備註', '抵租', '俾台主', '付款方式', '處理', '單據'],
  '現金流': ['收支', '租客', '單據'],
  '每日結算': ['日期', '舖', '現金收入', '電子支付', '總生意額', '電子支付(平台)', '電子差額', '現金收租及其他', '現金支出', '現金入銀行',
    '上日現金', '應有現金', '點數', '差額', '狀態', '經手', '單據', '備註'],
  '電子支付': ['日期', '舖', '平台', '筆數', '金額', '參考'],
  '銀行月結單': ['銀行ID', '日期', '銀行', '描述', '參考', '存入', '提取', '對數狀態', '對應紀錄', '對應租客', '備註'],
};
const SHOP_CODES = { CWB: '銅鑼灣', SSP: '深水埗', MK: '旺角' };
const SHOP_ALIASES = [
  [/^(CWB|銅鑼灣|波斯富街?)/i, 'CWB'],
  [/^(SSP|深水埗|玩具街?)/i, 'SSP'],
  [/^(MK|旺角|西洋菜街?)/i, 'MK'],
];
const OPEN_STATUSES = ['未到期', '欠租', '部份交', '待確認'];

/* ---------------- 日期 ---------------- */

function dayKey(d) {
  return Utilities.formatDate(d instanceof Date ? d : new Date(d), TZ, 'yyyy-MM-dd');
}
function todayKey() { return dayKey(new Date()); }
function keyToDate(key) { return new Date(key + 'T00:00:00+08:00'); }
function daysBetween(fromKey, toKey) {
  const a = fromKey.split('-').map(Number), b = toKey.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 864e5);
}
function periodOf(key) { return key.slice(0, 7); }
function dueKeyFor(period, day) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(1, Number(day) || 1), last);
  return period + '-' + String(d).padStart(2, '0');
}
function cellKey(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : dayKey(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return '';
}
/** 讀日期：2026-11-21、2026/11/21、21/11/2026、21/11（今年）。 */
function parseDate(text, today) {
  const t = normText(text);
  let m = t.match(/(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = t.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?(?=\s|$)/);
  if (m) return (m[3] || today.slice(0, 4)) + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}
function money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
function nowText() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

/* ---------------- 試算表 ---------------- */

function book_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/** 以表頭做欄名嘅簡單資料表。 */
function table(name) {
  const sh = book_().getSheetByName(name);
  if (!sh) throw new Error('搵唔到分頁：' + name);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });
  const rows = values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { o[h] = r[j]; });
    return o;
  });
  return {
    sh, headers, col, rows,
    set(row, field, value) {
      if (!(field in col)) throw new Error(name + ' 冇欄：' + field);
      row[field] = value;
      sh.getRange(row._row, col[field] + 1).setValue(value);
    },
    setMany(row, obj) { Object.keys(obj).forEach(k => this.set(row, k, obj[k])); },
    append(obj) {
      const arr = headers.map(h => (obj[h] === undefined ? '' : obj[h]));
      sh.appendRow(arr);
      const o = Object.assign({ _row: sh.getLastRow() }, obj);
      rows.push(o);
      return o;
    },
    /** 一次過寫返整欄（用喺每日重算，慳 API 次數）。 */
    writeColumns(fields) {
      if (!rows.length) return;
      fields.forEach(f => {
        const c = col[f];
        sh.getRange(2, c + 1, rows.length, 1).setValues(rows.map(r => [r[f] === undefined ? '' : r[f]]));
      });
    },
  };
}

/** 自動補新分頁同新欄（舊表升級用，唔會刪任何資料）。 */
function ensureSchema() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('SCHEMA') === SCHEMA_VERSION) return;
  const ss = book_();
  Object.keys(SCHEMA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.appendRow(SCHEMA[name]); return; }
    const head = sh.getDataRange().getValues()[0].map(String);
    SCHEMA[name].filter(h => head.indexOf(h) < 0).forEach(h => {
      head.push(h);
      sh.getRange(1, head.length).setValue(h);
    });
  });
  p.setProperty('SCHEMA', SCHEMA_VERSION);
}

function settings() {
  const out = {};
  table(S.SET).rows.forEach(r => { if (r['設定']) out[String(r['設定']).trim()] = r['值']; });
  return {
    hour: Number(out['追租時間'] || 10),
    kickDays: Number(out['踢走日數'] || 7),
    ownerDays: Number(out['通知老闆日數'] || 1),
    autoKick: String(out['自動踢走'] || '否') === '是',
    vacantWarn: Number(out['空置警告日數'] || 14),
    cashDays: Number(out['現金未入數日數'] || 2),
    tenantConfirm: String(out['租客需確認'] || '是') === '是',
    remindTenant: String(out['提示租客'] || '否') === '是',
    staffTemplate: String(out['追租範本'] || ''),
    ownerTemplate: String(out['老闆範本'] || ''),
    lang: String(out['範本語言'] || 'zh_HK'),
    tenantTemplate: String(out['租客範本'] || ''),
    coinValue: Number(out['幣值'] || 5),
    cashTolerance: Number(out['現金差額容許'] || 50),
    stopDays: Number(out['停止對幣日數'] || 1),
    overdueTenantDaily: String(out['每日提租客欠租'] || '是') === '是',
    needPhoto: String(out['收款要附相'] || '是') === '是',
  };
}

function nextId(tbl, field, prefix) {
  let max = 0;
  tbl.rows.forEach(r => {
    const m = String(r[field] || '').match(/^\D*(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + String(max + 1).padStart(5, '0');
}

/* ---------------- 解析 ---------------- */

function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 8) d = '852' + d;
  return d;
}

function normText(t) {
  return String(t || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')
    .trim();
}

/** 由一段字搵機號，例如 CWB-01、cwb1、銅鑼灣 1、波斯富 12。 */
function parseMachine(text) {
  const t = normText(text);
  const m = t.match(/(CWB|SSP|MK|銅鑼灣|波斯富街?|深水埗|玩具街?|旺角|西洋菜街?)\s*[-_ ]?\s*(\d{1,3})\s*號?/i);
  if (!m) return null;
  const alias = SHOP_ALIASES.find(a => a[0].test(m[1]));
  return alias[1] + '-' + String(Number(m[2])).padStart(2, '0');
}

function parseAmount(text) {
  const t = normText(text).replace(/(CWB|SSP|MK)\s*[-_ ]?\s*\d{1,3}/ig, ' ')
    .replace(/(銅鑼灣|波斯富街?|深水埗|玩具街?|旺角|西洋菜街?)\s*\d{1,3}\s*號?/g, ' ');
  const m = t.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseMethod(text) {
  const t = normText(text);
  if (/對幣|找幣|換幣/.test(t)) return '對幣';
  if (/現金|cash/i.test(t)) return '現金';
  if (/fps|轉數快/i.test(t)) return 'FPS';
  if (/支票|cheque|check/i.test(t)) return '支票';
  if (/轉帳|轉賬|過數|入數|bank|轉數/i.test(t)) return '銀行轉帳';
  return '';
}

function parseShop(text) {
  const t = normText(text);
  const a = SHOP_ALIASES.find(x => new RegExp(x[0].source.replace('^', ''), 'i').test(t));
  return a ? SHOP_CODES[a[1]] : '';
}

/* ---------------- 身份 ---------------- */

function whoIs(phone) {
  const p = normPhone(phone);
  const staff = table(S.STAFF).rows.find(r => normPhone(r['WhatsApp']) === p && p);
  if (staff) {
    return { kind: staff['角色'] === '老闆' ? 'owner' : 'staff', name: String(staff['姓名']), shop: String(staff['舖'] || '全部'), phone: p };
  }
  const m = table(S.M).rows.find(r => normPhone(r['租客電話']) === p && p);
  const t = table(S.T).rows.find(r => normPhone(r['電話']) === p && p);
  if (m || t) return { kind: 'tenant', name: String((t && t['租客']) || (m && m['租客']) || ''), shop: '', phone: p };
  return { kind: 'unknown', name: '', shop: '', phone: p };
}

function isStaff(who) { return who.kind === 'staff' || who.kind === 'owner'; }

/* ---------------- 收租紀錄 ---------------- */

function machineRow(mt, code) { return mt.rows.find(r => String(r['機號']).toUpperCase() === code); }

function outstanding(rec) {
  return Math.max(0, Number(rec['應收金額'] || 0) - Number(rec['實收金額'] || 0));
}

function firstOpen(rt, code, includeKicked) {
  const ok = includeKicked ? ['未到期', '欠租', '部份交', '踢走'] : ['未到期', '欠租', '部份交'];
  return rt.rows
    .filter(r => r['機號'] === code && ok.indexOf(String(r['狀態'])) >= 0 && outstanding(r) > 0)
    .sort((a, b) => String(a['期數']).localeCompare(String(b['期數'])))[0] || null;
}
function latestPeriod(rt, code) {
  return rt.rows.filter(r => r['機號'] === code).map(r => String(r['期數'])).sort().pop() || periodOf(todayKey());
}
function nextPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
}

/** 搵呢部機最早一筆未清嘅紀錄；冇就幫本月開一筆。 */
function openRecordFor(rt, m, today) {
  const code = String(m['機號']);
  const open = rt.rows
    .filter(r => r['機號'] === code && OPEN_STATUSES.indexOf(String(r['狀態'])) >= 0 && String(r['狀態']) !== '待確認')
    .sort((a, b) => String(a['期數']).localeCompare(String(b['期數'])));
  if (open.length) return open[0];
  return ensurePeriodRecord(rt, m, periodOf(today), today);
}

function ensurePeriodRecord(rt, m, period, today) {
  const code = String(m['機號']);
  const found = rt.rows.find(r => r['機號'] === code && String(r['期數']) === period && String(r['狀態']) !== '踢走');
  if (found) return found;
  const due = dueKeyFor(period, m['收租日']);
  return rt.append({
    '紀錄ID': nextId(rt, '紀錄ID', 'R'), '機號': code, '舖': m['舖'], '租客': m['租客'], '期數': period,
    '應收日': keyToDate(due), '應收金額': Number(m['月租'] || 0), '實收金額': '', '實收日': '',
    '付款方式': '', '收款人': '', '狀態': due >= today ? '未到期' : '欠租', '來源': '系統', '已入數': '',
    '入數ID': '', '收據': '', '備註': '', '更新時間': nowText(),
  });
}

function addCashflow(rec, amount, method, by, today, note, category, receipt) {
  const cf = table(S.CF);
  const offset = method === '按金抵租' || method === '對幣';
  cf.append({
    '日期': keyToDate(today), '舖': rec['舖'], '類別': category || (method === '按金抵租' ? '按金抵租' : '租金'), '機號': rec['機號'], '金額': amount,
    '現金/銀行': method === '按金抵租' ? '按金轉撥' : method === '對幣' ? '對幣抵銷' : (method === '現金' ? '現金' : '銀行'), '經手': by, '收租紀錄ID': rec['紀錄ID'] || '',
    '已入數': offset ? '不適用' : (method === '現金' ? '否' : '是'), '入數ID': '', '備註': note || method,
    '收支': '收', '租客': rec['租客'] || '', '單據': receipt || '',
  });
}

/** 記一筆支出（對幣俾台主、電費、業主租、買貨、人工…）。 */
function addExpense_(o) {
  const cf = table(S.CF);
  return cf.append({
    '日期': keyToDate(o.date), '舖': o.shop || '', '類別': o.category, '機號': o.code || '', '金額': o.amount,
    '現金/銀行': o.method === '現金' ? '現金' : '銀行', '經手': o.by, '收租紀錄ID': o.ref || '', '已入數': '不適用', '入數ID': '',
    '備註': o.note || o.method, '收支': '支', '租客': o.tenant || '', '單據': o.receipt || '',
  });
}

function photoHint_(receipt, key) {
  return receipt || !settings().needPhoto ? '' : '\n📷 未附單據相：請 send 張相，註解寫「單據 ' + key + '」';
}

/** 記一筆收款（同事收、或者確認租客報嘅數）。 */
function applyPayment(rt, rec, amount, method, by, today, receipt, source) {
  const paid = Number(rec['實收金額'] || 0) + amount;
  const full = paid >= Number(rec['應收金額'] || 0);
  rt.setMany(rec, {
    '實收金額': paid, '實收日': keyToDate(today), '付款方式': method || rec['付款方式'] || '',
    '收款人': by, '狀態': full ? '已交' : '部份交', '來源': source,
    '已入數': method === '按金抵租' || method === '對幣' ? '不適用' : (method === '現金' ? '否' : '是'), '收據': receipt || rec['收據'] || '', '更新時間': nowText(),
  });
  addCashflow(rec, amount, method, by, today, '', '', receipt);
  return full;
}

/* ---------------- 指令 ---------------- */

const HELP = [
  '收租機械人指令：',
  '收 CWB-01 5500 現金　（同事記租金，方式：現金/FPS/轉帳/支票）',
  '按金 CWB-01 5500 現金　（同事記按金，另計，唔當租金）',
  '結單 CWB-01　（租客戶口：仲欠幾多、未交期數、按金）',
  '查 CWB-01　（查交咗租未、可唔可以入機）',
  '入數 匯豐 16400　（現金入咗銀行）',
  '確認 R01234　（確認租客報嘅交租）',
  '欠租　/　欠租 旺角',
  '空置　/　空置 深水埗',
  '租出 CWB-41 陳生 91234567 5500 2026-12-01 對幣　（開戶：機號 稱呼 電話 月租 入機日 付款方式）',
  '起租 CWB-41 2026-12-01　（改起租日）',
  '踢走 CWB-01　/　按金抵租 CWB-01　/　退按 CWB-01 5500 FPS　（老闆用）',
  '客戶 白豬　（租客 CRM 摘要）　/　跟進 白豬 答應星期五交 2026-11-21',
  '對數　（對銀行月結單）　/　對數確認 B00003',
  '對幣 CWB-01 3200　/　對幣 CWB-01 640個　（記生意額同俾錢台主，可以一次寫幾部機）',
  '對幣抵租 CWB-01 3200　（對幣先扣欠租，淨低先俾台主）',
  '支出 銅鑼灣 電費 3200 轉帳　/　俾台主 CWB-01 2000 現金　（支出：台主、電費、舖租、買貨、人工、雜項）',
  '日結 銅鑼灣 現金 15200 電子 8300 點數 9650　（每日埋數，計有冇少錢）',
  '單據 CWB-01　（send 相補單據）　/　週報　（老闆即時出週報）',
  '生意　/　生意 旺角　/　生意 白豬　/　生意 CWB-01　（睇生意額）',
  '唔係指令嘅說話會交俾 AI 處理。',
  '機號：CWB 銅鑼灣波斯富街、SSP 深水埗玩具街、MK 旺角西洋菜街',
].join('\n');

/** 處理一條 WhatsApp 訊息，返回要回覆嘅字。 */
function handleMessage(phone, rawText, receipt) {
  const r = routeMessage_(phone, rawText, receipt);
  let reply = r.reply;
  if (r.ai) {
    try { reply = aiReply_(r); } catch (err) { reply = r.fallback; logMessage('錯', phone, r.who.name, 'AI 出錯：' + err.message, ''); }
  }
  logMessage('收', phone, r.who.name, rawText + (receipt ? ' [附件 ' + receipt + ']' : ''), reply);
  return reply;
}

/** 固定指令即刻處理；唔係指令（或者租客格式唔啱）就標記交俾 AI。 */
function routeMessage_(phone, rawText, receipt) {
  ensureSchema();
  const text = normText(rawText);
  const who = whoIs(phone);
  const today = todayKey();
  const route = [
    [/^(幫助|help|menu|指令|\?|？)/i, 'help'], [/^按金抵租/, 'offset'], [/^(收按金|按金)/, 'dep_in'], [/^退按/, 'dep_out'],
    [/^(結單|月結單|戶口|餘額|結欠|欠幾多)/, 'statement'], [/^起租/, 'start'],
    [/^(交租|已交|俾咗|交)/, 'pay'], [/^(收租|已收|收)/, 'collect'],
    [/^查/, 'check'], [/^入數/, 'deposit'], [/^(確認|confirm)/i, 'confirm'], [/^欠租/, 'overdue'],
    [/^空置/, 'vacant'], [/^租出/, 'let'], [/^踢走/, 'kick'],
    [/^對數確認/, 'recon_ok'], [/^對數/, 'recon'], [/^客戶/, 'crm'], [/^跟進/, 'followup'],
    [/^(對幣抵租|對幣扣租)/, 'coin_off'], [/^(對幣|找幣|換幣)/, 'coin'], [/^日結/, 'dayclose'], [/^(支出|俾台主|付台主)/, 'expense'],
    [/^單據/, 'receipt'], [/^(週報|周報)/, 'weekly'], [/^(生意額?|營業額)/, 'turnover'],
  ].find(r => r[0].test(text));
  let cmd = route ? route[1] : '';
  // 租客講嘢唔跟格式（例如「交咗啦」「我仲欠幾多呀？」）就交俾 AI
  if (who.kind === 'tenant' && ['pay', 'check'].indexOf(cmd) >= 0 && !(parseMachine(text) && (cmd === 'check' || parseAmount(text)))) cmd = '';
  if (who.kind === 'tenant' && cmd === 'statement' && text.length > 8 && !parseMachine(text)) cmd = '';
  const fallback = isStaff(who) ? '睇唔明呢個指令。\n' + HELP :
    (who.kind === 'tenant' ? '收到，同事會盡快覆你。查戶口可以打：欠幾多' : '你嘅號碼未登記，請聯絡舖頭同事。');
  let reply;
  try {
    if (receipt && !text) reply = isStaff(who) ? '收到相片。請喺相片加註解，例如：收 CWB-01 5500 FPS' : '收到相片。請喺相片加註解，例如：交租 CWB-01 5500 FPS';
    else if (cmd === 'offset') reply = cmdOffset(who, text, today);
    else if (cmd === 'dep_in') reply = cmdDepositIn(who, text, receipt, today);
    else if (cmd === 'dep_out') reply = cmdDepositOut(who, text, receipt, today);
    else if (cmd === 'statement') reply = cmdStatement(who, text, today);
    else if (cmd === 'start') reply = cmdStart(who, text, today);
    else if (cmd === 'collect' && /按金/.test(text)) reply = cmdDepositIn(who, text, receipt, today);
    else if (!text || cmd === 'help') reply = HELP;
    else if (cmd === 'collect') reply = cmdCollect(who, text, receipt, today);
    else if (cmd === 'pay') reply = isStaff(who) ? cmdCollect(who, text, receipt, today) : cmdTenantPay(who, text, receipt, today);
    else if (cmd === 'check') reply = cmdCheck(who, text, today);
    else if (cmd === 'deposit') reply = cmdDeposit(who, text, receipt, today);
    else if (cmd === 'confirm') reply = cmdConfirm(who, text, today);
    else if (cmd === 'overdue') reply = cmdOverdue(who, text, today);
    else if (cmd === 'vacant') reply = cmdVacant(who, text, today);
    else if (cmd === 'let') reply = cmdLet(who, text, today);
    else if (cmd === 'kick') reply = cmdKick(who, text, today);
    else if (cmd === 'recon_ok') reply = cmdReconConfirm(who, text, today);
    else if (cmd === 'recon') reply = cmdRecon(who, text, today);
    else if (cmd === 'crm') reply = cmdCrm(who, text, today);
    else if (cmd === 'followup') reply = cmdFollowUp(who, text, today);
    else if (cmd === 'coin_off') reply = cmdCoin(who, text, today, receipt, true);
    else if (cmd === 'coin') reply = cmdCoin(who, text, today, receipt, false);
    else if (cmd === 'dayclose') reply = cmdDayClose(who, text, receipt, today);
    else if (cmd === 'expense') reply = cmdExpense(who, text, receipt, today);
    else if (cmd === 'receipt') reply = cmdReceipt(who, text, receipt, today);
    else if (cmd === 'weekly') { if (who.kind !== 'owner') throw new Error('週報只限老闆使用。'); reply = weeklyReport_(today).join('\n'); }
    else if (cmd === 'turnover') reply = cmdTurnover(who, text, today);
    else if (receipt && parseMachine(text) && parseAmount(text)) reply = isStaff(who) ? cmdCollect(who, text, receipt, today) : cmdTenantPay(who, text, receipt, today);
    else if (who.kind !== 'unknown') {
      const t = who.kind === 'tenant' ? tenantRecord_(who) : null;
      if (t && String(t['AI']) === '關') {
        notifyStaff(shopsOfTenant_(t['租客'])[0] || '全部', '💬 ' + t['租客'] + '（同事接手中）：' + rawText);
        reply = '收到，已轉交同事，同事會盡快覆你。';
      } else if (aiEnabled_()) {
        return { who, text, rawText, receipt, today, ai: true, fallback, reply: '' };
      } else reply = fallback;
    } else reply = fallback;
  } catch (err) {
    reply = '出錯：' + err.message + '\n請再試，或者通知老闆。';
  }
  return { who, text, rawText, receipt, today, ai: false, fallback, reply };
}

function needStaff(who) {
  if (!isStaff(who)) throw new Error('呢個指令只限同事使用。如果你係同事，請老闆將你號碼加入「同事」分頁。');
}

/** 將一筆錢分配落最早未清嘅期數，多咗當預繳下期。返回每期結果。 */
function allocate(rt, m, amount, method, by, today, receipt, source) {
  const code = String(m['機號']);
  let left = amount;
  const notes = [];
  // 一筆錢可以清幾期（例如補交上月 + 本月），多咗就當預繳下期。
  for (let i = 0; i < 12 && left > 0.001; i++) {
    let rec = firstOpen(rt, code);
    if (!rec) {
      const cur = ensurePeriodRecord(rt, m, periodOf(today), today);
      rec = outstanding(cur) > 0 && ['已交', '踢走', '分成'].indexOf(String(cur['狀態'])) < 0 ? cur
        : ensurePeriodRecord(rt, m, nextPeriod(latestPeriod(rt, code)), today);
    }
    const owe = outstanding(rec);
    if (owe <= 0) break;
    const pay = Math.min(left, owe);
    const full = applyPayment(rt, rec, pay, method, by, today, receipt, source);
    notes.push(rec['期數'] + (full ? ' 已清 $' + pay : ' 部份交 $' + pay + '，呢期仲欠 $' + outstanding(rec)) + (rec['期數'] > periodOf(today) ? '（預繳）' : ''));
    left -= pay;
  }
  if (left > 0.001) notes.push('⚠️ 有 $' + left + ' 未分配，請通知老闆');
  return notes;
}

function cmdCollect(who, text, receipt, today) {
  needStaff(who);
  const code = parseMachine(text);
  const amount = parseAmount(text);
  if (!code || !amount) return '格式：收 CWB-01 5500 現金';
  const method = parseMethod(text) || '現金';
  if (method === '對幣') return cmdCoin(who, '對幣抵租 ' + code + ' ' + amount, today, receipt, true);
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  if (!Number(m['月租'])) return code + ' 而家冇月租（狀態：' + m['狀態'] + '）。如果係新租客，請用「租出」指令。';
  const rt = table(S.R);
  const notes = allocate(rt, m, amount, method, who.name, today, receipt, 'WhatsApp');
  refreshMachine(m, mt, rt, today, settings());
  const ok = Number(m['欠款'] || 0) === 0;
  const bal = accountOf(rt, [code], m['租客'], today);
  return '✅ 收租｜' + m['舖'] + '｜' + code + (m['租客'] ? '｜' + m['租客'] : '') + '\n　收 ' + money(amount) + '（' + method + '，經手 ' + who.name + '）\n' + notes.join('\n') +
    '\n' + balanceLine(bal) + '\n' + (ok ? '已清晒，可以入機。' : '⚠️ 逾期仲欠 ' + money(m['欠款']) + '，未可以入機。') + photoHint_(receipt, code);
}

function cmdTenantPay(who, text, receipt, today) {
  const code = parseMachine(text);
  const amount = parseAmount(text);
  if (!code || !amount) return '請咁樣報交租：交租 CWB-01 5500 FPS，並附上轉數截圖。';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code + '，請檢查。';
  if (who.kind === 'tenant' && normPhone(m['租客電話']) && normPhone(m['租客電話']) !== who.phone) {
    return code + ' 唔係登記喺你名下，請聯絡舖頭同事。';
  }
  const set = settings();
  const rt = table(S.R);
  const rec = openRecordFor(rt, m, today);
  const method = parseMethod(text) || 'FPS';
  if (!set.tenantConfirm) {
    applyPayment(rt, rec, amount, method, '租客自報', today, receipt, 'WhatsApp 租客');
    refreshMachine(m, mt, rt, today, set);
    return '多謝！' + code + ' $' + amount + ' 已記錄。';
  }
  const pend = rt.append({
    '紀錄ID': nextId(rt, '紀錄ID', 'R'), '機號': code, '舖': m['舖'], '租客': m['租客'] || who.name,
    '期數': rec['期數'], '應收日': rec['應收日'], '應收金額': 0, '實收金額': amount, '實收日': keyToDate(today),
    '付款方式': method, '收款人': '', '狀態': '待確認', '來源': 'WhatsApp 租客', '已入數': '', '入數ID': '',
    '收據': receipt || '', '備註': '對應 ' + rec['紀錄ID'] + '｜租客 ' + who.phone, '更新時間': nowText(),
  });
  notifyStaff(String(m['舖']), '🔔 租客報交租｜' + m['舖'] + '｜' + code + '｜' + (m['租客'] || '') + '｜' + money(amount) + '（' + method + '）' +
    (receipt ? '，有附截圖' : '') + '\n核對到數後回覆：確認 ' + pend['紀錄ID']);
  return '多謝！已收到 ' + code + ' $' + amount + ' 嘅交租通知，同事核對後會確認。';
}

function cmdConfirm(who, text, today) {
  needStaff(who);
  const id = (normText(text).match(/R\d+/i) || [])[0];
  if (!id) return '格式：確認 R01234';
  const rt = table(S.R);
  const pend = rt.rows.find(r => String(r['紀錄ID']).toUpperCase() === id.toUpperCase());
  if (!pend) return '搵唔到 ' + id;
  if (pend['狀態'] !== '待確認') return id + ' 唔係待確認（而家：' + pend['狀態'] + '）';
  const mt = table(S.M);
  const m = machineRow(mt, String(pend['機號']));
  const amount = Number(pend['實收金額']);
  const notes = allocate(rt, m, amount, String(pend['付款方式']), who.name, today, pend['收據'], 'WhatsApp 租客（' + who.name + ' 確認）');
  rt.setMany(pend, { '狀態': '已確認', '收款人': who.name, '更新時間': nowText() });
  refreshMachine(m, mt, rt, today, settings());
  return '✅ 已確認收租｜' + pend['舖'] + '｜' + pend['機號'] + (pend['租客'] ? '｜' + pend['租客'] : '') + '\n　收 ' + money(amount) + '（' + (pend['付款方式'] || '-') + '）\n' + notes.join('\n') + '\n' + (Number(m['欠款'] || 0) ? '仲欠 $' + m['欠款'] : '已清晒，可以入機。');
}

function cmdCheck(who, text, today) {
  const code = parseMachine(text);
  if (!code) return '格式：查 CWB-01';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  if (who.kind === 'tenant' && normPhone(m['租客電話']) !== who.phone) return code + ' 唔係登記喺你名下。';
  if (who.kind === 'unknown') return '你嘅號碼未登記，請聯絡舖頭同事。';
  const rt = table(S.R);
  refreshMachine(m, mt, rt, today, settings());
  const lines = [code + '（' + m['舖'] + ' ' + m['原台號'] + ' 號）狀態：' + m['狀態']];
  if (m['租客']) lines.push('租客：' + m['租客'] + '　月租 $' + m['月租'] + '　每月 ' + m['收租日'] + ' 號交');
  if (m['本期']) lines.push('本期 ' + m['本期'] + '：' + m['本期狀態']);
  if (Number(m['欠款'])) lines.push('⚠️ 逾期欠 ' + money(m['欠款']) + '，過咗 ' + m['欠租日數'] + ' 日');
  if (m['租客']) {
    lines.push(balanceLine(accountOf(rt, [code], m['租客'], today)));
    lines.push('按金（另計）：' + money(depositHeld(code, m['租客'])));
  }
  if (who.kind !== 'tenant' || normPhone(m['租客電話']) === who.phone) {
    const ct = machineCoinTotals_(sheetRows_(S.COIN), code);
    if (ct.count) lines.push('🪙 兌幣：本月 ' + money(machineTurnover_(sheetRows_(S.COIN), code, periodOf(today))) + '｜總累計 ' + money(ct.total) + '（' + ct.count + ' 次，最後 ' + ct.lastDate + ' ' + money(ct.lastAmt) + '）');
  }
  if (m['可否對幣'] === '停止') lines.push('⛔ 停止兌幣：要用「對幣抵租」');
  lines.push(m['可否入機'] === '可以' ? '✅ 可以入機' : (m['可否入機'] === '空置' ? '🈳 空置' : '⛔ 未交租，唔好入機'));
  return lines.join('\n');
}

function cmdDeposit(who, text, receipt, today) {
  needStaff(who);
  const t = normText(text).replace(/^入數\s*/, '');
  const amount = parseAmount(t);
  if (!amount) return '格式：入數 匯豐 16400（附入數紙相更好）';
  const bank = (t.replace(/\$?\s*[\d,]+(\.\d+)?/, '').trim()) || '未註明';
  const dep = table(S.DEP);
  const id = nextId(dep, '入數ID', 'D');
  const cf = table(S.CF);
  const mine = cf.rows
    .filter(r => r['現金/銀行'] === '現金' && r['收支'] !== '支' && r['已入數'] !== '是' && r['經手'] === who.name)
    .sort((a, b) => cellKey(a['日期']).localeCompare(cellKey(b['日期'])));
  let left = amount, n = 0;
  mine.forEach(r => {
    if (left >= Number(r['金額']) - 0.001) {
      cf.setMany(r, { '已入數': '是', '入數ID': id });
      left -= Number(r['金額']);
      n++;
    }
  });
  dep.append({ '入數ID': id, '日期': keyToDate(today), '銀行': bank, '金額': amount, '入數同事': who.name, '單據': receipt || '', '對應現金流筆數': n, '備註': left > 0.001 ? '有 $' + left + ' 對唔到現金收租' : '' });
  const rt = table(S.R);
  const ids = cf.rows.filter(r => r['入數ID'] === id).map(r => r['收租紀錄ID']);
  rt.rows.filter(r => ids.indexOf(r['紀錄ID']) >= 0).forEach(r => rt.setMany(r, { '已入數': '是', '入數ID': id }));
  const still = cf.rows.filter(r => r['現金/銀行'] === '現金' && r['收支'] !== '支' && r['已入數'] !== '是' && r['經手'] === who.name)
    .reduce((s, r) => s + Number(r['金額']), 0);
  return '✅ 入數 ' + id + '：' + bank + ' $' + amount + '，對到 ' + n + ' 筆現金收租。' +
    (left > 0.001 ? '\n⚠️ 有 $' + left + ' 對唔到。' : '') + '\n你手上仲有現金未入數：$' + still;
}

function overdueList(shop, today, set) {
  const mt = table(S.M);
  const rt = table(S.R);
  refreshAll(mt, rt, today, set);
  return mt.rows
    .filter(m => (!shop || shop === '全部' || m['舖'] === shop) && Number(m['欠款']) > 0 && Number(m['欠租日數']) > 0)
    .sort((a, b) => Number(b['欠租日數']) - Number(a['欠租日數']));
}

function cmdOverdue(who, text, today) {
  needStaff(who);
  const shop = parseShop(text) || who.shop;
  const list = overdueList(shop, today, settings());
  if (!list.length) return '✅ ' + (shop && shop !== '全部' ? shop : '三間舖') + '冇欠租。';
  return '⚠️ 欠租 ' + list.length + ' 部：\n' + list.map(m =>
    m['機號'] + ' ' + (m['租客'] || '') + ' $' + m['欠款'] + '（' + m['欠租日數'] + ' 日）').join('\n');
}

function cmdVacant(who, text, today) {
  needStaff(who);
  const shop = parseShop(text) || who.shop;
  const mt = table(S.M);
  refreshAll(mt, table(S.R), today, settings());
  const list = mt.rows.filter(m => (!shop || shop === '全部' || m['舖'] === shop) && ['空置', '踢走待換'].indexOf(String(m['狀態'])) >= 0);
  if (!list.length) return '冇空置機 👍';
  return '🈳 空置 ' + list.length + ' 部，請盡快租出：\n' + list.map(m =>
    m['機號'] + (m['狀態'] === '踢走待換' ? '（踢走待換）' : '') + (m['空置日數'] !== '' ? ' 空置 ' + m['空置日數'] + ' 日' : '')).join('\n');
}

function cmdLet(who, text, today) {
  needStaff(who);
  const t = normText(text);
  const code = parseMachine(t);
  const m1 = t.match(/^租出\s*\S+\s+(\S+)\s+(\+?\d[\d-]{7,13})\s+\$?([\d,]+)(?:\s+(\d\S*))?/);
  const payM = parseMethod(t.replace(/^租出\s*\S+\s+\S+/, ''));
  if (!code || !m1) return '格式：租出 CWB-41 陳生 91234567 5500 2026-12-01 對幣（起租日即入機日，唔寫就用今日；最後可以寫付款方式：入數／現金／對幣）';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  if (['出租中', '欠租'].indexOf(String(m['狀態'])) >= 0) return code + ' 而家出租緊俾 ' + m['租客'] + '，要先「踢走」先可以租出。';
  const name = m1[1], phone = normPhone(m1[2]), rent = Number(m1[3].replace(/,/g, ''));
  let start = m1[4] ? parseDate(m1[4], today) : today;
  if (!start && /^\d{1,2}$/.test(m1[4] || '')) start = dueKeyFor(periodOf(today), Number(m1[4]));
  if (!start) return '起租日睇唔明：' + m1[4] + '。請寫 2026-12-01 或者 1/12。';
  const day = Number(start.slice(8));
  mt.setMany(m, { '狀態': '出租中', '租客': name, '租客電話': phone, '月租': rent, '收租日': day, '起租日': keyToDate(start), '空置起計': '', '空置日數': '', '備註': '' });
  const tt = table(S.T);
  const tr = tt.rows.find(r => normPhone(r['電話']) === phone) || tt.rows.find(r => r['租客'] === name && !r['電話']);
  if (tr) tt.setMany(tr, Object.assign({ '電話': phone, '機號': [String(tr['機號'] || ''), code].filter(Boolean).join(', ') }, payM ? { '付款方式': payM } : {}));
  else tt.append({ '租客': name, '電話': phone, '機號': code, '備註': '', '付款方式': payM || '', '同意日期': keyToDate(today) });
  const rt = table(S.R);
  const rec = ensurePeriodRecord(rt, m, periodOf(start), today);
  rt.setMany(rec, { '租客': name, '應收金額': rent, '應收日': keyToDate(start), '狀態': start >= today ? '未到期' : '欠租' });
  refreshMachine(m, mt, rt, today, settings());
  return '✅ ' + code + ' 已租俾 ' + name + '（' + phone + '），月租 ' + money(rent) + '，' + start + ' 起租，之後每月 ' + day + ' 號交。\n' +
    '付款方式：' + (payM || '未講（入數／現金／對幣）') + '\n收按金請打：按金 ' + code + ' ' + rent + ' 現金\n收第一期租請打：收 ' + code + ' ' + rent + ' 現金';
}

function cmdKick(who, text, today) {
  if (who.kind !== 'owner') throw new Error('踢走只限老闆使用。');
  const code = parseMachine(text);
  if (!code) return '格式：踢走 CWB-01';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  const old = [m['租客'], m['租客電話']].filter(String).join(' ');
  const oldName = m['租客'];
  const rtk = table(S.R);
  const debt = accountOf(rtk, [code], oldName, today).overdue;
  const held = depositHeld(code, oldName);
  kickMachine(m, mt, rtk, today, '老闆 WhatsApp');
  notifyStaff(String(m['舖']), '⛔ ' + code + ' 已踢走（前租客 ' + (old || '未有名') + '），唔好再入機。請收回部機，盡快租出。');
  return '✅ ' + code + ' 已標記踢走待換' + (old ? '（前租客 ' + old + '）' : '') + '，已通知舖頭同事。新租客用「租出」登記。' +
    '\n前租客逾期欠 ' + money(debt) + '，按金仲有 ' + money(held) + '。' +
    (held > 0 && debt > 0 ? '\n要用按金抵欠租請回覆：按金抵租 ' + code : '') +
    (held > debt && debt === 0 ? '\n要退按金請回覆：退按 ' + code + ' ' + held + ' FPS' : '');
}

function kickMachine(m, mt, rt, today, by) {
  rt.rows.filter(r => r['機號'] === m['機號'] && ['欠租', '部份交', '未到期'].indexOf(String(r['狀態'])) >= 0)
    .forEach(r => rt.setMany(r, { '狀態': '踢走', '備註': [r['備註'], by + ' ' + today + ' 踢走'].filter(String).join('｜'), '更新時間': nowText() }));
  const tenant = m['租客'];
  mt.setMany(m, { '狀態': '踢走待換', '空置起計': keyToDate(today), '備註': '前租客 ' + (tenant || '') + ' ' + (m['租客電話'] || '') + '，' + today + ' 踢走' });
  mt.setMany(m, { '租客': '', '租客電話': '', '月租': '' });
}

/* ---------------- 租客戶口（好似信用卡）同按金 ---------------- */

/** 計租客戶口：結欠 = 已出單租金 − 已付；負數即係預繳。按金另計，唔入結欠。 */
function accountOf(rt, codes, tenantName, today) {
  const period = periodOf(today);
  const recs = rt.rows.filter(r => (!codes || codes.indexOf(String(r['機號'])) >= 0) &&
    (!tenantName || String(r['租客']) === String(tenantName)) && NOT_BILLED.indexOf(String(r['狀態'])) < 0);
  const billed = recs.filter(r => String(r['期數']) <= period);
  const charged = billed.reduce((s, r) => s + Number(r['應收金額'] || 0), 0);
  const paid = recs.reduce((s, r) => s + Number(r['實收金額'] || 0), 0);
  const unpaid = billed.filter(r => outstanding(r) > 0)
    .sort((a, b) => cellKey(a['應收日']).localeCompare(cellKey(b['應收日'])));
  const overdue = unpaid.filter(r => cellKey(r['應收日']) < today).reduce((s, r) => s + outstanding(r), 0);
  const upcoming = unpaid.filter(r => cellKey(r['應收日']) >= today);
  const lastPaid = recs.filter(r => Number(r['實收金額']) > 0 && cellKey(r['實收日']))
    .sort((a, b) => cellKey(b['實收日']).localeCompare(cellKey(a['實收日'])))[0];
  return {
    balance: charged - paid, overdue, unpaid,
    next: upcoming.length ? { date: cellKey(upcoming[0]['應收日']), amount: upcoming.filter(r => cellKey(r['應收日']) === cellKey(upcoming[0]['應收日'])).reduce((s, r) => s + outstanding(r), 0) } : null,
    lastPay: lastPaid ? { date: cellKey(lastPaid['實收日']), amount: Number(lastPaid['實收金額']), code: lastPaid['機號'] } : null,
  };
}

function balanceLine(a) {
  if (a.balance < 0) return '💳 預繳餘額：' + money(-a.balance);
  return '💳 戶口結欠：' + money(a.balance) + (a.overdue > 0 ? '（其中逾期 ' + money(a.overdue) + '）' : '');
}

function depositRows_() { return table(S.DPT).rows; }

/** 呢部機、呢個租客而家仲持有幾多按金。 */
function depositHeld(code, tenant, rows) {
  return (rows || depositRows_())
    .filter(r => String(r['機號']) === code && (!tenant || String(r['租客']) === String(tenant)))
    .reduce((s, r) => s + (r['類別'] === '收按金' ? 1 : -1) * Number(r['金額'] || 0), 0);
}

/** 踢走之後機台總表冇咗租客名，由備註讀返前租客。 */
function tenantOf(m) {
  return String(m['租客'] || '') || ((String(m['備註'] || '').match(/前租客 (\S+)/) || [])[1] || '');
}

function statementText(name, machines, rt, today, forTenant) {
  const codes = machines.map(m => String(m['機號']));
  const a = accountOf(rt, name ? null : codes, name, today);
  const held = machines.reduce((s, m) => s + depositHeld(String(m['機號']), name), 0);
  const lines = ['📄 ' + (name || codes.join('、')) + ' 租金戶口（截至 ' + today + '）'];
  machines.filter(m => Number(m['月租']) > 0).forEach(m =>
    lines.push(m['機號'] + ' 月租 ' + money(m['月租']) + '，每月 ' + m['收租日'] + ' 號交'));
  lines.push('──────────');
  if (a.unpaid.length) {
    lines.push('未交期數：');
    a.unpaid.forEach(r => lines.push(r['機號'] + ' ' + r['期數'] + '（' + cellKey(r['應收日']).slice(5) + ' 到期）' +
      money(outstanding(r)) + (cellKey(r['應收日']) < today ? ' ⚠️逾期' : '')));
  } else lines.push('✅ 冇未交期數');
  lines.push('──────────');
  lines.push(balanceLine(a));
  if (a.overdue > 0) lines.push('請盡快交逾期 ' + money(a.overdue) + '，未交清唔可以入機。');
  if (name && coinStopOf_(rt, table(S.M), name, today)) lines.push('⛔ 欠租未清：暫停對幣俾現金，對幣會先扣欠租。');
  if (a.next) lines.push('下次到期：' + a.next.date + ' ' + money(a.next.amount));
  if (a.lastPay) lines.push('最近付款：' + a.lastPay.date + ' ' + money(a.lastPay.amount) + '（' + a.lastPay.code + '）');
  lines.push('按金（另計，唔可以當租）：' + money(held));
  if (forTenant) lines.push('交租後請回覆：交租 機號 金額，並附截圖');
  return lines.join('\n');
}

function cmdStatement(who, text, today) {
  const code = parseMachine(text);
  const mt = table(S.M);
  const rt = table(S.R);
  if (who.kind === 'unknown') return '你嘅號碼未登記，請聯絡舖頭同事。';
  if (who.kind === 'tenant') {
    let mine = mt.rows.filter(m => normPhone(m['租客電話']) === who.phone);
    if (code) mine = mine.filter(m => m['機號'] === code);
    if (!mine.length) return code ? code + ' 唔係登記喺你名下。' : '搵唔到登記喺你名下嘅機，請聯絡舖頭同事。';
    const name = String(mine[0]['租客'] || '');
    const all = name && !code ? mt.rows.filter(m => String(m['租客']) === name || normPhone(m['租客電話']) === who.phone) : mine;
    return statementText(code ? '' : name, all, rt, today, true);
  }
  if (!code) return '格式：結單 CWB-01（會列出呢個租客所有機）';
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  const name = tenantOf(m);
  const machines = name ? mt.rows.filter(x => String(x['租客']) === name) : [m];
  return statementText(name, machines.length ? machines : [m], rt, today, false);
}

function cmdDepositIn(who, text, receipt, today) {
  needStaff(who);
  const code = parseMachine(text);
  const amount = parseAmount(text);
  if (!code || !amount) return '格式：按金 CWB-01 5500 現金';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  if (!m['租客']) return code + ' 而家冇租客，請先用「租出」登記。';
  const method = parseMethod(text.replace(/按金/g, '')) || '現金';
  const dt = table(S.DPT);
  const id = nextId(dt, '按金ID', 'K');
  dt.append({ '按金ID': id, '日期': keyToDate(today), '機號': code, '舖': m['舖'], '租客': m['租客'], '類別': '收按金', '金額': amount, '方式': method, '經手': who.name, '備註': receipt || '' });
  addCashflow({ '舖': m['舖'], '機號': code, '紀錄ID': id }, amount, method, who.name, today, '按金 ' + method, '按金');
  const held = depositHeld(code, m['租客'], dt.rows);
  mt.set(m, '按金', held);
  return '✅ ' + code + ' ' + m['租客'] + ' 收按金 ' + money(amount) + '（' + method + '）\n按金另外記，唔會當租金。\n而家按金合共：' + money(held);
}

function cmdDepositOut(who, text, receipt, today) {
  if (who.kind !== 'owner') throw new Error('退按金只限老闆使用。');
  const code = parseMachine(text);
  const amount = parseAmount(text);
  if (!code || !amount) return '格式：退按 CWB-01 5500 FPS';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  const tenant = tenantOf(m);
  const dt = table(S.DPT);
  const held = depositHeld(code, tenant, dt.rows);
  if (amount > held + 0.001) return code + ' ' + tenant + ' 得返 ' + money(held) + ' 按金，唔可以退 ' + money(amount) + '。';
  const method = parseMethod(text) || 'FPS';
  const id = nextId(dt, '按金ID', 'K');
  dt.append({ '按金ID': id, '日期': keyToDate(today), '機號': code, '舖': m['舖'], '租客': tenant, '類別': '退按金', '金額': amount, '方式': method, '經手': who.name, '備註': receipt || '' });
  addCashflow({ '舖': m['舖'], '機號': code, '紀錄ID': id }, -amount, method, who.name, today, '退按金 ' + method, '退按金');
  if (m['租客']) mt.set(m, '按金', held - amount);
  return '✅ ' + code + ' ' + tenant + ' 退按金 ' + money(amount) + '（' + method + '）\n按金仲有：' + money(held - amount);
}

function cmdOffset(who, text, today) {
  if (who.kind !== 'owner') throw new Error('按金抵租只限老闆使用。');
  const code = parseMachine(text);
  if (!code) return '格式：按金抵租 CWB-01（可以加金額，例如 按金抵租 CWB-01 3000）';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  const tenant = tenantOf(m);
  const dt = table(S.DPT);
  const held = depositHeld(code, tenant, dt.rows);
  if (held <= 0) return code + ' ' + tenant + ' 冇按金可以抵。';
  const rt = table(S.R);
  const owing = rt.rows.filter(r => r['機號'] === code && String(r['租客']) === tenant &&
    ['欠租', '部份交', '踢走'].indexOf(String(r['狀態'])) >= 0 && outstanding(r) > 0)
    .sort((a, b) => String(a['期數']).localeCompare(String(b['期數'])));
  const debt = owing.reduce((s, r) => s + outstanding(r), 0);
  if (!debt) return code + ' ' + tenant + ' 冇逾期欠租，唔使抵。';
  let left = Math.min(held, debt, parseAmount(text) || Infinity);
  const used = left;
  const notes = [];
  owing.forEach(r => {
    if (left <= 0) return;
    const pay = Math.min(left, outstanding(r));
    const st = r['狀態'];
    applyPayment(rt, r, pay, '按金抵租', who.name, today, '', '按金抵租');
    if (st === '踢走' && outstanding(r) > 0) rt.set(r, '狀態', '踢走');
    notes.push(r['期數'] + ' 抵 ' + money(pay) + (outstanding(r) ? '，仲欠 ' + money(outstanding(r)) : ' 已清'));
    left -= pay;
  });
  const id = nextId(dt, '按金ID', 'K');
  dt.append({ '按金ID': id, '日期': keyToDate(today), '機號': code, '舖': m['舖'], '租客': tenant, '類別': '按金抵租', '金額': used, '方式': '按金轉撥', '經手': who.name, '備註': '' });
  if (m['租客']) { mt.set(m, '按金', held - used); refreshMachine(m, mt, rt, today, settings()); }
  return '✅ ' + code + ' ' + tenant + ' 用按金抵租 ' + money(used) + '\n' + notes.join('\n') +
    '\n按金仲有：' + money(held - used) + '\n' + balanceLine(accountOf(rt, [code], tenant, today));
}

function cmdStart(who, text, today) {
  needStaff(who);
  const code = parseMachine(text);
  const start = parseDate(text.replace(/(CWB|SSP|MK)\s*[-_ ]?\s*\d{1,3}/i, ' '), today);
  if (!code || !start) return '格式：起租 CWB-41 2026-12-01（或者 1/12）';
  const mt = table(S.M);
  const m = machineRow(mt, code);
  if (!m) return '搵唔到機號 ' + code;
  if (!m['租客'] || !Number(m['月租'])) return code + ' 而家冇租客，請用「租出」登記新租客同起租日。';
  const day = Number(start.slice(8));
  const rt = table(S.R);
  let voided = 0;
  rt.rows.filter(r => r['機號'] === code && String(r['租客']) === String(m['租客']) && !Number(r['實收金額']) &&
    ['未到期', '欠租'].indexOf(String(r['狀態'])) >= 0).forEach(r => {
    if (String(r['期數']) < periodOf(start)) {
      rt.setMany(r, { '狀態': '作廢', '備註': [r['備註'], '起租日改為 ' + start].filter(String).join('｜'), '更新時間': nowText() });
      voided++;
    } else {
      const due = String(r['期數']) === periodOf(start) ? start : dueKeyFor(String(r['期數']), day);
      rt.setMany(r, { '應收日': keyToDate(due), '狀態': due >= today ? '未到期' : '欠租', '更新時間': nowText() });
    }
  });
  mt.setMany(m, { '起租日': keyToDate(start), '收租日': day });
  const first = ensurePeriodRecord(rt, m, periodOf(start), today);
  if (!Number(first['實收金額'])) rt.setMany(first, { '應收日': keyToDate(start), '狀態': start >= today ? '未到期' : '欠租' });
  refreshMachine(m, mt, rt, today, settings());
  return '✅ ' + code + ' ' + m['租客'] + ' 起租日改為 ' + start + '，之後每月 ' + day + ' 號交。' +
    (voided ? '\n起租日之前未交嘅 ' + voided + ' 期已作廢。' : '') + '\n' + balanceLine(accountOf(rt, [code], m['租客'], today));
}

/* ---------------- 重算機台總表 ---------------- */

function refreshMachine(m, mt, rt, today, set) {
  const code = String(m['機號']);
  const recs = rt.rows.filter(r => r['機號'] === code);
  const unpaid = recs.filter(r => ['欠租', '部份交'].indexOf(String(r['狀態'])) >= 0 || (r['狀態'] === '未到期' && cellKey(r['應收日']) < today));
  unpaid.forEach(r => {
    const due = cellKey(r['應收日']);
    if (r['狀態'] === '未到期' && due < today) rt.set(r, '狀態', '欠租');
  });
  const owe = unpaid.reduce((s, r) => s + outstanding(r), 0);
  const oldestDue = unpaid.map(r => cellKey(r['應收日'])).filter(String).sort()[0];
  const days = oldestDue ? Math.max(0, daysBetween(oldestDue, today)) : 0;
  const cur = recs.filter(r => r['期數'] === periodOf(today) && r['狀態'] !== '待確認' && r['狀態'] !== '已確認')[0];
  let status = String(m['狀態'] || '');
  if (status === '出租中' && owe > 0 && days > 0) status = '欠租';
  if (status === '欠租' && owe === 0) status = '出租中';
  const vacant = ['空置', '踢走待換'].indexOf(status) >= 0;
  const vacSince = cellKey(m['空置起計']);
  const vals = {
    '狀態': status,
    '本期': cur ? cur['期數'] : '',
    '本期應收日': cur ? cur['應收日'] : '',
    '本期狀態': cur ? cur['狀態'] : '',
    '欠款': owe,
    '欠租日數': owe > 0 ? days : '',
    '可否入機': vacant ? '空置' : (owe > 0 && days > 0 ? '唔可以' : '可以'),
    '空置日數': vacant && vacSince ? daysBetween(vacSince, today) : '',
    '結欠': m['租客'] ? accountOf(rt, [code], m['租客'], today).balance : '',
  };
  Object.keys(vals).forEach(k => { if (String(m[k]) !== String(vals[k])) mt.set(m, k, vals[k]); });
  return { owe, days };
}

/** 每日全表重算：補開本月紀錄、更新狀態、計欠款。 */
function refreshAll(mt, rt, today, set) {
  const period = periodOf(today);
  mt.rows.forEach(m => {
    const startKey = cellKey(m['起租日']);
    if (['出租中', '欠租'].indexOf(String(m['狀態'])) >= 0 && Number(m['月租']) > 0 && (!startKey || periodOf(startKey) <= period)) ensurePeriodRecord(rt, m, period, today);
  });
  // 先喺記憶體改，最後一次過寫，避免逐格寫太慢。
  rt.rows.forEach(r => {
    if (r['狀態'] === '未到期' && cellKey(r['應收日']) && cellKey(r['應收日']) < today) r['狀態'] = '欠租';
  });
  rt.writeColumns(['狀態']);
  const byCode = {};
  rt.rows.forEach(r => { (byCode[r['機號']] = byCode[r['機號']] || []).push(r); });
  mt.rows.forEach(m => {
    const recs = byCode[m['機號']] || [];
    const unpaid = recs.filter(r => ['欠租', '部份交'].indexOf(String(r['狀態'])) >= 0);
    const owe = unpaid.reduce((s, r) => s + outstanding(r), 0);
    const oldest = unpaid.map(r => cellKey(r['應收日'])).filter(String).sort()[0];
    const days = oldest ? Math.max(0, daysBetween(oldest, today)) : 0;
    const cur = recs.filter(r => r['期數'] === period && ['待確認', '已確認'].indexOf(String(r['狀態'])) < 0)[0];
    let status = String(m['狀態'] || '');
    if (status === '出租中' && owe > 0 && days > 0) status = '欠租';
    if (status === '欠租' && owe === 0) status = '出租中';
    const vacant = ['空置', '踢走待換'].indexOf(status) >= 0;
    const vacSince = cellKey(m['空置起計']);
    Object.assign(m, {
      '狀態': status, '本期': cur ? cur['期數'] : '', '本期應收日': cur ? cur['應收日'] : '',
      '本期狀態': cur ? cur['狀態'] : '', '欠款': owe, '欠租日數': owe > 0 ? days : '',
      '可否入機': vacant ? '空置' : (owe > 0 && days > 0 ? '唔可以' : '可以'),
      '空置日數': vacant && vacSince ? daysBetween(vacSince, today) : '',
    });
  });
  const deps = depositRows_();
  mt.rows.forEach(m => {
    m['結欠'] = m['租客'] ? accountOf(rt, [String(m['機號'])], m['租客'], today).balance : '';
    m['按金'] = m['租客'] ? depositHeld(String(m['機號']), m['租客'], deps) || '' : '';
  });
  mt.writeColumns(['狀態', '本期', '本期應收日', '本期狀態', '欠款', '欠租日數', '可否入機', '空置日數', '結欠', '按金']);
  const tt = table(S.T);
  tt.rows.forEach(t => {
    const name = String(t['租客'] || '');
    if (!name) return;
    const a = accountOf(rt, null, name, today);
    Object.assign(t, {
      '結欠': a.balance, '逾期結欠': a.overdue,
      '按金': deps.filter(d => String(d['租客']) === name).reduce((s, d) => s + (d['類別'] === '收按金' ? 1 : -1) * Number(d['金額'] || 0), 0),
      '最後付款日': a.lastPay ? keyToDate(a.lastPay.date) : '', '最後付款金額': a.lastPay ? a.lastPay.amount : '', '更新時間': nowText(),
    });
  });
  tt.writeColumns(['結欠', '逾期結欠', '按金', '最後付款日', '最後付款金額', '更新時間']);
  refreshCrm_(tt, rt, today);
  refreshTurnover_(mt, tt, today);
  refreshCoinStop_(mt, tt, rt, today);
}

/* ---------------- 每日、每週 ---------------- */

function dailyRun() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return dailyRun_(todayKey()); } finally { lock.releaseLock(); }
}

function dailyRun_(today) {
  ensureSchema();
  const set = settings();
  const mt = table(S.M);
  const rt = table(S.R);
  refreshAll(mt, rt, today, set);

  // 第 N 日踢走
  const toKick = mt.rows.filter(m => m['狀態'] === '欠租' && Number(m['欠租日數']) >= set.kickDays);
  if (set.autoKick) toKick.forEach(m => kickMachine(m, mt, rt, today, '系統（欠租 ' + set.kickDays + ' 日）'));

  const shops = ['銅鑼灣', '深水埗', '旺角'];
  const ownerLines = [];
  shops.forEach(shop => {
    const owe = mt.rows.filter(m => m['舖'] === shop && m['狀態'] === '欠租' && Number(m['欠款']) > 0)
      .sort((a, b) => Number(b['欠租日數']) - Number(a['欠租日數']));
    const vac = mt.rows.filter(m => m['舖'] === shop && ['空置', '踢走待換'].indexOf(String(m['狀態'])) >= 0);
    const dueToday = rt.rows.filter(r => r['舖'] === shop && cellKey(r['應收日']) === today && r['狀態'] === '未到期');
    const lines = ['📋 ' + shop + ' ' + today + ' 收租提示'];
    if (dueToday.length) lines.push('今日應收 ' + dueToday.length + ' 部：' + dueToday.map(r => r['機號'] + ' ' + (r['租客'] || '') + ' $' + r['應收金額']).join('、'));
    if (owe.length) {
      lines.push('⚠️ 欠租 ' + owe.length + ' 部，請今日追：');
      owe.forEach(m => lines.push([m['機號'], m['租客'], m['租客電話']].filter(String).join(' ') + ' $' + m['欠款'] + '（第 ' + m['欠租日數'] + ' 日）' +
        (Number(m['欠租日數']) >= set.kickDays ? ' ⛔ 已到踢走日' : '')));
      lines.push('未交租嘅機唔好入機。收到租請打：收 機號 金額 方式');
    } else lines.push('✅ 冇欠租');
    if (vac.length) lines.push('🈳 空置 ' + vac.length + ' 部：' + vac.map(m => m['機號'] + (m['空置日數'] !== '' ? '(' + m['空置日數'] + '日)' : '')).join('、') + '，請盡快租出');
    const stopList = mt.rows.filter(m => m['舖'] === shop && m['可否對幣'] === '停止');
    if (stopList.length) lines.push('⛔ 欠租未清，唔好同佢對幣，要追租：' + stopList.map(m => m['機號'] + ' ' + m['租客']).join('、'));
    if (dueToday.length || owe.length || stopList.length) notifyStaff(shop, lines.join('\n'), set, shop + '：欠租 ' + owe.length + ' 部，今日應收 ' + dueToday.length + ' 部');

    owe.filter(m => Number(m['欠租日數']) >= set.ownerDays).forEach(m => ownerLines.push(
      [m['機號'], m['租客']].filter(String).join(' ') + ' $' + m['欠款'] + ' 第 ' + m['欠租日數'] + ' 日' +
      (Number(m['欠租日數']) >= set.kickDays ? (set.autoKick ? '（已自動標記踢走）' : '（已到踢走日，回覆「踢走 ' + m['機號'] + '」確認）') : '')));
  });
  const yest = dayKey(new Date(keyToDate(today).getTime() - 864e5));
  const closed = sheetRows_(S.DAY).filter(r => cellKey(r['日期']) === yest).map(r => r['舖']);
  const noClose = shops.filter(s => closed.indexOf(s) < 0);
  if (noClose.length) ownerLines.push('🧾 ' + yest + ' 未日結：' + noClose.join('、'));
  if (set.autoKick && toKick.length) ownerLines.push('今日自動踢走：' + toKick.map(m => m['機號']).join('、'));

  const cf = table(S.CF);
  const cashLate = cf.rows.filter(r => r['現金/銀行'] === '現金' && r['收支'] !== '支' && r['已入數'] !== '是' && cellKey(r['日期']) && daysBetween(cellKey(r['日期']), today) > set.cashDays);
  if (cashLate.length) {
    const by = {};
    cashLate.forEach(r => { by[r['經手']] = (by[r['經手']] || 0) + Number(r['金額']); });
    ownerLines.push('💵 現金超過 ' + set.cashDays + ' 日未入數：' + Object.keys(by).map(k => k + ' $' + by[k]).join('、'));
  }
  if (ownerLines.length) notifyOwner('🔔 ' + today + ' 收租警示\n' + ownerLines.join('\n'), set, ownerLines.length + ' 項收租警示');

  if (set.remindTenant) remindTenants_(mt, rt, today, set);
  if (set.overdueTenantDaily) remindOverdueTenants_(mt, rt, today, set);
  return { overdue: mt.rows.filter(m => m['狀態'] === '欠租').length, owner: ownerLines.length };
}

function remindTenants_(mt, rt, today, set) {
  const soon = dayKey(new Date(keyToDate(today).getTime() + 2 * 864e5));
  const phones = {};
  rt.rows.filter(r => r['狀態'] === '未到期' && cellKey(r['應收日']) === soon).forEach(r => {
    const m = machineRow(mt, String(r['機號']));
    if (m && normPhone(m['租客電話'])) phones[normPhone(m['租客電話'])] = true;
  });
  Object.keys(phones).forEach(p => {
    const mine = mt.rows.filter(m => normPhone(m['租客電話']) === p);
    const text = '你好，提提你租金將於 ' + soon + ' 到期。\n' + statementText(String(mine[0]['租客'] || ''), mine, rt, today, true);
    sendWhatsApp(p, text, set, mine.map(m => m['機號']).join('、') + ' 租金將於 ' + soon + ' 到期', set.tenantTemplate || set.staffTemplate);
  });
}

/** 欠租由第 1 日起，每日 WhatsApp 提租客一次（按金得 $1,000，唔可以等）。 */
function remindOverdueTenants_(mt, rt, today, set) {
  const done = {};
  mt.rows.filter(m => m['狀態'] === '欠租' && Number(m['欠款']) > 0 && Number(m['欠租日數']) > 0 && normPhone(m['租客電話'])).forEach(m => {
    const p = normPhone(m['租客電話']);
    if (done[p]) return;
    done[p] = true;
    const mine = mt.rows.filter(x => normPhone(x['租客電話']) === p);
    const days = Math.max.apply(null, mine.map(x => Number(x['欠租日數']) || 0));
    const owe = mine.reduce((s, x) => s + Number(x['欠款'] || 0), 0);
    const text = '你好，你嘅租金已經逾期 ' + days + ' 日，欠 ' + money(owe) + '。請今日交租，交咗回覆：交租 機號 金額 並附截圖。\n' +
      '未交清之前唔可以入機，對幣都會先扣欠租。\n' + statementText(String(mine[0]['租客'] || ''), mine, rt, today, true);
    sendWhatsApp(p, text, set, mine.map(x => x['機號']).join('、') + ' 租金逾期 ' + days + ' 日，欠 ' + money(owe), set.tenantTemplate || set.staffTemplate);
  });
}

function weeklyRun() { return weeklyRun_(todayKey()); }

function weeklyRun_(today) {
  ensureSchema();
  const set = settings();
  const mt = table(S.M);
  const rt = table(S.R);
  refreshAll(mt, rt, today, set);
  const period = periodOf(today);
  const cf = table(S.CF);
  const wk = table(S.WK);
  const lines = ['📊 每週收租報表（' + period + '，截至 ' + today + '）'];
  ['銅鑼灣', '深水埗', '旺角'].forEach(shop => {
    const recs = rt.rows.filter(r => r['舖'] === shop && r['期數'] === period && ['待確認', '已確認', '踢走', '分成'].indexOf(String(r['狀態'])) < 0);
    const due = recs.reduce((s, r) => s + Number(r['應收金額'] || 0), 0);
    const got = recs.reduce((s, r) => s + Number(r['實收金額'] || 0), 0);
    const oweM = mt.rows.filter(m => m['舖'] === shop && m['狀態'] === '欠租');
    const oweAmt = oweM.reduce((s, m) => s + Number(m['欠款'] || 0), 0);
    const vac = mt.rows.filter(m => m['舖'] === shop && ['空置', '踢走待換'].indexOf(String(m['狀態'])) >= 0).length;
    const cash = cf.rows.filter(r => r['舖'] === shop && r['現金/銀行'] === '現金' && r['收支'] !== '支' && r['已入數'] !== '是').reduce((s, r) => s + Number(r['金額']), 0);
    const rate = due ? got / due : 0;
    wk.append({ '週開始': keyToDate(today), '舖': shop, '應收': due, '實收': got, '收租率': rate, '欠租部數': oweM.length, '欠租金額': oweAmt, '空置部數': vac, '現金未入數': cash, '產生時間': nowText() });
    lines.push(shop + '：應收 $' + due + '，實收 $' + got + '（' + Math.round(rate * 100) + '%），欠租 ' + oweM.length + ' 部 $' + oweAmt + '，空置 ' + vac + ' 部，現金未入數 $' + cash);
  });
  const rep = weeklyReport_(today);
  notifyOwner(lines.join('\n') + '\n\n' + rep.join('\n'), set, '每週報表已更新');
  return lines.concat([''], rep);
}

/* ---------------- WhatsApp ---------------- */

function props_() { return PropertiesService.getScriptProperties(); }

function waCall_(payload) {
  const p = props_();
  if (p.getProperty('DRY_RUN') === '1') return { ok: true, dry: true };
  const res = UrlFetchApp.fetch('https://graph.facebook.com/v21.0/' + p.getProperty('WA_PHONE_ID') + '/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + p.getProperty('WA_TOKEN') },
    payload: JSON.stringify(Object.assign({ messaging_product: 'whatsapp' }, payload)),
  });
  const code = res.getResponseCode();
  return { ok: code >= 200 && code < 300, code, body: res.getContentText() };
}

/**
 * 發 WhatsApp。先試普通文字（對方 24 小時內有傳過嚟就得）；
 * 唔得就用 Meta 審批咗嘅範本，範本內容係一句摘要（範本參數唔可以有換行）。
 */
function sendWhatsApp(to, text, set, summary, template) {
  const r = waCall_({ to, type: 'text', text: { body: text.slice(0, 4000) } });
  let result = r.ok ? (r.dry ? '測試模式，未發' : '已發') : '文字發唔到 ' + r.code;
  const tpl = template || (set && set.staffTemplate);
  if (!r.ok && tpl) {
    const r2 = waCall_({
      to, type: 'template',
      template: { name: tpl, language: { code: (set && set.lang) || 'zh_HK' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: String(summary || text).replace(/\s*\n\s*/g, '；').slice(0, 900) }] }] },
    });
    result = r2.ok ? '已發範本' : '範本都發唔到 ' + r2.code + ' ' + String(r2.body).slice(0, 200);
  }
  logMessage('發', to, '', text, result);
  return result;
}

function notifyStaff(shop, text, set, summary) {
  set = set || settings();
  table(S.STAFF).rows
    .filter(r => r['角色'] === '同事' && (r['舖'] === shop || r['舖'] === '全部') && /^\d{11,}$/.test(normPhone(r['WhatsApp'])))
    .forEach(r => sendWhatsApp(normPhone(r['WhatsApp']), text, set, summary || text, set.staffTemplate));
}

function notifyOwner(text, set, summary) {
  set = set || settings();
  table(S.STAFF).rows
    .filter(r => r['角色'] === '老闆' && /^\d{11,}$/.test(normPhone(r['WhatsApp'])))
    .forEach(r => sendWhatsApp(normPhone(r['WhatsApp']), text, set, summary || text, set.ownerTemplate || set.staffTemplate));
}

function logMessage(dir, phone, name, text, result) {
  try {
    table(S.LOG).append({ '時間': nowText(), '方向': dir, '電話': phone, '姓名': name, '內容': String(text).slice(0, 2000), '結果': String(result).slice(0, 2000) });
  } catch (e) { /* 記錄失敗唔好阻住主流程 */ }
}

/* ---------------- Webhook（由 Cloudflare Worker 轉發） ---------------- */

function doPost(e) {
  const out = ContentService.createTextOutput('ok');
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out; }
  if (!body || body.secret !== props_().getProperty('RELAY_SECRET')) return ContentService.createTextOutput('forbidden');
  processWebhook(body.payload);
  return out;
}

function doGet() { return ContentService.createTextOutput('收租機械人運作中'); }

function processWebhook(payload) {
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  ((payload && payload.entry) || []).forEach(entry => (entry.changes || []).forEach(ch => {
    const v = ch.value || {};
    (v.messages || []).forEach(msg => {
      if (cache.get('m:' + msg.id)) return; // Meta 會重送，避免重複記帳
      cache.put('m:' + msg.id, '1', 21600);
      let text = '', receipt = '';
      if (msg.type === 'text') text = msg.text.body;
      else if (msg.type === 'image') { text = msg.image.caption || ''; receipt = 'image:' + msg.image.id; }
      else if (msg.type === 'document') { text = msg.document.caption || ''; receipt = 'doc:' + msg.document.id; }
      else if (msg.type === 'button') text = msg.button.text;
      else if (msg.type === 'interactive') text = (msg.interactive.button_reply || msg.interactive.list_reply || {}).title || '';
      else return;
      if (receipt) receipt = saveReceipt_(receipt, msg.from);
      lock.waitLock(30000);
      let reply;
      try { reply = handleMessage(msg.from, text, receipt); } finally { lock.releaseLock(); }
      sendWhatsApp(msg.from, reply, settings(), reply);
    });
  }));
}

/* ---------------- 安裝 ---------------- */

/** 喺 Apps Script 編輯器揀呢個 function 撳「執行」一次，就會設定每日同每週自動執行。 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['dailyRun', 'weeklyRun'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  const hour = settings().hour;
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(hour).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklyRun').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone(TZ).create();
  return '已設定：每日 ' + hour + ':00 追租，每星期一 9:00 週報';
}

/** 試算表選單：唔使 WhatsApp 都可以手動行。 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('收租系統')
    .addItem('立即重算機台總表', 'menuRefresh')
    .addItem('立即發今日追租提示', 'dailyRun')
    .addItem('立即出週報', 'weeklyRun')
    .addItem('對銀行月結單（對數）', 'menuRecon')
    .addItem('設定自動執行（第一次用）', 'installTriggers')
    .addToUi();
}

function menuRefresh() { ensureSchema(); refreshAll(table(S.M), table(S.R), todayKey(), settings()); }
function menuRecon() { ensureSchema(); SpreadsheetApp.getUi().alert(reconSummary_(reconcile_(todayKey()))); }

/** 測試：喺編輯器執行，模擬一條 WhatsApp（DRY_RUN=1 時唔會真發）。 */
function testMessage() {
  const owner = table(S.STAFF).rows.find(r => r['角色'] === '老闆');
  Logger.log(handleMessage(normPhone(owner['WhatsApp']), '查 CWB-01', ''));
}

/* =====================================================================
 * CRM：租客檔案、信用、跟進
 * ===================================================================== */

function tenantRecord_(who) {
  const tt = table(S.T);
  return tt.rows.find(r => normPhone(r['電話']) === who.phone && who.phone) ||
    tt.rows.find(r => String(r['租客']) === who.name && who.name) || null;
}

function tenantByName_(tt, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return tt.rows.find(r => String(r['租客']).toLowerCase() === n) ||
    tt.rows.find(r => String(r['租客']).toLowerCase().indexOf(n) >= 0) ||
    tt.rows.find(r => String(r['租客ID']).toLowerCase() === n) || null;
}

function machinesOf_(mt, name) { return mt.rows.filter(m => String(m['租客']) === String(name)); }

function shopsOfTenant_(name) {
  const out = [];
  machinesOf_(table(S.M), name).forEach(m => { if (out.indexOf(String(m['舖'])) < 0) out.push(String(m['舖'])); });
  return out;
}

/** 過去 6 個月嘅交租表現。 */
function creditOf_(rt, name, today) {
  const from = periodOf(dayKey(new Date(keyToDate(today).getTime() - 183 * 864e5)));
  const recs = rt.rows.filter(r => String(r['租客']) === String(name) && String(r['期數']) >= from &&
    NOT_BILLED.indexOf(String(r['狀態'])) < 0 && r['狀態'] !== '踢走' && cellKey(r['應收日']) && cellKey(r['應收日']) < today);
  let onTime = 0, lateDays = 0, lateN = 0;
  recs.forEach(r => {
    const due = cellKey(r['應收日']), paid = cellKey(r['實收日']);
    const done = outstanding(r) === 0 && paid;
    const late = done ? daysBetween(due, paid) : daysBetween(due, today);
    if (done && late <= 0) onTime++;
    if (late > 0) { lateDays += late; lateN++; }
  });
  const rate = recs.length ? onTime / recs.length : null;
  return { periods: recs.length, rate, avgLate: lateN ? Math.round(lateDays / lateN) : 0 };
}

function riskOf_(a, c) {
  const late = a.unpaid.filter(r => cellKey(r['應收日']) < a.today).length;
  if (a.overdue > 0 && (a.overdueDays >= 5 || (c.rate !== null && c.rate < 0.5))) return '紅';
  if (a.overdue > 0 || late > 1 || (c.rate !== null && c.rate < 0.8)) return '黃';
  return '綠';
}

/** 寫返「租客」分頁嘅 CRM 計算欄。 */
function refreshCrm_(tt, rt, today) {
  const bank = sheetRows_(S.BANK);
  tt.rows.forEach((t, i) => {
    const name = String(t['租客'] || '');
    if (!name) return;
    if (!t['租客ID']) t['租客ID'] = 'T' + String(i + 1).padStart(3, '0');
    const a = accountOf(rt, null, name, today);
    const oldest = a.unpaid.map(r => cellKey(r['應收日'])).filter(k => k && k < today).sort()[0];
    a.overdueDays = oldest ? daysBetween(oldest, today) : 0;
    a.today = today;
    const c = creditOf_(rt, name, today);
    const pend = rt.rows.filter(r => String(r['租客']) === name && r['對數狀態'] === '未見入帳').length +
      bank.filter(b => String(b['對應租客']) === name && ['建議配對', '對唔到'].indexOf(String(b['對數狀態'])) >= 0).length;
    Object.assign(t, {
      '準時率': c.rate === null ? '' : Math.round(c.rate * 100) / 100, '平均遲交日數': c.avgLate,
      '風險': riskOf_(a, c), '對數待處理': pend || '', 'AI': t['AI'] || '開',
    });
  });
  tt.writeColumns(['租客ID', '準時率', '平均遲交日數', '風險', '對數待處理', 'AI']);
}

function sheetRows_(name) {
  try { return table(name).rows; } catch (e) { return []; }
}

function crmCardText_(t, today) {
  const mt = table(S.M), rt = table(S.R);
  const name = String(t['租客']);
  const machines = machinesOf_(mt, name);
  const c = creditOf_(rt, name, today);
  const lines = ['👤 ' + name + (t['全名'] ? '（' + t['全名'] + '）' : '') + '　' + (t['租客ID'] || '') + '　風險：' + (t['風險'] || '-')];
  lines.push('📞 ' + (t['電話'] || '未有 WhatsApp') + (t['後備電話'] ? ' / ' + t['後備電話'] : '') + '　偏好：' + (t['聯絡偏好'] || 'WhatsApp'));
  lines.push('🏦 ' + [t['付款方式'], t['付款銀行'], t['戶口尾數'] ? '尾數 ' + t['戶口尾數'] : '', t['入數名'] ? '入數名 ' + t['入數名'] : ''].filter(String).join('　') || '🏦 未有入數資料');
  lines.push('🎰 ' + machines.length + ' 部：' + machines.map(m => m['機號']).join('、'));
  lines.push('📈 準時率 ' + (c.rate === null ? '-' : Math.round(c.rate * 100) + '%') + '（近 ' + c.periods + ' 期），遲交平均 ' + c.avgLate + ' 日');
  lines.push(balanceLine(accountOf(rt, null, name, today)));
  if (t['對數待處理']) lines.push('🔎 對數待處理 ' + t['對數待處理'] + ' 筆');
  if (String(t['對幣狀態']).indexOf('停止') === 0) lines.push('⛔ 欠租未清：唔好同佢對幣（要用對幣抵租），要追租');
  const tv = turnoverOf_(name, today);
  if (tv.months.some(x => x.total)) lines.push('🪙 生意額：本月 ' + money(tv.thisMonth) + '　上月 ' + money(tv.lastMonth) + '　近 3 個月平均 ' + money(tv.avg3) +
    (tv.ratio !== null ? '　租金佔 ' + Math.round(tv.ratio * 100) + '%' : '') + (tv.ratio !== null && tv.ratio >= 0.8 ? ' ⚠️' : ''));
  const fu = sheetRows_(S.FU).filter(f => String(f['租客']) === name).slice(-3).reverse();
  if (fu.length) {
    lines.push('📝 最近跟進：');
    fu.forEach(f => lines.push('・' + cellKey(f['日期']) + ' ' + f['類型'] + '：' + f['內容']));
  }
  if (t['下次跟進']) lines.push('⏰ 下次跟進：' + cellKey(t['下次跟進']));
  if (String(t['AI']) === '關') lines.push('🙋 同事接手中（AI 暫停）');
  return lines.join('\n');
}

function cmdCrm(who, text, today) {
  needStaff(who);
  const q = normText(text).replace(/^客戶\s*/, '');
  if (!q) return '格式：客戶 白豬（或者 客戶 CWB-01）';
  const tt = table(S.T);
  let t = tenantByName_(tt, q);
  const code = parseMachine(q);
  if (!t && code) {
    const m = machineRow(table(S.M), code);
    if (m) t = tenantByName_(tt, tenantOf(m));
  }
  if (!t) return '搵唔到租客「' + q + '」';
  return crmCardText_(t, today);
}

function addFollowUp_(name, type, content, by, nextStep, nextDate) {
  const fu = table(S.FU);
  fu.append({ '日期': new Date(), '租客': name, '類型': type, '內容': content, '經手': by, '下一步': nextStep || '', '下次跟進': nextDate ? keyToDate(nextDate) : '' });
  if (nextDate) {
    const tt = table(S.T);
    const t = tenantByName_(tt, name);
    if (t) tt.set(t, '下次跟進', keyToDate(nextDate));
  }
}

function cmdFollowUp(who, text, today) {
  needStaff(who);
  const rest = normText(text).replace(/^跟進\s*/, '');
  const name = rest.split(/\s+/)[0];
  const tt = table(S.T);
  const t = tenantByName_(tt, name);
  if (!t) return '格式：跟進 白豬 已打電話，答應星期五交 2026-11-21';
  let content = rest.slice(name.length).trim();
  const dm = content.match(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(\/\d{4})?)\s*$/);
  const next = dm ? parseDate(dm[1], today) : '';
  if (dm) content = content.slice(0, dm.index).trim();
  if (!content) return '要寫跟進內容，例如：跟進 白豬 已打電話';
  addFollowUp_(String(t['租客']), '同事', content, who.name, '', next);
  return '📝 已記錄 ' + t['租客'] + ' 跟進' + (next ? '，下次跟進 ' + next : '') + '。';
}

/* =====================================================================
 * 對幣：租客部機收到嘅 $5 硬幣喺舖頭換紙幣，對幣金額 = 嗰部機嘅生意額
 * ===================================================================== */

/** 由「對幣 CWB-01 3200 CWB-34 640個」讀出每部機嘅金額。 */
function parseCoinPairs_(text, coinValue) {
  const t = normText(text).replace(/^(對幣|找幣|換幣)\s*/, '');
  const re = /(CWB|SSP|MK|銅鑼灣|波斯富街?|深水埗|玩具街?|旺角|西洋菜街?)\s*[-_ ]?\s*(\d{1,3})\s*號?\s*[:：]?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(個|粒|枚|pcs)?/ig;
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const code = parseMachine(m[1] + '-' + m[2]);
    const n = Number(m[3].replace(/,/g, ''));
    out.push(m[4] ? { code, coins: n, amount: n * coinValue } : { code, coins: Math.round(n / coinValue), amount: n });
  }
  return out;
}

/** 欠租（最舊逾期 ≥ 停止對幣日數而且欠款多過按金，或者逾期多過一個月租）就唔好同佢對幣。按金得 $1,000，所以預設逾期第 1 日就停。 */
function coinStopOf_(rt, mt, name, today) {
  if (!name) return null;
  const a = accountOf(rt, null, name, today);
  if (!(a.overdue > 0)) return null;
  const rent = machinesOf_(mt, name).reduce((s, m) => s + Number(m['月租'] || 0), 0);
  const oldest = a.unpaid.map(r => cellKey(r['應收日'])).filter(k => k && k < today).sort()[0];
  const days = oldest ? daysBetween(oldest, today) : 0;
  const set = settings();
  const held = machinesOf_(mt, name).reduce((s, m) => s + depositHeld(String(m['機號']), name), 0);
  if ((days >= set.stopDays && a.overdue > held) || (rent > 0 && a.overdue > rent)) return { overdue: a.overdue, days, balance: a.balance, held };
  return null;
}

function refreshCoinStop_(mt, tt, rt, today) {
  const stop = {};
  tt.rows.forEach(t => {
    const name = String(t['租客'] || '');
    if (!name) return;
    const s = coinStopOf_(rt, mt, name, today);
    stop[name] = s;
    t['對幣狀態'] = s ? '停止：欠租未清' : '可以';
  });
  tt.writeColumns(['對幣狀態']);
  mt.rows.forEach(m => { m['可否對幣'] = m['租客'] ? (stop[String(m['租客'])] ? '停止' : '可以') : ''; });
  mt.writeColumns(['可否對幣']);
}

/**
 * 對幣：租客部機嘅 $5 幣換紙幣。金額 = 生意額。
 * offset = true（對幣抵租）：先扣欠租，淨低先俾台主。
 * 欠租未清：普通對幣唔俾錢，要用對幣抵租。
 */
function cmdCoin(who, text, today, receipt, offset) {
  needStaff(who);
  const set = settings();
  const pairs = parseCoinPairs_(String(text).replace(/^(對幣抵租|對幣扣租)/, '對幣'), set.coinValue);
  if (!pairs.length) return offset ? '格式：對幣抵租 CWB-01 3200（先扣欠租，淨低俾台主）' :
    '格式：對幣 CWB-01 3200（金額）或者 對幣 CWB-01 640個（幣數）。幾部機可以一齊寫：對幣 CWB-01 3200 CWB-34 2800';
  const date = parseDate(text.replace(/(CWB|SSP|MK)\s*[-_ ]?\s*\d{1,3}/ig, ' '), today) || today;
  const said = /轉帳|轉賬|FPS|入數/i.test(text) ? '轉帳' : /現金/.test(text) ? '現金' : '';
  const tt0 = table(S.T);
  const mt = table(S.M), ct = table(S.COIN), rt = table(S.R);
  const lines = [], bad = [];
  let paidOut = 0, offTotal = 0, held = 0;
  pairs.forEach(p => {
    const m = machineRow(mt, p.code);
    if (!m) { bad.push(p.code); return; }
    const name = String(m['租客'] || '');
    const id = nextId(ct, '對幣ID', 'C');
    const stop = coinStopOf_(rt, mt, name, today);
    const tr0 = name ? tenantByName_(tt0, name) : null;
    const payMethod = said || (tr0 && /FPS|轉帳/.test(String(tr0['付款方式'])) ? '轉帳' : '現金');
    if (!offset && stop) {
      // 欠租：唔記、唔俾錢，等同事改用對幣抵租（避免同一批幣記兩次）
      held++;
      lines.push('⛔ 未記｜' + m['舖'] + '｜' + p.code + '｜' + name + '：欠租未清（逾期 ' + money(stop.overdue) + '，第 ' + stop.days + ' 日，按金得 ' + money(stop.held) + '）。\n　唔好俾錢！請改用：對幣抵租 ' + p.code + ' ' + p.amount);
      return;
    }
    let off = 0, notes = [];
    if (offset && name) {
      // 先扣呢部機，再扣同一租客其他機
      const ms = [m].concat(machinesOf_(mt, name).filter(x => x !== m));
      let left = p.amount;
      ms.forEach(x => {
        const owe = Math.max(0, accountOf(rt, [String(x['機號'])], name, today).unpaid.reduce((s, r) => s + outstanding(r), 0));
        const pay = Math.min(left, owe);
        if (pay > 0) { notes = notes.concat(allocate(rt, x, pay, '對幣', who.name, today, receipt, '對幣 ' + id).map(n => x['機號'] + ' ' + n)); left -= pay; off += pay; }
      });
    }
    const hold = false;
    const out = p.amount - off;
    ct.append({ '對幣ID': id, '日期': keyToDate(date), '舖': m['舖'], '機號': p.code, '租客': name, '幣數': p.coins, '金額': p.amount, '經手': who.name,
      '備註': name ? '' : '空置機', '抵租': off || '', '俾台主': out || '', '付款方式': out ? payMethod : '',
      '處理': hold ? '暫停俾錢：欠租未清' : off ? '已抵租' : '已俾台主', '單據': receipt || '' });
    if (out > 0) addExpense_({ date: today, shop: m['舖'], category: '對幣俾台主', code: p.code, amount: out, method: payMethod, by: who.name, ref: id, tenant: name, receipt, note: '對幣 ' + id });
    paidOut += out; offTotal += off;
    const tv = machineTurnover_(ct.rows, p.code, periodOf(date));
    const tot = machineCoinTotals_(ct.rows, p.code);
    mt.setMany(m, { '累計兌幣': tot.total, '兌幣次數': tot.count, '最後兌幣日': keyToDate(date), '最後兌幣金額': p.amount });
    lines.push('🪙 ' + id + '｜' + m['舖'] + '｜' + p.code + (name ? '｜' + name : '') + '\n　兌幣 ' + p.coins + ' 個 = ' + money(p.amount) +
      '\n　呢部機：本月累計 ' + money(tv) + '｜總累計 ' + money(tot.total) + '（' + tot.count + ' 次）');
    if (off) lines.push('　↳ 抵租 ' + money(off) + '：' + notes.join('；'));
    if (out) lines.push('　↳ 俾台主 ' + money(out) + '（' + payMethod + '）');
    if (!offset && !hold && name) {
      const bal = accountOf(rt, null, name, today);
      if (bal.overdue > 0) lines.push('　💡 ' + name + ' 仲有逾期 ' + money(bal.overdue) + '，可以用「對幣抵租」先扣。');
    }
  });
  if (!lines.length) return '搵唔到機號 ' + bad.join('、');
  refreshCoinStop_(mt, table(S.T), rt, today);
  const many = pairs.length - bad.length - held > 1;
  if (held === pairs.length - bad.length) return lines.join('\n') + (bad.length ? '\n⚠️ 搵唔到：' + bad.join('、') : '');
  return '✅ 已記對幣（' + date + '）\n' + lines.join('\n') + (bad.length ? '\n⚠️ 搵唔到：' + bad.join('、') : '') +
    (many ? '\n合共生意 ' + money(pairs.filter(p => bad.indexOf(p.code) < 0).reduce((s, p) => s + p.amount, 0)) : '') +
    (many || offTotal ? '\n合共抵租 ' + money(offTotal) + '，俾台主 ' + money(paidOut) : '') + photoHint_(receipt, pairs[0].code);
}

/** 每部機嘅兌幣累計（全部紀錄）。 */
function machineCoinTotals_(rows, code) {
  const mine = rows.filter(c => String(c['機號']) === code);
  const last = mine.slice().sort((a, b) => (cellKey(a['日期']) || '').localeCompare(cellKey(b['日期']) || '')).pop();
  return { total: mine.reduce((s, c) => s + Number(c['金額'] || 0), 0), count: mine.length,
    lastDate: last ? cellKey(last['日期']) : '', lastAmt: last ? Number(last['金額'] || 0) : 0 };
}

function machineTurnover_(rows, code, period) {
  return rows.filter(c => String(c['機號']) === code && periodOf(cellKey(c['日期']) || '') === period)
    .reduce((s, c) => s + Number(c['金額'] || 0), 0);
}

function prevPeriod_(period, n) {
  let [y, m] = period.split('-').map(Number);
  m -= (n === undefined ? 1 : n);
  while (m < 1) { m += 12; y--; }
  return y + '-' + String(m).padStart(2, '0');
}

/** 一位租客（或者一部機）近幾個月嘅生意額。 */
function turnoverOf_(name, today, codes, rows) {
  rows = rows || sheetRows_(S.COIN);
  const mine = rows.filter(c => codes ? codes.indexOf(String(c['機號'])) >= 0 : String(c['租客']) === String(name));
  const cur = periodOf(today);
  const months = [0, 1, 2, 3, 4, 5].map(i => {
    const p = prevPeriod_(cur, i);
    return { period: p, total: mine.filter(c => periodOf(cellKey(c['日期']) || '') === p).reduce((s, c) => s + Number(c['金額'] || 0), 0) };
  });
  const full = months.slice(1, 4).filter(x => x.total);
  const avg3 = full.length ? Math.round(full.reduce((s, x) => s + x.total, 0) / full.length) : 0;
  const mt = table(S.M);
  const rent = (codes ? codes.map(c => machineRow(mt, c)).filter(Boolean) : machinesOf_(mt, name))
    .reduce((s, m) => s + Number(m['月租'] || 0), 0);
  const byMachine = {};
  mine.filter(c => periodOf(cellKey(c['日期']) || '') === cur).forEach(c => { byMachine[c['機號']] = (byMachine[c['機號']] || 0) + Number(c['金額'] || 0); });
  return { months, thisMonth: months[0].total, lastMonth: months[1].total, avg3, rent, ratio: avg3 ? rent / avg3 : null, byMachine, count: mine.length };
}

/** 寫返「機台總表」同「租客」嘅生意額欄。 */
function refreshTurnover_(mt, tt, today) {
  let rows;
  try { rows = table(S.COIN).rows; } catch (e) { return; }
  const cur = periodOf(today), last = prevPeriod_(cur, 1);
  mt.rows.forEach(m => {
    m['本月生意額'] = machineTurnover_(rows, String(m['機號']), cur) || '';
    m['上月生意額'] = machineTurnover_(rows, String(m['機號']), last) || '';
    const ct = machineCoinTotals_(rows, String(m['機號']));
    m['累計兌幣'] = ct.total || ''; m['兌幣次數'] = ct.count || ''; m['最後兌幣日'] = ct.lastDate ? keyToDate(ct.lastDate) : ''; m['最後兌幣金額'] = ct.lastAmt || '';
  });
  mt.writeColumns(['本月生意額', '上月生意額', '累計兌幣', '兌幣次數', '最後兌幣日', '最後兌幣金額']);
  tt.rows.forEach(t => {
    if (!t['租客']) return;
    const tv = turnoverOf_(String(t['租客']), today, null, rows);
    Object.assign(t, {
      '本月生意額': tv.thisMonth || '', '上月生意額': tv.lastMonth || '', '平均月生意額': tv.avg3 || '',
      '租金佔生意額': tv.ratio === null ? '' : Math.round(tv.ratio * 100) / 100,
    });
  });
  tt.writeColumns(['本月生意額', '上月生意額', '平均月生意額', '租金佔生意額']);
}

function turnoverText_(title, tv, today) {
  const lines = ['🪙 ' + title + ' 生意額（對幣）'];
  tv.months.slice(0, 4).forEach((x, i) => lines.push(x.period + (i === 0 ? '（至 ' + today.slice(8) + ' 號）' : '') + '：' + money(x.total)));
  lines.push('近 3 個月平均：' + money(tv.avg3));
  if (tv.rent) lines.push('月租合共 ' + money(tv.rent) + (tv.ratio !== null ? '，佔生意額 ' + Math.round(tv.ratio * 100) + '%' + (tv.ratio >= 0.8 ? ' ⚠️ 偏高' : '') : ''));
  const bm = Object.keys(tv.byMachine);
  if (bm.length > 1) lines.push('本月逐部：' + bm.sort().map(c => c + ' ' + money(tv.byMachine[c])).join('、'));
  return lines.join('\n');
}

function cmdTurnover(who, text, today) {
  const q = normText(text).replace(/^(生意額?|營業額)\s*/, '');
  if (who.kind === 'tenant') {
    const t = tenantRecord_(who);
    if (!t) return '搵唔到你嘅租客資料，請聯絡同事。';
    return turnoverText_(String(t['租客']), turnoverOf_(String(t['租客']), today), today);
  }
  needStaff(who);
  const code = parseMachine(q);
  if (code) {
    const m = machineRow(table(S.M), code);
    if (!m) return '搵唔到機號 ' + code;
    return turnoverText_(code + (m['租客'] ? ' ' + m['租客'] : ''), turnoverOf_(null, today, [code]), today);
  }
  const shop = parseShop(q);
  if (q && !shop) {
    const t = tenantByName_(table(S.T), q);
    if (!t) return '搵唔到「' + q + '」。格式：生意 / 生意 旺角 / 生意 白豬 / 生意 CWB-01';
    return turnoverText_(String(t['租客']), turnoverOf_(String(t['租客']), today), today);
  }
  // 全部或者一間舖：每間舖合計 + 本月最高 / 最低嘅機
  const rows = sheetRows_(S.COIN);
  const cur = periodOf(today), last = prevPeriod_(cur, 1);
  const mt = table(S.M);
  const shops = shop ? [shop] : Object.keys(SHOP_CODES).map(k => SHOP_CODES[k]);
  const lines = ['🪙 生意額（對幣）　本月至 ' + today.slice(5)];
  shops.forEach(s => {
    const sum = p => rows.filter(c => String(c['舖']) === s && periodOf(cellKey(c['日期']) || '') === p).reduce((a, c) => a + Number(c['金額'] || 0), 0);
    lines.push(s + '：本月 ' + money(sum(cur)) + '　上月 ' + money(sum(last)));
  });
  const ms = mt.rows.filter(m => m['租客'] && shops.indexOf(String(m['舖'])) >= 0)
    .map(m => ({ code: String(m['機號']), name: m['租客'], v: machineTurnover_(rows, String(m['機號']), last), rent: Number(m['月租'] || 0) }))
    .filter(x => x.v);
  if (ms.length) {
    ms.sort((a, b) => b.v - a.v);
    lines.push('上月最好：' + ms.slice(0, 3).map(x => x.code + ' ' + x.name + ' ' + money(x.v)).join('、'));
    const weak = ms.filter(x => x.rent && x.rent / x.v >= 0.8);
    if (weak.length) lines.push('⚠️ 租金佔上月生意 80% 以上：' + weak.map(x => x.code + ' ' + x.name + '（' + Math.round(x.rent / x.v * 100) + '%）').join('、'));
  }
  return lines.join('\n');
}

/* =====================================================================
 * 現金流：支出、每日結算（現金 / 電子支付 / 點數）、單據
 * ===================================================================== */

const EXPENSE_CATS = [
  [/台主|分成|對數/, '台主'], [/電費|電|中電|港燈/, '電費'], [/業主|舖租|鋪租|租金/, '舖租'],
  [/買貨|入貨|貨|公仔|禮品/, '買貨'], [/人工|薪金|出糧|糧|兼職/, '人工'],
];

function cmdExpense(who, text, receipt, today) {
  needStaff(who);
  const t = normText(text);
  const toOwner = /^(俾台主|付台主)/.test(t);
  const code = parseMachine(t);
  const amount = parseAmount(t);
  if (!amount) return '格式：支出 銅鑼灣 電費 3200 轉帳　或者　俾台主 CWB-01 2000 現金';
  const m = code ? machineRow(table(S.M), code) : null;
  if (code && !m) return '搵唔到機號 ' + code;
  const shop = (m && m['舖']) || parseShop(t) || (who.shop !== '全部' ? who.shop : '');
  if (!shop) return '請講埋邊間舖，例如：支出 旺角 電費 3200 轉帳';
  const rest = t.replace(/^(支出|俾台主|付台主)\s*/, '');
  const cat = toOwner ? '台主' : ((EXPENSE_CATS.find(c => c[0].test(rest)) || [null, '雜項'])[1]);
  if (cat === '台主' && !m) return '俾台主要寫機號，例如：俾台主 CWB-01 2000 現金';
  const pm = parseMethod(rest);
  const method = !pm || pm === '現金' ? '現金' : '轉帳';
  const note = rest.replace(/(CWB|SSP|MK)\s*[-_ ]?\s*\d{1,3}/ig, '').replace(/\$?\s*[\d,]+(\.\d+)?/, '').replace(/(銅鑼灣|深水埗|旺角|現金|FPS|轉帳|轉賬|支票)/ig, '').trim();
  const row = addExpense_({ date: today, shop, category: cat === '台主' ? '俾台主' : cat, code: code || '', amount, method,
    by: who.name, tenant: m ? m['租客'] : '', receipt, note: note || cat });
  return '✅ 已記支出：' + shop + ' ' + (cat === '台主' ? '俾台主 ' + code + ' ' + (m['租客'] || '') : cat) + ' ' + money(amount) + '（' + method + '）' +
    (note && note !== cat ? '\n備註：' + note : '') + photoHint_(receipt, code || cat);
}

/** 補單據相：搵最近一筆未有相嘅紀錄（同一機號或者支出類別）。 */
function cmdReceipt(who, text, receipt, today) {
  needStaff(who);
  if (!receipt) return '請 send 張相，喺相片註解寫「單據 CWB-01」或者「單據 電費」。';
  const t = normText(text).replace(/^單據\s*/, '');
  const code = parseMachine(t);
  const key = code || t.split(/\s+/)[0];
  const cf = table(S.CF);
  const row = cf.rows.slice().reverse().find(r => !r['單據'] && r['經手'] === who.name && (code ? r['機號'] === code : String(r['類別']).indexOf(key) >= 0 || String(r['備註']).indexOf(key) >= 0));
  if (!row) return '搵唔到你未有單據嘅「' + key + '」紀錄。';
  cf.set(row, '單據', receipt);
  if (row['收租紀錄ID']) {
    const rt = table(S.R); const rec = rt.rows.find(r => r['紀錄ID'] === row['收租紀錄ID']);
    if (rec && !rec['收據']) rt.set(rec, '收據', receipt);
    const ct = table(S.COIN); const c = ct.rows.find(r => r['對幣ID'] === row['收租紀錄ID']);
    if (c && !c['單據']) ct.set(c, '單據', receipt);
  }
  return '✅ 已加單據：' + cellKey(row['日期']) + ' ' + row['類別'] + ' ' + (row['機號'] || '') + ' ' + money(row['金額']);
}

function staffShop_(name) {
  const s = table(S.STAFF).rows.find(r => String(r['姓名']) === String(name));
  return s ? String(s['舖'] || '') : '';
}

/** 某舖某日嘅現金變動（收租、按金、對幣俾台主、支出、入銀行）。 */
function cashMoves_(shop, date) {
  const cf = sheetRows_(S.CF).filter(r => r['舖'] === shop && cellKey(r['日期']) === date && r['現金/銀行'] === '現金');
  const cin = cf.filter(r => r['收支'] !== '支').reduce((s, r) => s + Number(r['金額'] || 0), 0);
  const cout = cf.filter(r => r['收支'] === '支').reduce((s, r) => s + Number(r['金額'] || 0), 0);
  const bank = sheetRows_(S.DEP).filter(d => cellKey(d['日期']) === date && staffShop_(d['入數同事']) === shop).reduce((s, d) => s + Number(d['金額'] || 0), 0);
  return { cin, cout, bank };
}

function cmdDayClose(who, text, receipt, today) {
  needStaff(who);
  const t = normText(text);
  const shop = parseShop(t) || (who.shop !== '全部' ? who.shop : '');
  if (!shop) return '請講埋邊間舖：日結 旺角 現金 15200 電子 8300 點數 9650';
  const num = re => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
  const wd = num(/(?:提款|補現金|攞錢)\s*\$?\s*([\d,]+)/) || 0;
  const cash = num(/現金(?:收入)?\s*\$?\s*([\d,]+)/), epay = num(/電子(?:支付)?\s*\$?\s*([\d,]+)/), count = num(/(?:點數|點錢|數錢|實數|櫃位)\s*\$?\s*([\d,]+)/);
  if (cash === null || count === null) return '格式：日結 ' + shop + ' 現金 15200 電子 8300 點數 9650\n（現金 = 今日賣幣收現金；電子 = 今日電子支付；點數 = 收工點到嘅現金）';
  const date = parseDate(t, today) || today;
  const set = settings();
  const ds = table(S.DAY);
  const x = dayCloseExpect_(shop, date, cash + wd);
  const prev = x.prev, opening = x.opening, mv = x.mv, expected = x.expected;
  const diff = count - expected;
  const plat = sheetRows_(S.EPAY).filter(r => r['舖'] === shop && cellKey(r['日期']) === date);
  const platSum = plat.length ? plat.reduce((s, r) => s + Number(r['金額'] || 0), 0) : '';
  const ediff = platSum === '' || epay === null ? '' : epay - platSum;
  const probs = [];
  if (Math.abs(diff) > set.cashTolerance) probs.push(diff < 0 ? '少咗現金 ' + money(-diff) : '多咗現金 ' + money(diff));
  if (ediff !== '' && Math.abs(ediff) > set.cashTolerance) probs.push('電子支付同平台差 ' + money(ediff));
  if (!prev) probs.push('冇上日點數，當 $0 開始');
  const status = probs.filter(p => p.indexOf('冇上日') < 0).length ? '⚠️ ' + probs.join('；') : '✅ 正常';
  const row = { '日期': keyToDate(date), '舖': shop, '現金收入': cash, '電子支付': epay === null ? '' : epay, '總生意額': cash + (epay || 0),
    '電子支付(平台)': platSum, '電子差額': ediff, '現金收租及其他': mv.cin, '現金支出': mv.cout, '現金入銀行': mv.bank,
    '上日現金': opening, '應有現金': expected, '點數': count, '差額': diff, '狀態': status, '經手': who.name, '單據': receipt || '', '備註': (wd ? '提款 ' + wd + '；' : '') + (prev ? '' : '第一次日結') };
  const old = ds.rows.find(r => r['舖'] === shop && cellKey(r['日期']) === date);
  if (old) ds.setMany(old, row); else ds.append(row);
  const out = ['🧾 ' + shop + ' ' + date + ' 日結' + (old ? '（已覆蓋舊數）' : ''),
    '生意額 ' + money(cash + (epay || 0)) + '（現金 ' + money(cash) + '，電子 ' + (epay === null ? '未報' : money(epay)) + '）',
    '上日現金 ' + money(opening) + ' + 賣幣現金 ' + money(cash) + ' + 收租/按金現金 ' + money(mv.cin) + (wd ? ' + 提款 ' + money(wd) : ''),
    '− 對幣及支出 ' + money(mv.cout) + ' − 入銀行 ' + money(mv.bank) + ' = 應有 ' + money(expected),
    '點數 ' + money(count) + '　差額 ' + (diff >= 0 ? '+' : '') + money(diff)];
  if (platSum !== '') out.push('電子支付平台 ' + money(platSum) + (ediff !== '' ? '，差 ' + money(ediff) : ''));
  out.push(status);
  if (status.indexOf('⚠️') === 0) notifyOwner('⚠️ ' + shop + ' ' + date + ' 日結有問題：' + probs.join('；') + '（' + who.name + '）', set);
  return out.join('\n');
}

/** 日結應有現金 = 上日點數 + 賣幣現金 + 收租按金現金 − 對幣及支出現金 − 入銀行。 */
function dayCloseExpect_(shop, date, cashIn) {
  const prev = sheetRows_(S.DAY).filter(r => r['舖'] === shop && cellKey(r['日期']) && cellKey(r['日期']) < date)
    .sort((a, b) => cellKey(a['日期']).localeCompare(cellKey(b['日期']))).pop();
  const opening = prev ? Number(prev['點數'] || 0) : 0;
  const mv = cashMoves_(shop, date);
  return { prev, opening, mv, expected: opening + (cashIn || 0) + mv.cin - mv.cout - mv.bank };
}

/** 過去 7 日嘅問題報表（每星期一自動發，老闆打「週報」即時睇）。 */
function weeklyReport_(today) {
  const from = dayKey(new Date(keyToDate(today).getTime() - 7 * 864e5));
  const inRange = r => { const k = cellKey(r['日期']); return k && k >= from && k < today; };
  const mt = table(S.M), rt = table(S.R), tt = table(S.T);
  const cf = sheetRows_(S.CF).filter(inRange), ds = sheetRows_(S.DAY).filter(inRange), coins = sheetRows_(S.COIN).filter(inRange);
  const lines = ['📊 每週報表 ' + from + ' 至 ' + dayKey(new Date(keyToDate(today).getTime() - 864e5))];
  const flags = [];
  ['銅鑼灣', '深水埗', '旺角'].forEach(shop => {
    const d = ds.filter(r => r['舖'] === shop);
    const sales = d.reduce((s, r) => s + Number(r['總生意額'] || 0), 0);
    const cashS = d.reduce((s, r) => s + Number(r['現金收入'] || 0), 0);
    const short = d.filter(r => Number(r['差額']) < -settings().cashTolerance);
    const rent = rt.rows.filter(r => r['舖'] === shop && cellKey(r['實收日']) >= from && cellKey(r['實收日']) < today).reduce((s, r) => s + Number(r['實收金額'] || 0), 0);
    const exp = {};
    cf.filter(r => r['舖'] === shop && r['收支'] === '支').forEach(r => { exp[r['類別']] = (exp[r['類別']] || 0) + Number(r['金額'] || 0); });
    const expTotal = Object.keys(exp).reduce((s, k) => s + exp[k], 0);
    const coinT = coins.filter(c => c['舖'] === shop).reduce((s, c) => s + Number(c['金額'] || 0), 0);
    lines.push('');
    lines.push('🏪 ' + shop);
    lines.push('生意額 ' + money(sales) + '（現金 ' + money(cashS) + '，電子 ' + money(sales - cashS) + '，' + d.length + '/7 日有日結）');
    lines.push('收租 ' + money(rent) + '　對幣（租客生意）' + money(coinT));
    lines.push('支出 ' + money(expTotal) + (expTotal ? '：' + Object.keys(exp).map(k => k + ' ' + money(exp[k])).join('、') : ''));
    lines.push('淨現金流（生意 + 收租 − 支出）' + money(sales + rent - expTotal));
    if (d.length < 7) flags.push(shop + ' 有 ' + (7 - d.length) + ' 日冇日結');
    short.forEach(r => flags.push(shop + ' ' + cellKey(r['日期']) + ' 現金少咗 ' + money(-Number(r['差額']))));
    d.filter(r => r['電子差額'] !== '' && Math.abs(Number(r['電子差額'])) > settings().cashTolerance).forEach(r => flags.push(shop + ' ' + cellKey(r['日期']) + ' 電子支付同平台差 ' + money(r['電子差額'])));
  });
  tt.rows.filter(t => String(t['對幣狀態']).indexOf('停止') === 0).forEach(t => flags.push('⛔ ' + t['租客'] + ' 欠租未清（逾期 ' + money(t['逾期結欠']) + '），停止對幣'));
  const noPhoto = cf.filter(r => !r['單據'] && r['現金/銀行'] !== '對幣抵銷' && (r['收支'] === '支' || r['現金/銀行'] === '現金')).length;
  if (noPhoto) flags.push('📷 ' + noPhoto + ' 筆現金收付冇單據相');
  const recon = sheetRows_(S.BANK).filter(b => ['建議配對', '對唔到'].indexOf(String(b['對數狀態'])) >= 0).length;
  if (recon) flags.push('🔎 銀行對數仲有 ' + recon + ' 筆未處理');
  const weak = tt.rows.filter(t => Number(t['租金佔生意額']) >= 0.8).map(t => t['租客']);
  if (weak.length) flags.push('🪙 租金佔生意 80% 以上：' + weak.join('、'));
  lines.push('');
  lines.push(flags.length ? '⚠️ 要留意：\n・' + flags.join('\n・') : '✅ 呢個星期冇特別問題');
  return lines;
}

/** WhatsApp 單據相存去 Google Drive（有 RECEIPT_FOLDER_ID 先做）。返回 Drive 連結，失敗就返回原本 media id。 */
function saveReceipt_(receipt, from) {
  const p = props_();
  const folderId = p.getProperty('RECEIPT_FOLDER_ID');
  if (!receipt || !folderId || p.getProperty('DRY_RUN') === '1') return receipt;
  try {
    const id = receipt.split(':')[1];
    const auth = { Authorization: 'Bearer ' + p.getProperty('WA_TOKEN') };
    const meta = JSON.parse(UrlFetchApp.fetch('https://graph.facebook.com/v21.0/' + id, { headers: auth }).getContentText());
    const blob = UrlFetchApp.fetch(meta.url, { headers: auth }).getBlob().setName(todayKey() + '_' + from + '_' + id);
    return DriveApp.getFolderById(folderId).createFile(blob).getUrl();
  } catch (e) { return receipt; }
}

/* =====================================================================
 * 對數：銀行月結單 vs 收租紀錄 / 入數紀錄
 * ===================================================================== */

function tokens_(s) {
  return String(s || '').toUpperCase().split(/[\/,;、]+/).map(x => x.trim()).filter(x => x.length >= 3);
}

function bankTenant_(tt, desc) {
  const d = String(desc || '').toUpperCase().replace(/\s+/g, ' ');
  return tt.rows.find(t => tokens_(t['入數名']).some(k => d.indexOf(k) >= 0) ||
    tokens_(t['FPS識別']).some(k => d.indexOf(k) >= 0) ||
    (String(t['戶口尾數']).length === 4 && d.indexOf('X' + t['戶口尾數']) >= 0)) || null;
}

/** 由舊到新揀未清期數，揀到加埋啱啱等於 amount 就返回。 */
function unpaidFit_(rt, name, amount, today) {
  const period = periodOf(today);
  const open = rt.rows.filter(r => String(r['租客']) === name && ['未到期', '欠租', '部份交'].indexOf(String(r['狀態'])) >= 0 &&
    outstanding(r) > 0 && String(r['期數']) <= nextPeriod(period))
    .sort((a, b) => cellKey(a['應收日']).localeCompare(cellKey(b['應收日'])));
  const single = open.filter(r => outstanding(r) === amount);
  if (single.length) return [single[0]];
  let sum = 0;
  const pick = [];
  for (const r of open) { sum += outstanding(r); pick.push(r); if (sum === amount) return pick; if (sum > amount) break; }
  return null;
}

/** 對一次數。返回各狀態筆數。 */
function reconcile_(today) {
  ensureSchema();
  const bt = table(S.BANK), rt = table(S.R), tt = table(S.T), dep = table(S.DEP);
  const lines = bt.rows.filter(b => Number(b['存入']) > 0 && String(b['對數狀態']) !== '已對到' && String(b['對數狀態']) !== '已確認');
  const used = {};
  rt.rows.forEach(r => { if (r['對數狀態'] === '已對到') used[r['紀錄ID']] = true; });
  const bankPaid = r => ['FPS', '轉帳', '支票'].indexOf(String(r['付款方式'])) >= 0 && Number(r['實收金額']) > 0 &&
    ['已交', '部份交'].indexOf(String(r['狀態'])) >= 0;
  const near = (a, b, n) => a && b && Math.abs(daysBetween(a, b)) <= n;
  const mark = (b, status, recs, tenant, note) => {
    bt.setMany(b, { '對數狀態': status, '對應紀錄': (recs || []).map(r => r['紀錄ID'] || r['入數ID']).join(','), '對應租客': tenant || '', '備註': note || '' });
    if (status === '已對到') (recs || []).forEach(r => {
      if (r['紀錄ID']) { rt.setMany(r, { '對數狀態': '已對到', '銀行ID': b['銀行ID'] }); used[r['紀錄ID']] = true; }
    });
  };
  lines.forEach(b => {
    const amt = Number(b['存入']), day = cellKey(b['日期']), desc = String(b['描述'] || '').toUpperCase();
    if (/CASH|現金|CDM/.test(desc)) {
      const d = dep.rows.find(x => Number(x['金額']) === amt && near(cellKey(x['日期']), day, 2) && !x['_matched']);
      if (d) { d['_matched'] = true; return mark(b, '已對到', [d], '', '現金入數 ' + d['入數ID']); }
      return mark(b, '對唔到', [], '', '現金存入，搵唔到同金額嘅入數紀錄');
    }
    const t = bankTenant_(tt, desc);
    if (t) {
      const name = String(t['租客']);
      const paid = rt.rows.filter(r => String(r['租客']) === name && bankPaid(r) && !used[r['紀錄ID']] && near(cellKey(r['實收日']), day, 7));
      const one = paid.find(r => Number(r['實收金額']) === amt);
      if (one) return mark(b, '已對到', [one], name, '入數名配對');
      const sameDay = {};
      paid.forEach(r => { (sameDay[cellKey(r['實收日'])] = sameDay[cellKey(r['實收日'])] || []).push(r); });
      const grp = Object.keys(sameDay).map(k => sameDay[k]).find(g => g.reduce((s, r) => s + Number(r['實收金額']), 0) === amt);
      if (grp) return mark(b, '已對到', grp, name, '一筆過交 ' + grp.length + ' 部機');
      const fit = unpaidFit_(rt, name, amt, today);
      if (fit) return mark(b, '建議配對', fit, name, '銀行有入，但未有人記收租。確認請打：對數確認 ' + b['銀行ID']);
      return mark(b, '對唔到', [], name, '入數名係 ' + name + '，但金額 ' + money(amt) + ' 對唔上任何紀錄');
    }
    let cands = rt.rows.filter(r => bankPaid(r) && !used[r['紀錄ID']] && Number(r['實收金額']) === amt && near(cellKey(r['實收日']), day, 3));
    const exact = cands.filter(r => cellKey(r['實收日']) === day);
    if (cands.length > 1 && exact.length === 1) cands = exact;
    if (cands.length === 1) return mark(b, '已對到', cands, String(cands[0]['租客']), '金額同日子配對，建議補入數名');
    if (cands.length > 1) return mark(b, '建議配對', [cands[0]], String(cands[0]['租客']), '有 ' + cands.length + ' 筆可能，請核對');
    return mark(b, '對唔到', [], '', '搵唔到租客或者紀錄');
  });
  // 紀錄話過咗數，但月結單期內冇見到
  const days = bt.rows.filter(b => Number(b['存入']) > 0).map(b => cellKey(b['日期'])).filter(String).sort();
  let missing = 0;
  if (days.length) {
    const from = days[0], to = days[days.length - 1];
    rt.rows.forEach(r => {
      const k = cellKey(r['實收日']);
      if (!bankPaid(r) || used[r['紀錄ID']] || r['對數狀態'] === '已確認' || !k || k < from || daysBetween(k, to) < 3) return;
      if (r['對數狀態'] !== '未見入帳') rt.set(r, '對數狀態', '未見入帳');
      missing++;
    });
  }
  refreshCrm_(tt, rt, today);
  const count = s => bt.rows.filter(b => Number(b['存入']) > 0 && String(b['對數狀態']) === s).length;
  return { matched: count('已對到') + count('已確認'), suggest: count('建議配對'), unknown: count('對唔到'), missing };
}

function reconSummary_(r) {
  return ['🔎 對數結果', '✅ 已對到 ' + r.matched + ' 筆', '🟡 建議配對 ' + r.suggest + ' 筆（要同事確認）',
    '❓ 銀行有、紀錄冇 ' + r.unknown + ' 筆', '⚠️ 紀錄有、銀行冇 ' + r.missing + ' 筆'].join('\n');
}

function cmdRecon(who, text, today) {
  needStaff(who);
  const r = reconcile_(today);
  const bt = table(S.BANK);
  const todo = bt.rows.filter(b => b['對數狀態'] === '建議配對').slice(0, 5)
    .map(b => b['銀行ID'] + ' ' + cellKey(b['日期']).slice(5) + ' ' + money(b['存入']) + ' ' + (b['對應租客'] || '') + ' → 對數確認 ' + b['銀行ID']);
  return reconSummary_(r) + (todo.length ? '\n\n要確認：\n' + todo.join('\n') : '');
}

/** 同事確認「建議配對」：當銀行嗰日收到租。 */
function confirmBankMatch_(bankId, by, today) {
  const bt = table(S.BANK), rt = table(S.R), mt = table(S.M);
  const b = bt.rows.find(x => String(x['銀行ID']).toUpperCase() === String(bankId).toUpperCase());
  if (!b) return '搵唔到 ' + bankId;
  if (b['對數狀態'] !== '建議配對') return bankId + ' 唔係建議配對（而家：' + (b['對數狀態'] || '未對') + '）';
  const ids = String(b['對應紀錄']).split(',').filter(String);
  const day = cellKey(b['日期']);
  const notes = [];
  ids.forEach(id => {
    const r = rt.rows.find(x => x['紀錄ID'] === id);
    if (!r) return;
    const owe = outstanding(r);
    if (owe > 0) {
      applyPayment(rt, r, owe, 'FPS', by, day, '', '銀行月結單');
      notes.push(r['機號'] + ' ' + r['期數'] + ' ' + money(owe));
    }
    rt.setMany(r, { '對數狀態': '已對到', '銀行ID': b['銀行ID'] });
    const m = machineRow(mt, String(r['機號']));
    if (m) refreshMachine(m, mt, rt, today, settings());
  });
  bt.setMany(b, { '對數狀態': '已確認', '備註': '由 ' + by + ' 確認' + (notes.length ? '，記做已收' : '') });
  refreshCrm_(table(S.T), rt, today);
  return '✅ ' + bankId + ' 已確認：' + (b['對應租客'] || '') + ' ' +
    (notes.length ? notes.join('、') + ' 記做已收（' + day + '）' : '對到紀錄 ' + ids.join('、'));
}

function cmdReconConfirm(who, text, today) {
  needStaff(who);
  const id = (normText(text).match(/B\d+/i) || [])[0];
  if (!id) return '格式：對數確認 B00003';
  return confirmBankMatch_(id, who.name, today);
}

/* =====================================================================
 * AI 對話（Claude）
 * ===================================================================== */

function aiEnabled_() {
  if (typeof AI_HOOK_ !== 'undefined' && AI_HOOK_) return true;
  const set = {};
  sheetRows_(S.SET).forEach(r => { set[String(r['設定']).trim()] = String(r['值']); });
  return !!props_().getProperty('CLAUDE_KEY') && set['AI 對話'] !== '否';
}

const AI_RULES = [
  '你係「夾公仔舖收租助手」，喺 WhatsApp 用香港廣東話書面語回覆（例如：係、唔係、嘅、咗、而家）。',
  '三間舖：銅鑼灣波斯富街（CWB）、深水埗玩具街（SSP）、旺角西洋菜街（MK）。機號例如 CWB-01。',
  '規則：',
  '1. 任何金額、日期、期數，一定要用工具查，唔可以估或者自己計。',
  '2. 你唔可以確認收到租、唔可以減租、免租、延期、批准入機、踢走或者退按金。遇到呢啲要求，用 handoff_to_staff 轉交同事，並話畀對方知同事會跟進。',
  '3. 租客話已經交咗或者過咗數，而佢講得出金額同機號（或者只有一部機），用 report_payment 記做待確認；講唔清就問清楚。請佢附截圖。',
  '4. 租客承諾某日交租，用 record_promise 記低。',
  '5. 只講對方自己嘅資料，唔好透露其他租客。',
  '6. 回覆要短（3 至 6 行），唔使客套長篇；數字用 $5,500 格式。唔好用 Markdown 標題或者粗體。',
  '7. 投訴、機器壞、問題你答唔到，用 handoff_to_staff。',
  '8. 租客問自己部機生意（對幣金額），用 get_my_turnover。',
].join('\n');

const AI_RULES_STAFF = [
  '你係「夾公仔舖收租助手」，同舖頭同事或老闆用廣東話對話，幫佢哋查同記錄。',
  '1. 數字一定用工具查。',
  '2. 同事要記收租、按金、入數、確認，可以用 run_command 行標準指令（例如「收 CWB-01 5500 FPS」），行之前要肯定機號同金額。',
  '3. 踢走、退按、按金抵租唔可以代行，請同事自己打指令。',
  '4. 同事話幫某部機對咗幣（例如「CWB-01 對咗 3200」），用 run_command 行「對幣 CWB-01 3200」；講幣數就寫「對幣 CWB-01 640個」。',
  '5. 問生意額用 run_command 行「生意」「生意 旺角」「生意 白豬」或者「生意 CWB-01」。',
  '6. 租客欠租未清就唔可以普通對幣；同事要對幣就行「對幣抵租 機號 金額」，先扣欠租。',
  '7. 記支出用「支出 舖 類別 金額 方式」（類別：電費、舖租、買貨、人工、雜項），俾台主用「俾台主 機號 金額 方式」；每日埋數用「日結 舖 現金 X 電子 Y 點數 Z」。',
  '8. 回覆要短，用條列，唔好用 Markdown 標題。',
].join('\n');

/** 每個工具：name、description、input_schema、run(input) → 字串。 */
function aiToolsFor_(r) {
  const who = r.who, today = r.today;
  const tools = [];
  const add = (name, description, props, required, run) => tools.push({
    name, description, input_schema: { type: 'object', properties: props || {}, required: required || [] }, run,
  });
  if (who.kind === 'tenant') {
    add('get_my_account', '查呢位租客嘅租金戶口：名下所有機、未交期數、結欠、逾期、下次到期日、最近付款、按金。回覆有關錢嘅問題前一定要用。', {}, [],
      () => cmdStatement(who, '結單', today));
    add('report_payment', '租客話已經交租或者過咗數：記做「待確認」並通知同事核對。machine 係機號（例如 CWB-01），amount 係金額（數字），method 係 FPS／轉帳／現金／支票。', {
      machine: { type: 'string' }, amount: { type: 'number' }, method: { type: 'string' },
    }, ['machine', 'amount'], i => cmdTenantPay(who, '交租 ' + i.machine + ' ' + i.amount + ' ' + (i.method || 'FPS'), r.receipt, today));
    add('record_promise', '租客承諾某日交租：記入跟進紀錄並設定下次跟進日。date 用 YYYY-MM-DD。', {
      date: { type: 'string' }, amount: { type: 'number' }, note: { type: 'string' },
    }, ['date'], i => {
      const t = tenantRecord_(who);
      const name = t ? String(t['租客']) : who.name;
      const d = parseDate(String(i.date), today) || String(i.date);
      addFollowUp_(name, 'AI', '承諾 ' + d + ' 交' + (i.amount ? ' ' + money(i.amount) : '') + (i.note ? '（' + i.note + '）' : ''), 'AI 助手', '到期再追', d);
      return '已記錄：' + name + ' 承諾 ' + d + ' 交租';
    });
    add('update_contact_preference', '租客想改聯絡方法：preference 係 WhatsApp／電話／到舖；backup_phone 係後備電話（可選）。', {
      preference: { type: 'string' }, backup_phone: { type: 'string' },
    }, ['preference'], i => {
      const tt = table(S.T);
      const t = tt.rows.find(x => normPhone(x['電話']) === who.phone);
      if (!t) return '搵唔到租客資料';
      tt.set(t, '聯絡偏好', String(i.preference));
      if (i.backup_phone) tt.set(t, '後備電話', normPhone(i.backup_phone));
      addFollowUp_(String(t['租客']), 'AI', '改聯絡偏好為 ' + i.preference, 'AI 助手');
      return '已更新聯絡偏好：' + i.preference;
    });
    add('handoff_to_staff', '轉交真人同事：減租、延期、投訴、機器問題、或者你處理唔到。reason 用一句講清楚。', {
      reason: { type: 'string' },
    }, ['reason'], i => {
      const t = tenantRecord_(who);
      const name = t ? String(t['租客']) : (who.name || who.phone);
      addFollowUp_(name, 'AI 轉交', String(i.reason), 'AI 助手', '同事回覆');
      const shops = t ? shopsOfTenant_(name) : [];
      notifyStaff(shops[0] || '全部', '🙋 AI 轉交：' + name + '（' + who.phone + '）\n' + i.reason + '\n原文：' + r.rawText);
      return '已轉交同事';
    });
    add('get_my_turnover', '查呢位租客嘅生意額（舖頭幫佢部機對 $5 幣嘅金額）：今個月、之前幾個月、平均、租金佔幾多。', {}, [],
      () => cmdTurnover(who, '生意', today));
  } else {
    add('tenant_summary', '查一位租客嘅 CRM 摘要（聯絡、入數資料、機、準時率、結欠、生意額、對數、最近跟進）。name 可以係租客名或者機號。', {
      name: { type: 'string' },
    }, ['name'], i => cmdCrm(who, '客戶 ' + i.name, today));
    add('list_tenants', '列出租客：filter 係 overdue（有逾期）、recon（對數待處理）、followup（今日或之前要跟進）、high_risk（紅燈）、rent_heavy（各舖生意額同租金佔生意額偏高嘅機）。', {
      filter: { type: 'string' },
    }, ['filter'], i => {
      if (String(i.filter) === 'rent_heavy') return cmdTurnover(who, '生意', today);
      const tt = table(S.T);
      const f = String(i.filter);
      const rows = tt.rows.filter(t => t['租客'] && (
        f === 'overdue' ? Number(t['逾期結欠']) > 0 : f === 'recon' ? Number(t['對數待處理']) > 0 :
        f === 'followup' ? (cellKey(t['下次跟進']) && cellKey(t['下次跟進']) <= today) : t['風險'] === '紅'));
      return rows.length ? rows.map(t => t['租客'] + '　結欠 ' + money(t['結欠']) + '　逾期 ' + money(t['逾期結欠']) + '　風險 ' + t['風險'] +
        (t['對數待處理'] ? '　對數 ' + t['對數待處理'] : '') + (t['下次跟進'] ? '　跟進 ' + cellKey(t['下次跟進']) : '')).join('\n') : '冇';
    });
    add('run_command', '行一個標準指令，例如「收 CWB-01 5500 FPS」「按金 CWB-01 5500 現金」「入數 匯豐 9200」「確認 R01234」「欠租 旺角」「空置」「對數」「對數確認 B00003」「跟進 白豬 內容 2026-11-21」「對幣 CWB-01 3200」「對幣抵租 CWB-01 3200」「生意 旺角」「支出 旺角 電費 3200 轉帳」「俾台主 CWB-01 2000 現金」「日結 旺角 現金 15200 電子 8300 點數 9650」「單據 CWB-01」「結單 CWB-01」「查 CWB-01」。返回系統回覆。', {
      command: { type: 'string' },
    }, ['command'], i => {
      const c = normText(i.command);
      if (/^(踢走|退按|按金抵租)/.test(c)) return '呢個指令要同事自己打。';
      const sub = routeMessage_(who.phone, c, r.receipt);
      return sub.ai ? '唔係標準指令：' + c : sub.reply;
    });
  }
  return tools;
}

function aiContext_(r) {
  const who = r.who;
  if (who.kind === 'tenant') {
    const t = tenantRecord_(who);
    return '今日係 ' + r.today + '。你而家同租客「' + (t ? t['租客'] : who.name) + '」對話（電話 ' + who.phone + '）。' +
      (t ? '佢名下機：' + machinesOf_(table(S.M), t['租客']).map(m => m['機號']).join('、') + '。常用付款方式：' + (t['付款方式'] || '未知') + '。' : '') +
      (r.receipt ? '佢呢條訊息附咗相片（' + r.receipt + '），可能係轉數截圖。' : '');
  }
  return '今日係 ' + r.today + '。你而家同' + (who.kind === 'owner' ? '老闆' : who.shop + '同事') + '「' + who.name + '」對話。';
}

/** 最近幾條對話，俾 AI 知上文。 */
function aiHistory_(phone, n) {
  const rows = sheetRows_(S.LOG).filter(l => String(l['電話']) === String(phone) && l['方向'] === '收').slice(-(n || 4));
  const turns = [];
  rows.forEach(l => {
    turns.push({ role: 'user', content: String(l['內容'] || '').slice(0, 500) || '（相片）' });
    turns.push({ role: 'assistant', content: String(l['結果'] || '').slice(0, 800) || '（冇回覆）' });
  });
  return turns;
}

/** 正式版：經 Anthropic Messages API 行工具循環。 */
function aiReply_(r) {
  const p = props_();
  const tools = aiToolsFor_(r);
  const byName = {};
  tools.forEach(t => { byName[t.name] = t; });
  const sys = [{ type: 'text', text: r.who.kind === 'tenant' ? AI_RULES : AI_RULES_STAFF, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: aiContext_(r) }];
  const messages = aiHistory_(r.who.phone, 3).concat([{ role: 'user', content: r.rawText || '（相片）' }]);
  for (let round = 0; round < 5; round++) {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': p.getProperty('CLAUDE_KEY'), 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      payload: JSON.stringify({
        model: p.getProperty('CLAUDE_MODEL') || 'claude-opus-5-5', max_tokens: 4000, output_config: { effort: 'low' },
        fallbacks: 'default', system: sys, messages,
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      }),
    });
    if (res.getResponseCode() !== 200) throw new Error('Claude API ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    const msg = JSON.parse(res.getContentText());
    if (msg.stop_reason === 'refusal') return r.fallback;
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const uses = (msg.content || []).filter(b => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !uses.length) return text || r.fallback;
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({ role: 'user', content: uses.map(u => {
      let out, err = false;
      try { out = String(byName[u.name] ? byName[u.name].run(u.input || {}) : '冇呢個工具'); } catch (e) { out = '出錯：' + e.message; err = true; }
      return { type: 'tool_result', tool_use_id: u.id, content: out.slice(0, 4000), is_error: err };
    }) });
  }
  return r.fallback;
}
