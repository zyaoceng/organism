import { getLang } from '../lib/i18n';

/**
 * Chinese versions of messages that are built at runtime in English by the domain engine,
 * the formula parser and the server. Each regex must match the whole message.
 * In the replacement, $1 inserts a captured group as is, %1 inserts it translated again
 * (for messages that wrap another message).
 */
const P: [RegExp, string][] = [
  // Model checks and calculation errors (src/domain/calc, src/domain/formula)
  [/^(.+?): (typed value .+)$/, '$1：%2'],
  [/^typed value (.+) differs from the formula result (.+) by (.+)%$/, '手動輸入 $1 和公式結果 $2 相差 $3%'],
  [/^Typed value overrides the formula in (.+)$/, '$1 的手動輸入值覆蓋了公式'],
  [/^(Bear|Bull) override on an actual cell \((.+)\) is ignored$/, '%1 情境在實際值（$2）上的覆寫不會生效'],
  [/^Role "(.+)" is also assigned to (.+)$/, '角色「$1」也指定給了 $2'],
  [/^Formula references (\d+) deleted node\(s\)$/, '公式參照了 $1 個已刪除的節點'],
  [/^Formula references period @(.+), which does not exist$/, '公式參照的期間 @$1 不存在'],
  [/^Circular dependency: (.+)$/, '循環參照：$1'],
  [/^Formula produces (.+) but the node is declared as (.+)$/, '公式算出的單位是 $1，但節點設定的單位是 $2'],
  [/^Per-share division: amount is in (.+) but shares are in (.+); the result is off by a factor of (.+)$/, '每股計算：金額單位是 $1，股數單位是 $2，結果會差 $3 倍'],
  [/^(Addition|Subtraction|IF branches|SUM|MIN|MAX|AVERAGE): (.+)$/, '%1：%2'],
  [/^Addition$/, '加法'],
  [/^Subtraction$/, '減法'],
  [/^IF branches$/, 'IF 的兩個結果'],
  [/^(.+) combined with (.+) \(different currencies\)$/, '$1 和 $2 放在一起計算（幣別不同）'],
  [/^(.+) combined with (.+) \(different scales\)$/, '$1 和 $2 放在一起計算（數量級不同）'],
  [/^(.+) combined with (.+)$/, '$1 和 $2 放在一起計算（單位種類不同）'],
  [/^Missing input: (.+), (.+)$/, '缺少輸入值：$1，$2'],
  [/^Missing starting value for (.+): PREV\(\) reaches before the first period(?: \((.+)\))?\. Type (.+) in an actual period\.$/, '缺少 $1 的起始值：PREV() 需要第一個期間之前的數字。請在實際期間輸入 $3。'],
  [/^Division by zero: (.+) is 0$/, '除以零：$1 等於 0'],
  [/^(.+) has no values \(CHILDREN\(\) found no matching child nodes\)$/, '$1 沒有數值（CHILDREN() 找不到單位相同的子節點）'],
  [/^CAGR needs a positive begin value and a non-negative end value \(got (.+)\)$/, 'CAGR 的期初值要大於 0，期末值不能小於 0（目前是 $1）'],
  [/^CAGR needs years > 0 \(got (.+)\)$/, 'CAGR 的年數要大於 0（目前是 $1）'],
  [/^PREV\(x, n\): n must be a whole number ≥ 1$/, 'PREV(x, n)：n 必須是大於等於 1 的整數'],
  [/^PREV\(\) only works in time-series formulas$/, 'PREV() 只能用在時間序列的公式'],
  [/^CHILDREN\(\) can only be used inside SUM, MIN, MAX or AVERAGE$/, 'CHILDREN() 只能放在 SUM、MIN、MAX 或 AVERAGE 裡面'],
  [/^Unknown function (.+)$/, '沒有 $1 這個函數'],
  [/^Unresolved name "(.+)"$/, '找不到名稱「$1」'],
  [/^Unsupported expression$/, '不支援這種寫法'],
  [/^Invalid formula$/, '公式無效'],
  [/^(.+) is not a finite number$/, '$1 不是有效數字'],
  [/^\[(.+)\] is a time series; a single-value formula must pick a period, e.g\. (.+)$/, '[$1] 是時間序列，單一數值的公式要指定期間，例如 $2'],
  [/^No node named "(.+)"\.(.*)$/, '找不到名為「$1」的節點。%2'],
  [/^ ?Did you mean (.+)\?$/, '你是不是要找 $1？'],
  [/^"(.+)" matches (\d+) nodes: (.+)\. Use a path such as (.+)\.$/, '「$1」符合 $2 個節點：$3。請改用路徑寫法，例如 $4。'],
  [/^This reference points to a node that was deleted\. Replace it with an existing node\.$/, '這個參照指向已刪除的節點，請換成現有的節點。'],
  [/^This reference points to a node that was deleted\.$/, '這個參照指向已刪除的節點。'],
  [/^Formula references a node that was deleted$/, '公式參照了已刪除的節點'],
  [/^Unknown period @(.+)\. Periods in this model: (.+)\.$/, '沒有 @$1 這個期間。這個模型的期間有：$2。'],
  [/^Unexpected (.+) — is an operator missing\?$/, '這裡不該出現 %1，是不是少了運算符號？'],
  [/^Unexpected (.+)$/, '這裡不該出現 %1'],
  [/^end of formula$/, '公式結尾'],
  [/^number (.+)$/, '數字 $1'],
  [/^name "(.+)"$/, '名稱「$1」'],
  [/^reference$/, '參照'],
  [/^Unexpected character "(.+)"$/, '無法辨識的字元「$1」'],
  [/^Unexpected "!"\. Use NOT\(\.\.\.\) or <> for "not equal"$/, '不能用「!」。要表示「不等於」請用 NOT(...) 或 <>'],
  [/^Invalid number "(.+)"$/, '數字格式錯誤「$1」'],
  [/^(.+) takes (.+) argument\(s\): (.+)$/, '$1 需要 $2 個參數：$3'],
  [/^Missing "\)" to close (.+)\($/, '$1( 少了右括號「)」'],
  [/^Missing closing "\)"$/, '少了右括號「)」'],
  [/^Missing closing "\]" for a name in brackets$/, '中括號名稱少了右括號「]」'],
  [/^Missing closing "\}" in a stored reference$/, '參照少了右大括號「}」'],
  [/^Empty name in brackets "\[\]"$/, '中括號「[]」裡面沒有名稱'],
  [/^Expected a period after "@", e\.g\. @FY2028$/, '「@」後面要接期間，例如 @FY2028'],
  [/^The formula ends unexpectedly$/, '公式沒有寫完'],
  [/^The formula is empty$/, '公式是空的'],
  [/^"(.+)" is not a number$/, '「$1」不是數字'],
  [/^"(.+)" is not a finite number$/, '「$1」不是有效數字'],

  // Model operations (src/domain/model/ops.ts)
  [/^Node (.+) does not exist$/, '節點 $1 不存在'],
  [/^A node needs a name$/, '節點需要名稱'],
  [/^Value must be a finite number$/, '數值必須是有效數字'],
  [/^A node cannot be moved inside itself$/, '節點不能移到自己底下'],
  [/^Period IDs may only contain letters, digits and _ \(e\.g\. FY2029\)$/, '期間代號只能用英文字母、數字和底線（例如 FY2029）'],
  [/^Period (.+) already exists$/, '期間 $1 已經存在'],
  [/^Period (.+) does not exist$/, '期間 $1 不存在'],
  [/^Period (.+) is used by the formula of (.+)\. Change those formulas first\.$/, '期間 $1 被 $2 的公式使用中，請先修改這些公式。'],
  [
    /^Cannot convert (.+?) to a new scale: (.+), and formulas do not convert scales\. Change the scale of the whole chain together, or keep the scale and relabel only \(untick “convert values”\)\.$/,
    '無法把 $1 換成新的數量級：%2，而公式不會自動換算數量級。請把整串相關節點一起改，或保留數字只改標示（取消勾選「換算數值」）。',
  ],
  [/^(.+) is calculated by a formula$/, '$1 是由公式計算'],
  [/^formulas read it \((.+)\)$/, '有公式引用它（$1）'],

  // Server: commits and point-in-time checks
  [/^A Research Update needs a title$/, '研究更新需要標題'],
  [/^Explain the reason \/ interpretation: why did your view change \(or why is it unchanged\)\?$/, '請寫下理由：你的看法為什麼改變（或為什麼沒變）？'],
  [/^Knowledge date must be YYYY-MM-DD$/, '知情日期格式必須是 YYYY-MM-DD'],
  [/^Knowledge date (.+) is in the future$/, '知情日期 $1 在未來'],
  [
    /^Knowledge date (.+) is earlier than Research Update #(\d+) \((.+)\)\. Updates must be in chronological order so that point-in-time history has no look-ahead\.$/,
    '知情日期 $1 早於研究更新 #$2（$3）。研究更新必須按時間順序，歷史紀錄才不會用到當時還不知道的資訊。',
  ],
  [/^The draft changed since you reviewed it\. Review the changes again before committing\.$/, '你檢查之後草稿又改過了，請重新檢查變更再提交。'],
  [/^The draft was changed elsewhere \(another window\?\)\. Reload to continue\.$/, '草稿在別的地方被修改了（另一個視窗？），請重新載入。'],
  [/^The draft model is invalid$/, '草稿模型有錯誤'],
  [/^The model is invalid and was not saved$/, '模型有錯誤，沒有儲存'],
  [/^Evidence (.+) not found in this project$/, '這家公司找不到證據 $1'],
  [/^Evidence not found in this project: (.+)$/, '這家公司找不到這些證據：$1'],
  [/^“(.+)” was published (.+), after this update’s knowledge date (.+)\. Citing it would be look-ahead\.$/, '「$1」的發布日期是 $2，晚於這次更新的知情日期 $3。引用它等於用了當時還不知道的資訊。'],
  [/^Linked evidence was published after the knowledge date (.+?): (.+)\. Move the knowledge date or unlink it\.$/, '連結的證據發布日期晚於知情日期 $1：$2。請調整知情日期或取消連結。'],
  [/^Research Update not found in this project$/, '這家公司找不到這個研究更新'],
  [
    /^Research Update #(\d+) has knowledge date (.+), after the entry date (.+); a trade cannot rely on research made later\.$/,
    '研究更新 #$1 的知情日期是 $2，晚於進場日 $3。交易不能依據之後才做的研究。',
  ],
  [
    /^Research Update #(\d+) \(knowledge date (.+)\) already relies on this evidence; its publication date cannot be later than that\.$/,
    '研究更新 #$1（知情日期 $2）已經引用這份證據，發布日期不能晚於那一天。',
  ],
  [/^This evidence cannot be deleted\. (.+)$/, '這份證據不能刪除。%1'],
  [/^It is part of Research Update #(\d+)\. Archive it instead; history must stay reconstructable\.$/, '它屬於研究更新 #$1。請改用封存，歷史紀錄必須能完整重現。'],
  [/^It is linked to a node in the current draft\. Unlink it first\.$/, '它連結在目前草稿的節點上，請先取消連結。'],
  [/^It is attached to the catalyst “(.+)”\.$/, '它附在催化劑「$1」上。'],

  // Server: records and validation
  [/^Company name is required$/, '請填公司名稱'],
  [/^Ticker is required$/, '請填股票代號'],
  [/^Evidence needs a title$/, '證據需要標題'],
  [/^Evidence needs a title, a URL, a file or a note$/, '證據需要標題、網址、檔案或筆記其中一項'],
  [/^Note is empty$/, '筆記是空的'],
  [/^URL must start with http:\/\/ or https:\/\/$/, '網址必須以 http:// 或 https:// 開頭'],
  [/^Publication date must be YYYY-MM-DD$/, '發布日期格式必須是 YYYY-MM-DD'],
  [/^Unknown source type (.+)$/, '未知的來源類型 $1'],
  [/^No file uploaded$/, '沒有上傳檔案'],
  [/^Catalyst needs a title$/, '催化劑需要標題'],
  [/^Review needs a title$/, '檢討需要標題'],
  [/^Template needs a name$/, '範本需要名稱'],
  [/^Template is invalid$/, '範本有錯誤'],
  [/^Entry date must be YYYY-MM-DD$/, '進場日格式必須是 YYYY-MM-DD'],
  [/^Exit date must be YYYY-MM-DD$/, '出場日格式必須是 YYYY-MM-DD'],
  [/^Entry price must be positive$/, '進場價必須大於 0'],
  [/^Exit price must be positive$/, '出場價必須大於 0'],
  [/^Exit date is before the entry date$/, '出場日早於進場日'],
  [/^Exit needs both a date and a price$/, '出場需要同時填日期和價格'],
  [/^Position size must be positive$/, '部位大小必須大於 0'],
  [/^Side must be long or short$/, '方向必須是做多或放空'],
  [/^revisionId is required$/, '需要指定研究更新'],
  [/^The project has no security$/, '這家公司還沒有設定股票代號'],
  [/^Security belongs to another project$/, '這個股票代號屬於另一家公司'],
  [/^(.+) must be YYYY-MM-DD$/, '$1 格式必須是 YYYY-MM-DD'],
  [/^(.+) must be a number$/, '$1 必須是數字'],
  [/^(Project|Evidence|Catalyst|Trade|Review|Template|Security|Revision|Attachment|Note|Draft) not found$/, '找不到資料'],
  [/^Invalid (status|verification status|date precision|review subject)$/, '無效的值'],

  // Market data
  [/^Unknown market data provider "(.+)"\. Available: (.+)$/, '沒有「$1」這個行情來源。可用的有：$2'],
  [/^(NETWORK|RATE_LIMITED|NOT_FOUND|PROVIDER|UNSUPPORTED): (.+?)(?: \(retry after (\d+)s\))?$/, '%2'],
  [/^No imported prices yet\. Import a CSV file\.$/, '還沒有匯入股價，請匯入 CSV 檔。'],
  [/^The CSV needs a header row and at least one data row$/, 'CSV 需要一行標題和至少一行資料'],
  [/^The CSV is missing a "(.+)" column \(expected headers like Date, Open, High, Low, Close, Volume\)$/, 'CSV 少了「$1」欄（標題應該像 Date、Open、High、Low、Close、Volume）'],
  [/^No valid rows found in the CSV$/, 'CSV 裡沒有有效的資料列'],
  [/^CSV data is imported, not fetched\. Import a newer file to update it\.$/, 'CSV 資料是匯入的，不會自動抓取。要更新請匯入新的檔案。'],
  [/^Could not reach Yahoo Finance: (.+)$/, '連不到 Yahoo Finance：$1'],
  [/^Yahoo Finance rate limit reached\. Try again later\.$/, 'Yahoo Finance 請求次數太多，請稍後再試。'],
  [/^Symbol (.+) not found at Yahoo Finance$/, 'Yahoo Finance 找不到代號 $1'],
  [/^Yahoo Finance refused the request \(HTTP (\d+)\); the endpoint may be blocked from this network\. Use CSV import meanwhile\.$/, 'Yahoo Finance 拒絕了請求（HTTP $1），這個網路可能連不到。先改用 CSV 匯入。'],
  [/^Yahoo Finance returned an unexpected \(non-JSON\) response$/, 'Yahoo Finance 回傳的格式不對'],
  [/^Yahoo Finance response has no price$/, 'Yahoo Finance 回傳的資料沒有股價'],
  [/^Unexpected Yahoo Finance response shape$/, 'Yahoo Finance 回傳的格式不對'],
  [/^Yahoo Finance HTTP (\d+)$/, 'Yahoo Finance 回應錯誤（HTTP $1）'],
  [/^Too many requests$/, '請求次數太多'],
  [/^Yahoo Finance has no data for (.+) or (.+)\. Search by name to find the right code, or switch the price source to FinMind\.$/, 'Yahoo Finance 找不到 $1 或 $2。請用名稱搜尋正確的代號，或把股價來源換成 FinMind。'],
  [/^FinMind request limit reached\. Wait an hour or set FINMIND_TOKEN\.$/, 'FinMind 請求次數達上限。請等一小時，或設定 FINMIND_TOKEN。'],
  [/^FinMind has no prices for (.+)$/, 'FinMind 找不到 $1 的股價'],
  [/^FinMind has no recent prices for (.+)$/, 'FinMind 找不到 $1 最近的股價'],
  [/^(FinMind|Fugle) only covers Taiwan stocks; "(.+)" is not a Taiwan stock code$/, '$1 只有台股資料，「$2」不是台股代號'],
  [/^Fugle rejected the API key \(FUGLE_API_KEY\)$/, '富果拒絕了 API 金鑰（FUGLE_API_KEY）'],
  [/^Fugle response has no price$/, '富果回傳的資料沒有股價'],
  [/^Could not reach (.+?): (.+)$/, '連不到 $1：$2'],
  [/^(.+) rate limit reached\. Try again later\.$/, '$1 請求次數太多，請稍後再試。'],
  [/^(.+) returned a non-JSON response \(HTTP (\d+)\)$/, '$1 回傳的格式不對（HTTP $2）'],
  [/^Taiwan stock list: (.+)$/, '台股清單：%1'],
  [/^Yahoo search: (.+)$/, 'Yahoo 搜尋：%1'],
  [/^TWSE ISIN list HTTP (\d+)$/, '證交所代號清單回應錯誤（HTTP $1）'],
  [/^Could not reach the TWSE ISIN list: (.+)$/, '連不到證交所代號清單：$1'],
  [/^The TWSE ISIN list could not be parsed$/, '證交所代號清單無法解析'],
  [/^(FinMind|Fugle): (.+)$/, '$1：$2'],
  [/^Unknown symbol$/, '找不到這個代號'],

  // A period label or node path in front of another message, e.g. "2028E: Division by zero: …"
  [/^(\S+): (.+)$/, '$1：%2'],
];

/** Translate a runtime-generated English message; unknown messages are returned unchanged. */
export function translateMessage(msg: string): string {
  if (getLang() !== 'zh-TW' || !msg) return msg;
  return translate(msg, 0);
}

function translate(msg: string, depth: number): string {
  if (depth > 4) return msg;
  for (const [re, zh] of P) {
    const m = re.exec(msg);
    if (!m) continue;
    return zh.replace(/([$%])(\d)/g, (_, kind: string, i: string) => {
      const g = m[Number(i)] ?? '';
      return kind === '%' ? translate(g, depth + 1) : g;
    });
  }
  return msg;
}
