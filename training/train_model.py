"""
train_model.py
build_features.py で作成した特徴量を使い、LightGBMで「1着になる確率」を学習する。

train/testはレース単位ではなく日付で時系列分割する(未来のレースで過去を予測する
形にならないよう、学習データより後の日付のみをテストに使う)。
"""
import pickle

import lightgbm as lgb
import pandas as pd
from sklearn.metrics import roc_auc_score, log_loss

from build_features import FEATURE_COLUMNS, TARGET_COLUMN


def time_based_split(df: pd.DataFrame, test_ratio: float = 0.2):
    df = df.sort_values("date")
    split_idx = int(len(df) * (1 - test_ratio))
    split_date = df.iloc[split_idx]["date"]
    train_df = df[df["date"] < split_date]
    test_df = df[df["date"] >= split_date]
    return train_df, test_df


def train(features_csv: str = "training/features.csv", model_out: str = "training/model.pkl"):
    df = pd.read_csv(features_csv, encoding="utf-8-sig")
    train_df, test_df = time_based_split(df)

    X_train, y_train = train_df[FEATURE_COLUMNS], train_df[TARGET_COLUMN]
    X_test, y_test = test_df[FEATURE_COLUMNS], test_df[TARGET_COLUMN]

    print(f"train: {X_train.shape}, test: {X_test.shape}")
    print(f"train positive rate: {y_train.mean():.4f}, test positive rate: {y_test.mean():.4f}")

    model = lgb.LGBMClassifier(
        objective="binary",
        n_estimators=400,
        learning_rate=0.03,
        num_leaves=31,
        min_child_samples=30,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
    )
    model.fit(
        X_train,
        y_train,
        eval_set=[(X_test, y_test)],
        eval_metric="auc",
        callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(50)],
    )

    pred = model.predict_proba(X_test)[:, 1]
    auc = roc_auc_score(y_test, pred)
    ll = log_loss(y_test, pred)
    print(f"[evaluation] AUC = {auc:.4f}, LogLoss = {ll:.4f}")

    importance = pd.Series(model.feature_importances_, index=FEATURE_COLUMNS).sort_values(ascending=False)
    print("[feature importance]")
    print(importance)

    with open(model_out, "wb") as f:
        pickle.dump(model, f)
    print(f"saved model to {model_out}")

    return model, auc, ll


if __name__ == "__main__":
    train()
