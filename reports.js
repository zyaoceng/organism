/* 有機體 研究文章清單
   新增一篇文章 = 在 REPORTS 最上面加一行。
   type：Deep（個股深度）、Preview（財報前預覽）、Review（財報後檢討）、Industry（產業研究）、Deck（簡報與講稿）、Scorecard（採信度盤）
   tickers：相關標的代號，名稱寫在下面的 TICKERS 對照表 */

const TICKERS = {
  "2301": "光寶科", "2308": "台達電", "MPWR": "Monolithic Power", "VRT": "Vertiv",
  "IFX": "英飛凌", "NVTS": "Navitas", "ON": "onsemi",
  "MU": "美光", "SNDK": "SanDisk", "8299": "群聯",
  "AAOI": "Applied Optoelectronics", "AXTI": "AXT", "LITE": "Lumentum",
  "3037": "欣興", "3189": "景碩", "8046": "南電", "4958": "臻鼎-KY",
  "INTC": "Intel", "AMD": "AMD", "QCOM": "Qualcomm", "ARM": "Arm", "3533": "嘉澤",
  "AVGO": "Broadcom"
};

const REPORTS = [
  { type: "Deep", date: "2026-09-14", title: "光寶科：2028 三情境估值 v2.1", tickers: ["2301"], href: "liteon-2028-scenarios-v2_1.html" },
  { type: "Deck", date: "2026-09-14", title: "800VDC 供電架構簡報", tickers: [], href: "800vdc-presentation-2026-09-14.pdf" },
  { type: "Deep", date: "2026-08-22", title: "AVGO 博通：個股研究報告完整版", tickers: ["AVGO"], href: "09_AVGO/AVGO_Broadcom個股研究報告_完整版_2026-08-22.pdf" },
  { type: "Industry", date: "2026-08-20", title: "800VDC 第二批：英飛凌・Navitas・onsemi", tickers: ["IFX", "NVTS", "ON"], href: "05_800VDC/800VDC_第二批_IFX_NVTS_ON_2026-08-20.html" },
  { type: "Industry", date: "2026-08-20", title: "800VDC 七檔整合對內報告", tickers: ["2301", "2308", "MPWR", "VRT", "IFX", "NVTS", "ON"], href: "05_800VDC/800VDC_七檔整合對內報告_2026-08-20.html" },
  { type: "Scorecard", date: "2026-08-19", title: "英飛凌 採信度盤", tickers: ["IFX"], href: "05_800VDC/IFX_ballot_20260819.html" },
  { type: "Scorecard", date: "2026-08-19", title: "Navitas 採信度盤", tickers: ["NVTS"], href: "05_800VDC/NVTS_ballot_20260819.html" },
  { type: "Scorecard", date: "2026-08-19", title: "onsemi 採信度盤", tickers: ["ON"], href: "05_800VDC/ON_ballot_20260819.html" },
  { type: "Industry", date: "2026-08-18", title: "800VDC 電源革命：台達電・光寶科・Vertiv・MPWR", tickers: ["2308", "2301", "VRT", "MPWR"], href: "05_800VDC/800VDC_社團版_2026-08-18.html" },
  { type: "Industry", date: "2026-08-17", title: "800VDC 電源革命：對內完整推導", tickers: ["2308", "2301", "VRT", "MPWR"], href: "05_800VDC/800VDC對內報告_2026-08-17.html" },
  { type: "Industry", date: "2026-08-17", title: "800VDC 電源革命（前一版）", tickers: ["2308", "2301", "VRT", "MPWR"], href: "05_800VDC/800VDC_社團版_2026-08-17.html" },
  { type: "Scorecard", date: "2026-08-16", title: "光寶科 採信度盤", tickers: ["2301"], href: "05_800VDC/2301_ballot_20260816.html" },
  { type: "Scorecard", date: "2026-08-16", title: "台達電 採信度盤", tickers: ["2308"], href: "05_800VDC/2308_ballot_20260816.html" },
  { type: "Scorecard", date: "2026-08-16", title: "MPWR 採信度盤", tickers: ["MPWR"], href: "05_800VDC/MPWR_ballot_20260816.html" },
  { type: "Scorecard", date: "2026-08-16", title: "Vertiv 採信度盤", tickers: ["VRT"], href: "05_800VDC/VRT_ballot_20260816.html" },
  { type: "Industry", date: "2026-08-16", title: "記憶體產業分析：美光・SanDisk・群聯", tickers: ["MU", "SNDK", "8299"], href: "04_記憶體/記憶體_社團版_2026-08-16.html" },
  { type: "Industry", date: "2026-08-15", title: "記憶體：AI 時代的儲存生意（前一版）", tickers: ["MU", "SNDK", "8299"], href: "04_記憶體/記憶體_社團版_2026-08-15.html" },
  { type: "Industry", date: "2026-08-08", title: "CPU 產業分析：Intel・AMD・Qualcomm・Arm・嘉澤", tickers: ["INTC", "AMD", "QCOM", "ARM", "3533"], href: "07_CPU/CPU產業分析_Intel-AMD-Qualcomm-Arm-嘉澤_2026-08-08.pdf" },
  { type: "Industry", date: "2026-07-31", title: "光通訊產業深度報告", tickers: ["AAOI", "AXTI", "LITE"], href: "03_光通訊/講義/光通訊產業深度報告_2026-07-31.pdf" },
  { type: "Industry", date: "2026-07-30", title: "光通訊產業研究與投資策略 v2（對內完整版）", tickers: ["AAOI", "AXTI", "LITE"], href: "03_光通訊/講義/光通訊_對內完整版v2_2026-07-30.html" },
  { type: "Industry", date: "2026-07-26", title: "光通訊全景故事線：從「銦」到 GPU", tickers: ["AAOI", "AXTI", "LITE"], href: "03_光通訊/講義/光通訊產業_故事線_2026-07-26.html" },
  { type: "Industry", date: "2026-07-25", title: "光通訊產業報告 對內完整版 v1（前一版）", tickers: ["AAOI", "AXTI", "LITE"], href: "03_光通訊/講義/光通訊_對內完整版_2026-07-25.html" },
  { type: "Deck", date: "2026-07-19", title: "ASIC 產業講解（60 分鐘討論會投影片）", tickers: [], href: "02_ASIC/ASIC 產業講解.pdf" },
  { type: "Deck", date: "2026-07-19", title: "ASIC 主講者講稿", tickers: [], href: "02_ASIC/ASIC 主講者講稿.pdf" },
  { type: "Deck", date: "2026-07-19", title: "ASIC 產業講解 PowerPoint 原檔", tickers: [], href: "02_ASIC/ASIC 產業講解.pptx" },
  { type: "Deck", date: "2026-07-11", title: "功率半導體：AI 時代的電力生意（投影版）", tickers: [], href: "01_功率半導體/功率半導體_社團投影版_2026-07-11.html" },
  { type: "Industry", date: "2026-07-11", title: "功率半導體 講者完整版", tickers: [], href: "01_功率半導體/功率半導體_講者完整版_2026-07-11.html" },
  { type: "Industry", date: "2026-07-11", title: "功率半導體 進階 QA 四題", tickers: [], href: "01_功率半導體/功率半導體_進階QA四題_2026-07-11.html" },
  { type: "Industry", date: "2026-07", title: "IC 載板產業分析：欣興・景碩・南電・臻鼎-KY", tickers: ["3037", "3189", "8046", "4958"], href: "06_IC載板/IC載板產業分析_欣興-景碩-南電-臻鼎KY_2026-07.pdf" },
  { type: "Deck", date: "2026-07", title: "資料中心散熱：三段成熟度框架與 5+1 檔個股定位", tickers: [], href: "08_資料中心散熱/資料中心散熱_主題投資投影片_2026-07.pdf" }
];
