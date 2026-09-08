"""
build_features.py
結合済みの競輪レースデータ(raw_keirin_data.csv)から競輪AI用の特徴量を作成する。

■ このデータセットで実際に取得できた列と、要件との対応関係(重要)
  ・競走得点            -> race_score 列をそのまま使用
  ・脚質(one-hot)       -> running_style 列は「逃/追/両」の3カテゴリで提供されている
                          (「まくり」という脚質ラベルは無く、決まり手側にのみ存在する)
  ・直近5走の平均着順    -> rank 列を選手ごとに日付順で並べ、shift(1)+rolling(5)で算出
                          (当該レース自身の結果を含めない=未来情報のリーク防止)
  ・直近5走の決まり手割合 -> finish_type 列(逃/捲/差など)の直近5走出現率
  ・ライン位置(先頭/番手/3番手)
                        -> このデータセットにライン構成そのものは含まれていない。
                          "lineup" 列は記者による予想印(◎○注×△▲)であることが判明したため、
                          代わりに「レース内の予想印順位(mark_rank: ◎=1〜▲=6、印なし=7)」を
                          "レース内での有力度順位" として代理特徴量に採用している。
                          PWA側(featureBuilder.js)では出走表に予想印が無いため、
                          オッズの低い順につけた順位を同じ意味の代理として用いる。

目的変数: is_win (1着=1, それ以外=0)
"""
import re

import pandas as pd

MARK_ORDER = ["◎", "○", "注", "×", "△", "▲"]
MARK_RANK = {m: i + 1 for i, m in enumerate(MARK_ORDER)}
UNMARKED_RANK = len(MARK_ORDER) + 1  # 印なし

FEATURE_COLUMNS = [
    "race_score",
    "style_nige",
    "style_oikomi",
    "style_ryo",
    "recent_avg_rank",
    "recent_nige_rate",
    "recent_makuri_rate",
    "recent_sashi_rate",
    "rank_position",
]
TARGET_COLUMN = "is_win"


def parse_lineup_marks(lineup_str) -> dict[int, str]:
    """'◎1 ○7 注5 ×2 △4 ▲6' -> {1:'◎', 7:'○', 5:'注', 2:'×', 4:'△', 6:'▲'}"""
    if not isinstance(lineup_str, str):
        return {}
    pairs = re.findall(r"([◎○注×△▲])\s*(\d+)", lineup_str)
    return {int(num): mark for mark, num in pairs}


def add_mark_rank(df: pd.DataFrame) -> pd.DataFrame:
    def resolve(row):
        marks = parse_lineup_marks(row["lineup"])
        mark = marks.get(row["banum"])
        return MARK_RANK.get(mark, UNMARKED_RANK)

    df = df.copy()
    df["rank_position"] = df.apply(resolve, axis=1)
    return df


def add_style_onehot(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["style_nige"] = (df["running_style"] == "逃").astype(int)
    df["style_oikomi"] = (df["running_style"] == "追").astype(int)
    df["style_ryo"] = (df["running_style"] == "両").astype(int)
    return df


def add_recent_form_features(df: pd.DataFrame) -> pd.DataFrame:
    """選手ごとに時系列順で直近5走の平均着順・決まり手割合を算出する(未来情報リークなし)。

    注意: このデータセットに選手固有IDが無いため player_name をキーに使っている。
    同姓同名選手が存在する場合はまれに他選手の成績が混入し得る。
    """
    df = df.copy()
    df["rank_numeric"] = pd.to_numeric(df["rank"], errors="coerce")  # 落/失/欠/故はNaN化
    df = df.sort_values(["player_name", "date", "race_no"]).reset_index(drop=True)

    grouped_rank = df.groupby("player_name")["rank_numeric"]
    df["recent_avg_rank"] = grouped_rank.transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())

    for label, col in [("逃", "recent_nige_rate"), ("捲", "recent_makuri_rate"), ("差", "recent_sashi_rate")]:
        is_type = (df["finish_type"] == label).astype(int)
        df[col] = is_type.groupby(df["player_name"]).transform(lambda s: s.shift(1).rolling(5, min_periods=1).mean())

    return df


def add_target(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df[TARGET_COLUMN] = (df["rank"] == "1").astype(int)
    return df


def fill_missing(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["race_score"] = df["race_score"].fillna(df["race_score"].median())
    # 初出走などで直近成績が無い選手はレース全体の平均値で補完する
    for col in ["recent_avg_rank", "recent_nige_rate", "recent_makuri_rate", "recent_sashi_rate"]:
        df[col] = df[col].fillna(df[col].mean())
    df["rank_position"] = df["rank_position"].fillna(UNMARKED_RANK)
    return df


def build_features(raw_df: pd.DataFrame) -> pd.DataFrame:
    df = raw_df.copy()
    df = add_style_onehot(df)
    df = add_mark_rank(df)
    df = add_recent_form_features(df)
    df = add_target(df)
    df = fill_missing(df)
    keep = ["race_id", "date", "race_no", "banum", "player_name"] + FEATURE_COLUMNS + [TARGET_COLUMN]
    return df[keep]


if __name__ == "__main__":
    raw = pd.read_csv("training/raw_keirin_data.csv", encoding="utf-8-sig")
    features = build_features(raw)
    features.to_csv("training/features.csv", index=False, encoding="utf-8-sig")
    print(f"features shape: {features.shape}")
    print(features[FEATURE_COLUMNS + [TARGET_COLUMN]].describe())
