from Xlib.display import Display
d = Display()
s = d.screen()
print("screen", s.width_in_pixels, s.height_in_pixels)
def walk(win, depth=0):
    try:
        name = win.get_full_property(d.intern_atom('_NET_WM_NAME'), d.intern_atom('UTF8_STRING'))
        title = name.value.decode() if name and name.value else None
    except Exception:
        title = None
    try:
        geom = win.get_geometry()
        print('  '*depth, hex(win.id), title, geom.width, geom.height, '@', geom.x, geom.y)
    except Exception:
        pass
    for child in win.query_tree().children:
        walk(child, depth+1)
walk(s.root)
