import sys
from Xlib import X
from Xlib.display import Display
d = Display()
root = d.screen().root
w, h = root.get_geometry().width, root.get_geometry().height
raw = root.get_image(0, 0, w, h, X.ZPixmap, 0xffffffff)
with open(sys.argv[1], 'wb') as f:
    from PIL import Image
    img = Image.frombytes('RGB', (w, h), raw.data, 'raw', 'BGRX')
    img.save(sys.argv[1])
print(f"saved {sys.argv[1]} {w}x{h}")
