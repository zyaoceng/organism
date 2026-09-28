/** zh-TW labels for constants defined in src/domain and src/shared (roles, units, source types…). */
export const domain: Record<string, string> = {
  // Tabs
  Overview: '總覽',
  Model: '模型',
  Evidence: '證據',
  Valuation: '估值',
  Catalysts: '催化劑',
  Market: '行情',
  Trades: '交易',
  History: '歷史',

  // Scenarios
  Bear: '空頭',
  Base: '基準',
  Bull: '多頭',

  // Node roles
  EPS: 'EPS',
  Revenue: '營收',
  'Gross margin': '毛利率',
  'Operating income': '營業利益',
  'Net income': '淨利',
  'Diluted shares': '稀釋後股數',
  'EPS growth': 'EPS 成長率',
  ROIC: 'ROIC',
  'Reinvestment ROI': '再投資報酬率',
  'Target multiple (P/E)': '目標倍數（本益比）',
  'Target price': '目標價',
  'Re-rating thesis': '評價重估論點',

  // Evidence link relations
  Supports: '支持',
  Contradicts: '反駁',
  Context: '背景',
  'Triggered change': '觸發修改',

  // Unit kinds and scales
  'Currency amount': '金額',
  'Per share': '每股',
  Percent: '百分比',
  'Multiple (x)': '倍數（x）',
  Shares: '股數',
  'Count / units': '數量',
  'Plain number': '純數字',
  'units (1)': '個（1）',
  thousand: '千',
  million: '百萬',
  '億 (100 million)': '億',
  billion: '十億',

  // Evidence source types
  'News article': '新聞',
  'Earnings call': '法說會',
  'Filing / financial report': '公告／財報',
  'Broker report': '券商報告',
  'Industry report': '產業報告',
  'Conference / presentation': '研討會／簡報',
  'Customer announcement': '客戶公告',
  Conversation: '訪談',
  'Expert report / call': '專家報告／訪談',
  Dataset: '資料集',
  Screenshot: '截圖',
  Other: '其他',

  // Catalyst types
  Earnings: '財報',
  'Investor day': '投資人日',
  'Conference (GTC, CES…)': '大型展會（GTC、CES…）',
  'Product launch': '新產品發表',
  'Customer qualification': '客戶認證',
  'Factory ramp': '工廠量產爬坡',
  'Regulatory decision': '監管決定',

  // Post-mortem error categories
  'Evidence quality': '證據品質',
  'Evidence interpretation': '證據解讀',
  'Assumption magnitude': '假設幅度',
  'Financial model / formula': '財務模型／公式',
  'Timing / catalyst': '時點／催化劑',
  'Valuation multiple': '估值倍數',
  'Trading execution': '交易執行',
  'Risk management': '風險管理',

  // Formula function help
  'Sum of the arguments. SUM(CHILDREN()) sums the direct child nodes that share this node’s unit kind.':
    '把所有參數加總。SUM(CHILDREN()) 會加總和本節點單位種類相同的直接子節點。',
  'Smallest argument, e.g. MIN([Demand], [Capacity]).': '取最小值，例如 MIN([需求], [產能])。',
  'Largest argument.': '取最大值。',
  'Arithmetic mean of the arguments.': '取平均值。',
  '(end / begin)^(1 / years) − 1.': '年複合成長率：(期末 / 期初)^(1 / 年數) − 1。',
  'Only the chosen branch is evaluated.': '條件成立取第一個值，否則取第二個值，只計算被選到的那一邊。',
  'Absolute value.': '取絕對值。',
  'Round to the given number of decimals (default 0).': '四捨五入到指定小數位數（預設 0 位）。',
  '1 if every argument is non-zero, else 0.': '所有參數都不是 0 時為 1，否則為 0。',
  '1 if any argument is non-zero, else 0.': '任一參數不是 0 時為 1，否則為 0。',
  '1 if x is zero, else 0.': 'x 是 0 時為 1，否則為 0。',
  'Value of x in the period n steps earlier (default 1). Not a circular reference.': '取 x 在前 n 期的值（預設前 1 期），不算循環參照。',
  'The direct children of this node with the same unit kind. Only inside SUM/MIN/MAX/AVERAGE.':
    '本節點中單位種類相同的直接子節點，只能放在 SUM／MIN／MAX／AVERAGE 裡面。',
};
