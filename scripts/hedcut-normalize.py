"""把 Codex 產出的點畫圖裁成一致的構圖，輸出網站用的大圖與縮圖。

人物：頭寬固定佔畫面 46%、頭頂上方留 15%、水平置中；縮圖再往頭部裁緊一點。
物件：主體佔畫面 68%、置中。
背景接近白的像素一律拉到純白，疊在頁面上才不會出現方塊。
用法（在放了 out/<slug>.png 的工作資料夾裡執行，需要 Pillow）：
  python3 hedcut-normalize.py <slug> <person|object> [out_dir]
會寫出 <out_dir>/<slug>.webp（800px）與 <out_dir>/<slug>-thumb.webp（192px），
複製到 public/fund-covers/hedcut/ 即可。畫法與出圖規格見 DESIGN.md「基金封面：點畫」。
"""
import sys
from PIL import Image

HEAD = 0.46  # 頭寬佔大圖的比例

def load(path):
    img = Image.open(path).convert("L")
    return img.point(lambda v: 255 if v >= 236 else v)

def ink_rows_cols(img, y0, y1):
    w, h = img.size
    px = img.load()
    cols = [x for x in range(0, w) if sum(1 for y in range(y0, y1, 2) if px[x, y] < 150) >= 2]
    return cols

def first_ink_row(img):
    w, h = img.size
    px = img.load()
    for y in range(h):
        if sum(1 for x in range(0, w, 2) if px[x, y] < 150) >= 3:
            return y
    return 0

def crop_pad(img, x0, y0, size):
    x0, y0, size = int(round(x0)), int(round(y0)), int(round(size))
    canvas = Image.new("L", (size, size), 255)
    canvas.paste(img, (-x0, -y0))
    return canvas

def person(img):
    w, h = img.size
    top = first_ink_row(img)
    # 先用頭頂往下 20% 粗估頭寬，再用「頭頂往下一個頭寬」的範圍重量一次：
    # 這個範圍涵蓋耳朵與最寬處，但還碰不到肩膀，量出來的寬度與中心才穩。
    head_w = None
    band = int(h * 0.20)
    for _ in range(3):
        cols = ink_rows_cols(img, top, min(h, top + band))
        left, right = cols[int(len(cols) * 0.01)], cols[int(len(cols) * 0.99) - 1]
        head_w = right - left
        band = int(head_w * 1.0)
    size = head_w / HEAD
    cx = (left + right) / 2
    full = crop_pad(img, cx - size / 2, top - 0.15 * size, size)
    t = full.size[0]
    # 縮圖只比大圖緊一點（頭寬約佔 52%），四周留白，放進小圓框才不會太滿。
    thumb = full.crop((int(t * 0.06), int(t * 0.03), int(t * 0.94), int(t * 0.91)))
    return full, thumb, dict(top=round(top / h, 3), head_w=round(head_w / w, 3))

def obj(img):
    w, h = img.size
    px = img.load()
    xs = [x for x in range(w) if any(px[x, y] < 150 for y in range(0, h, 3))]
    ys = [y for y in range(h) if any(px[x, y] < 150 for x in range(0, w, 3))]
    bw, bh = xs[-1] - xs[0], ys[-1] - ys[0]
    size = max(bw, bh) / 0.68
    cx, cy = (xs[0] + xs[-1]) / 2, (ys[0] + ys[-1]) / 2
    full = crop_pad(img, cx - size / 2, cy - size / 2, size)
    return full, full, dict(bbox=(round(bw / w, 3), round(bh / h, 3)))

if __name__ == "__main__":
    slug, kind = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else "web"
    img = load(f"out/{slug}.png")
    full, thumb, info = (person if kind == "person" else obj)(img)
    full.resize((800, 800), Image.LANCZOS).save(f"{out}/{slug}.webp", quality=80, method=6)
    thumb.resize((192, 192), Image.LANCZOS).save(f"{out}/{slug}-thumb.webp", quality=86, method=6)
    print(slug, kind, info)
