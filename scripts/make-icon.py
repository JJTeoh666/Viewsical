"""Generate Viewsical's rounded Windows and UI icons from the square artwork."""
from pathlib import Path
from PIL import Image, ImageDraw

project = Path(__file__).resolve().parents[1]
with Image.open(project / "resources/branding/source-artwork.png") as source:
    artwork = source.convert("RGB")

side = artwork.width
if artwork.height != side:
    raise ValueError("The icon artwork must be square")

mask = Image.new("L", artwork.size)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, side - 1, side - 1), radius=round(side * 0.22), fill=255)


def icon_at_size(size: int) -> Image.Image:
    dimensions = (size, size)
    image = artwork.resize(dimensions, Image.Resampling.LANCZOS)
    # Average edge coverage without Lanczos ringing in the transparent corners.
    image.putalpha(mask.resize(dimensions, Image.Resampling.BOX))
    return image


icons = project / "src-tauri/icons"
icons.mkdir(exist_ok=True)
icon_at_size(512).save(icons / "icon.png")
ui_icon = icon_at_size(256)
ui_icon.save(project / "src/assets/app-icon.png")
smaller_icons = [icon_at_size(size) for size in [16, 24, 32, 48, 64, 128]]
ui_icon.save(icons / "icon.ico", append_images=smaller_icons)
