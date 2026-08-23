# -*- coding: utf-8 -*-
"""投資決策情境回測引擎。

模組分工：
- config.py     全部固定參數與級距錨點
- data.py       日線 CSV 讀取與對齊
- simulator.py  交易計畫模擬（進場、加碼、各自停損停利、假設路徑）
- metrics.py    夏普級距、波動、回檔、相關性、集中度、穩定度
- valuation.py  共識 EPS × 自訂本益比區間
- report.py     跑一個情境並整理成一份可比較的結果
"""
