from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "icons"
ROOT.mkdir(parents=True, exist_ok=True)

BG = (16, 24, 38, 255)
ACCENT = (46, 201, 160, 255)
BLUE = (59, 130, 246, 255)
WHITE = (255, 255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = max(1, size // 16)
    radius = max(4, size // 5)
    rounded_rect(draw, (pad, pad, size - pad - 1, size - pad - 1), radius, BG)

    inner = max(2, size // 10)
    cal_box = (inner * 2, int(size * 0.18), size - inner * 2, size - inner * 2)
    rounded_rect(draw, cal_box, max(3, size // 8), (24, 36, 54, 255))

    header_h = max(4, int(size * 0.18))
    rounded_rect(
        draw,
        (cal_box[0], cal_box[1], cal_box[2], cal_box[1] + header_h),
        max(2, size // 10),
        BLUE,
    )
    draw.rectangle(
        (cal_box[0], cal_box[1] + header_h // 2, cal_box[2], cal_box[1] + header_h),
        fill=BLUE,
    )

    # check mark
    stroke = max(2, size // 10)
    x0 = int(size * 0.30)
    y0 = int(size * 0.62)
    x1 = int(size * 0.46)
    y1 = int(size * 0.76)
    x2 = int(size * 0.74)
    y2 = int(size * 0.44)
    draw.line([(x0, y0), (x1, y1), (x2, y2)], fill=ACCENT, width=stroke, joint="curve")
    return img


for size in (16, 48, 128):
    make_icon(size).save(ROOT / f"icon{size}.png")
    print(f"wrote icon{size}.png")
