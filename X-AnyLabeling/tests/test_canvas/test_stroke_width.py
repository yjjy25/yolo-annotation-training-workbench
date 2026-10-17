import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PyQt6 import QtCore, QtGui, QtWidgets

    from anylabeling.views.labeling.shape import Shape
    from anylabeling.views.labeling.widgets.canvas import Canvas

    PYQT_AVAILABLE = True
except Exception:
    PYQT_AVAILABLE = False


@unittest.skipUnless(
    PYQT_AVAILABLE, "PyQt6 is required for canvas stroke width tests"
)
class TestCanvasStrokeWidth(unittest.TestCase):

    def setUp(self):
        self.app = QtWidgets.QApplication.instance()
        if self.app is None:
            self.app = QtWidgets.QApplication([])

    @staticmethod
    def _render_line(scale):
        image = QtGui.QImage(100, 100, QtGui.QImage.Format.Format_ARGB32)
        image.fill(QtGui.QColor("white"))
        shape = Shape(label="line", shape_type="line")
        shape.points = [
            QtCore.QPointF(2.0, 10.0),
            QtCore.QPointF(18.0, 10.0),
        ]
        shape.line_color = QtGui.QColor("black")
        shape.line_width = 2.0
        shape.scale = scale

        painter = QtGui.QPainter(image)
        painter.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing)
        painter.scale(scale, scale)
        shape.paint(painter)
        painter.end()

        x = int(10 * scale)
        return sum(
            QtGui.QColor(image.pixel(x, y)) != QtGui.QColor("white")
            for y in range(image.height())
        )

    def test_shape_width_is_independent_of_zoom(self):
        self.assertEqual(self._render_line(1.0), self._render_line(4.0))

    def test_crosshair_pen_supports_half_pixel_cosmetic_width(self):
        canvas = Canvas(parent=None)
        canvas.cross_line_width = 0.5

        pen = canvas._cross_line_pen()

        self.assertEqual(pen.widthF(), 0.5)
        self.assertTrue(pen.isCosmetic())
        canvas.close()

    def test_crosshair_rect_covers_canvas_outside_pixmap(self):
        canvas = Canvas(parent=None)
        canvas.resize(200, 160)
        canvas.pixmap = QtGui.QPixmap(50, 40)
        canvas.scale = 2.0

        rect = canvas._cross_line_rect()

        self.assertEqual(rect, QtCore.QRectF(-25.0, -20.0, 100.0, 80.0))
        for point in (
            QtCore.QPointF(-10.0, 20.0),
            QtCore.QPointF(60.0, 20.0),
            QtCore.QPointF(20.0, -10.0),
            QtCore.QPointF(20.0, 50.0),
        ):
            self.assertTrue(rect.contains(point))
        canvas.close()
