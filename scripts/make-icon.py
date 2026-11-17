"""Generate Viewsical's cropped rounded Windows and UI icons from supplied artwork."""
from pathlib import Path
from PIL import Image, ImageDraw

project = Path(__file__).resolve().parents[1]
source = Image.open(project / "resources/branding/source-artwork.png").convert("RGBA")
side = 600
# Center on the red circle/strokes, rather than the asymmetric canvas/brushes.
red = Image.new("L", source.size)
red.putdata([255 if r > 180 and g > 18 and r > g * 1.45 and r > b * 1.5 else 0 for r, g, b, _ in source.getdata()])
bounds = red.getbbox()
if bounds is None:
    raise ValueError("The supplied artwork has no red play/circle strokes")
center_x, center_y = (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2
left, top = round(center_x - side / 2), round(center_y - side / 2)
image = source.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.Resampling.LANCZOS)
mask = Image.new("L", image.size)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 1023, 1023), radius=210, fill=255)
image.putalpha(mask)
icons = project / "src-tauri/icons"
icons.mkdir(exist_ok=True)
image.resize((512, 512), Image.Resampling.LANCZOS).save(icons / "icon.png")
image.resize((256, 256), Image.Resampling.LANCZOS).save(icons / "icon.ico", format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.resize((256, 256), Image.Resampling.LANCZOS).save(project / "src/assets/app-icon.png")
