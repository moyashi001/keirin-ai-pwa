"""
convert_to_onnx.py
学習済みLightGBMモデル(model.pkl)をONNX形式に変換し、
既存PWAのONNX Runtime Webから読み込める keirin_model.onnx として保存する。
"""
import pickle

from onnxmltools.convert import convert_lightgbm
from onnxmltools.convert.common.data_types import FloatTensorType

from build_features import FEATURE_COLUMNS


def convert(model_path: str = "training/model.pkl", onnx_out: str = "training/keirin_model.onnx"):
    with open(model_path, "rb") as f:
        model = pickle.load(f)

    # 推論はブラウザ側で float32 で行うため入力型もfloatに統一する
    initial_types = [("input", FloatTensorType([None, len(FEATURE_COLUMNS)]))]
    onnx_model = convert_lightgbm(
        model,
        initial_types=initial_types,
        target_opset=13,
        zipmap=False,  # 出力を辞書ではなく単純な確率テンソルにする(ブラウザ側の扱いを簡潔にするため)
    )

    with open(onnx_out, "wb") as f:
        f.write(onnx_model.SerializeToString())
    print(f"saved ONNX model to {onnx_out}")
    print(f"input: {[i.name for i in onnx_model.graph.input]}")
    print(f"output: {[o.name for o in onnx_model.graph.output]}")


if __name__ == "__main__":
    convert()
