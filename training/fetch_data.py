"""
fetch_data.py
GitHub上の競輪レース結果CSV(raw形式)を複数まとめて取得し、1つのDataFrameへ結合する。

データ出典: https://github.com/Kenseimk/keirin-data
  実ファイルは keirin_data/{year}_{month:02d}_keirin.csv という命名で、
  2022年1月〜現在まで月次で格納されている(要件で例示された
  race_results_202401.csv 形式のファイルは同リポジトリには存在しなかったため、
  実際に確認できたパス形式に合わせている)。

このモジュール単体で実行すると、指定期間のCSVを取得して
training/raw_keirin_data.csv に結合結果を保存する。
"""
import io
import sys
import time
from datetime import date

import pandas as pd
import requests

RAW_BASE_URL = "https://raw.githubusercontent.com/Kenseimk/keirin-data/main/keirin_data"


def build_month_urls(start_year: int, start_month: int, end_year: int, end_month: int) -> list[str]:
    """開始年月〜終了年月(両端含む)の月次CSV URL一覧を生成する。"""
    urls = []
    y, m = start_year, start_month
    while (y, m) <= (end_year, end_month):
        urls.append(f"{RAW_BASE_URL}/{y}_{m:02d}_keirin.csv")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return urls


def fetch_csv(url: str, timeout: int = 30) -> pd.DataFrame | None:
    """1つのCSV URLを取得してDataFrame化する。取得できない場合はNoneを返す。"""
    try:
        res = requests.get(url, timeout=timeout)
        if res.status_code != 200:
            print(f"  [skip] {url} -> status {res.status_code}")
            return None
        # ファイル冒頭にUTF-8 BOMが付与されているため utf-8-sig で読む
        df = pd.read_csv(io.BytesIO(res.content), encoding="utf-8-sig")
        df["__source_url"] = url
        return df
    except Exception as e:
        print(f"  [error] {url} -> {e}")
        return None


def fetch_all(urls: list[str], sleep_sec: float = 0.3) -> pd.DataFrame:
    """複数URLのCSVを順に取得して1つのDataFrameへ結合する。"""
    frames = []
    for i, url in enumerate(urls):
        print(f"[{i + 1}/{len(urls)}] fetching {url}")
        df = fetch_csv(url)
        if df is not None:
            frames.append(df)
        time.sleep(sleep_sec)  # 連続アクセス防止

    if not frames:
        raise RuntimeError("有効なCSVを1件も取得できませんでした。URL一覧を確認してください。")

    combined = pd.concat(frames, ignore_index=True)
    print(f"combined shape: {combined.shape}")
    return combined


if __name__ == "__main__":
    # 例: 2022年1月〜現在の前月まで全期間を取得
    today = date.today()
    end_year, end_month = today.year, today.month - 1 or 12
    if today.month == 1:
        end_year -= 1

    urls = build_month_urls(2022, 1, end_year, end_month)
    df = fetch_all(urls)
    df.to_csv("training/raw_keirin_data.csv", index=False, encoding="utf-8-sig")
    print("saved to training/raw_keirin_data.csv")
