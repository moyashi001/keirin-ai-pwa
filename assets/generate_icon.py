"""
PWAアイコン生成スクリプト(ネオン系サイバーデザイン)。
Pillowのみで完結。実行後は不要なら削除して構わない。
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math

def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 背景: 濃紺〜紫のグラデーション
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    draw = ImageDraw.Draw(bg)
    top = (10, 2, 28)
    bottom = (30, 8, 60)
    for y in range(size):
        t = y / size
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # 角丸マスク
    radius = int(size * 0.22)
    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    bg.putalpha(mask)
    img = Image.alpha_composite(img, bg)
    draw = ImageDraw.Draw(img)

    cx, cy = size / 2, size / 2

    # ネオングロー用レイヤー(車輪 + 稲妻ライン)
    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow_layer)

    cyan = (0, 255, 242, 255)
    magenta = (255, 0, 230, 255)

    # 外輪(車輪をモチーフ)
    wheel_r = size * 0.32
    stroke = max(2, int(size * 0.035))
    gdraw.ellipse(
        [cx - wheel_r, cy - wheel_r, cx + wheel_r, cy + wheel_r],
        outline=cyan, width=stroke
    )

    # スポーク
    for i in range(8):
        angle = math.pi * 2 * i / 8
        x1 = cx + math.cos(angle) * wheel_r * 0.15
        y1 = cy + math.sin(angle) * wheel_r * 0.15
        x2 = cx + math.cos(angle) * wheel_r * 0.95
        y2 = cy + math.sin(angle) * wheel_r * 0.95
        gdraw.line([(x1, y1), (x2, y2)], fill=cyan, width=max(1, stroke // 2))

    # 中心ハブ
    hub_r = wheel_r * 0.18
    gdraw.ellipse([cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r], fill=magenta)

    # 稲妻(AI/スピード感の演出)、右下から左上へ
    bolt_pts = [
        (cx + wheel_r * 0.55, cy - wheel_r * 1.25),
        (cx + wheel_r * 0.05, cy - wheel_r * 0.15),
        (cx + wheel_r * 0.45, cy - wheel_r * 0.15),
        (cx - wheel_r * 0.55, cy + wheel_r * 1.25),
        (cx - wheel_r * 0.05, cy + wheel_r * 0.05),
        (cx - wheel_r * 0.45, cy + wheel_r * 0.05),
    ]
    gdraw.polygon(bolt_pts, fill=magenta)

    # グローぼかしを重ねて発光感を出す
    for blur, alpha in [(size * 0.05, 0.9), (size * 0.02, 1.0)]:
        blurred = glow_layer.filter(ImageFilter.GaussianBlur(blur))
        img = Image.alpha_composite(img, blurred)
    img = Image.alpha_composite(img, glow_layer)

    img.save(path)


if __name__ == "__main__":
    make_icon(192, "icon-192.png")
    make_icon(512, "icon-512.png")
    print("done")
