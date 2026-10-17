"""Render retained Qt tools inside Electron, without a second desktop window."""
from PyQt6 import QtCore as C, QtGui as G, QtWidgets as W, QtTest
import hashlib


def _scale_of(widget, fallback):
    """Device pixels per logical pixel for a widget, never below 1."""
    try:
        value = float(widget.devicePixelRatioF())
    except (AttributeError, TypeError, ValueError):
        value = float(fallback)
    return value if value >= 1 else 1.0


class InlineTools(C.QObject):
    def __init__(self,bridge):
        super().__init__(bridge)
        self.bridge=bridge
        self.window=bridge.window
        self.enabled=False
        self.mouse_target=None
        self.frame_digest=None
        self.idle_ticks=0
        self.window.setWindowFlag(C.Qt.WindowType.FramelessWindowHint,True)
        self.window.move(0,0)
        self.timer=C.QTimer(self)
        self.timer.timeout.connect(self.frame)
        self.timer.start(120)

    def show(self,visible,width=1000,height=650):
        self.enabled=visible
        if visible:
            self.window.resize(max(640,min(1800,int(width))),max(400,min(1200,int(height))))
            self.window.move(0,0)
            self.window.show()
            self.frame_digest=None
            self.idle_ticks=0
            if self.timer.interval()!=120:self.timer.setInterval(120)
            self.frame()
        else:
            self.mouse_target=None
            for widget in self.visible_windows()[1:]:widget.hide()

    def dismiss(self):
        app=W.QApplication.instance()
        widget=app.activePopupWidget() or app.activeModalWidget()
        if widget is None:
            widget=next((w for w in reversed(self.visible_windows()) if isinstance(w,W.QDialog)),None)
        if widget is not None and widget is not self.window:
            widget.close()
        return True

    def visible_windows(self):
        app=W.QApplication.instance()
        windows=[w for w in app.topLevelWidgets() if w.isVisible() and w is not self.window and not isinstance(w,W.QToolBar)]
        modal=app.activeModalWidget()
        popup=app.activePopupWidget()
        return [self.window]+[w for w in windows if w is not modal and w is not popup]+([modal] if modal and modal is not self.window else [])+([popup] if popup and popup is not modal else [])

    def render_scale(self):
        """Bitmap pixels per logical pixel for the captured frame.

        The offscreen Qt platform reports a device pixel ratio of 1 even on a
        200% display, so the host display scale is the only reliable source.
        Without it Electron had to stretch a 1x bitmap over a 2x area.
        """
        host = 1.0
        try:
            host = float(getattr(self.bridge, "display_scale", 1.0))
        except (TypeError, ValueError):
            host = 1.0
        widget = _scale_of(self.window, 1.0)
        return min(3.0, max(1.0, host, widget))

    def frame(self):
        if not self.enabled:return
        origin=self.window.mapToGlobal(C.QPoint(0,0))
        layers=[]
        area=C.QRect(0,0,self.window.width(),self.window.height())
        for widget in self.visible_windows():
            position=widget.mapToGlobal(C.QPoint(0,0))-origin
            bounds=C.QRect(position,widget.size())
            area=area.united(bounds)
            layers.append((widget,position))
        # Compose at the physical resolution of the host display. Qt geometry
        # below stays in logical pixels, and the bitmap is always exactly
        # logical*scale: an extra clamp here used to shrink the frame for very
        # large panels, which broke the pointer mapping in Electron because the
        # bitmap-to-surface ratio no longer matched the display scale.
        scale=self.render_scale()
        self.last_scale=scale
        image=G.QImage(max(1,int(round(area.width()*scale))),max(1,int(round(area.height()*scale))),G.QImage.Format.Format_RGB32)
        image.fill(G.QColor('#202329'))
        painter=G.QPainter(image)
        painter.scale(scale,scale)
        for widget,position in layers:
            grab=widget.grab()
            box=C.QRect(position.x()-area.x(),position.y()-area.y(),widget.width(),widget.height())
            if grab.isNull():
                painter.fillRect(box,G.QColor('#202329'))
            else:
                painter.drawPixmap(box,grab,grab.rect())
        painter.end()
        image.setDevicePixelRatio(scale)
        buffer=C.QBuffer()
        buffer.open(C.QIODevice.OpenModeFlag.WriteOnly)
        image.save(buffer,'PNG')
        payload=bytes(buffer.data().toBase64()).decode('ascii')
        digest=hashlib.sha1(payload.encode('ascii')).hexdigest()
        self.origin=origin+area.topLeft()
        # Re-sending an identical frame makes Chromium decode a fresh PNG several
        # times a second; that flicker is what users read as the canvas jumping.
        # While nothing moves, back off instead of re-grabbing every widget.
        if digest==getattr(self,'frame_digest',None):
            self.idle_ticks+=1
            if self.idle_ticks==8:self.timer.setInterval(500)
            return
        self.frame_digest=digest
        self.idle_ticks=0
        if self.timer.interval()!=120:self.timer.setInterval(120)
        self.bridge.emit('native_frame',image=payload,width=image.width(),height=image.height())
    def input(self,data):
        if not self.enabled:return
        app=W.QApplication.instance()
        kind=data.get('kind')
        if kind in {'down','up','move','double','wheel'}:
            point=getattr(self,'origin',self.window.mapToGlobal(C.QPoint()))+C.QPoint(int(data.get('x',0)),int(data.get('y',0)))
            self.last_global=point
            target=None
            for window in reversed(self.visible_windows()):
                local=window.mapFromGlobal(point)
                if window.rect().contains(local):
                    target=window.childAt(local) or window
                    break
            if kind in {'move','up'} and self.mouse_target is not None:
                target=self.mouse_target
            if target is None:return
            if __import__('os').environ.get('XAL_ELECTRON_QA')=='1':
                self.input_trace=getattr(self,'input_trace',[])[-12:]+[{'kind':kind,'target':type(target).__name__,'buttons':data.get('buttons'),'point':[point.x(),point.y()]}]
            local=target.mapFromGlobal(point)
            button={0:C.Qt.MouseButton.LeftButton,1:C.Qt.MouseButton.MiddleButton,2:C.Qt.MouseButton.RightButton}.get(data.get('button'),C.Qt.MouseButton.LeftButton)
            modifiers=C.Qt.KeyboardModifier.ControlModifier if data.get('ctrl') else C.Qt.KeyboardModifier.NoModifier
            if data.get('shift'):modifiers|=C.Qt.KeyboardModifier.ShiftModifier
            if kind=='down':
                self.mouse_target=target
                self.mouse_button=button
                QtTest.QTest.mousePress(target,button,modifiers,local,0)
            elif kind=='up':
                self.mouse_target=None
                QtTest.QTest.mouseRelease(target,button,modifiers,local,0)
            elif kind=='double':QtTest.QTest.mouseDClick(target,button,modifiers,local,0)
            elif kind=='move':
                buttons=getattr(self,'mouse_button',button) if self.mouse_target is not None else C.Qt.MouseButton.NoButton
                event=G.QMouseEvent(C.QEvent.Type.MouseMove,C.QPointF(local),C.QPointF(point),C.Qt.MouseButton.NoButton,buttons,modifiers)
                app.sendEvent(target,event)
            else:
                event=G.QWheelEvent(C.QPointF(local),C.QPointF(point),C.QPoint(),C.QPoint(0,-int(data.get('delta',0))),C.Qt.MouseButton.NoButton,modifiers,C.Qt.ScrollPhase.NoScrollPhase,False)
                app.sendEvent(target,event)
        elif kind=='text':
            target=app.focusWidget()
            if target:
                event=G.QInputMethodEvent()
                event.setCommitString(str(data.get('text',''))[:100000])
                app.sendEvent(target,event)
        elif kind=='key':
            keys={'Enter':C.Qt.Key.Key_Return,'Escape':C.Qt.Key.Key_Escape,'Backspace':C.Qt.Key.Key_Backspace,'Delete':C.Qt.Key.Key_Delete,'Tab':C.Qt.Key.Key_Tab,'ArrowLeft':C.Qt.Key.Key_Left,'ArrowRight':C.Qt.Key.Key_Right,'ArrowUp':C.Qt.Key.Key_Up,'ArrowDown':C.Qt.Key.Key_Down,'Home':C.Qt.Key.Key_Home,'End':C.Qt.Key.Key_End}
            key=str(data.get('key',''))
            code=keys.get(key,ord(key.upper()) if len(key)==1 else None)
            target=app.focusWidget() or self.window
            if code:
                mods=C.Qt.KeyboardModifier.ControlModifier if data.get('ctrl') else C.Qt.KeyboardModifier.NoModifier
                if data.get('shift'):mods|=C.Qt.KeyboardModifier.ShiftModifier
                QtTest.QTest.keyClick(target,code,mods,0)

    def diagnostics(self):
        """QA-only geometry used to exercise rendered controls with real input."""
        origin=getattr(self,'origin',self.window.mapToGlobal(C.QPoint()))
        widgets=[]
        for window in self.visible_windows():
            for widget in [window]+window.findChildren(W.QWidget):
                if not widget.isVisible() or not isinstance(widget,(W.QMenuBar,W.QMenu,W.QAbstractButton,W.QLineEdit,W.QComboBox,W.QDialog)):continue
                pos=widget.mapToGlobal(C.QPoint())-origin
                item={'type':type(widget).__name__,'name':widget.objectName(),'rect':[pos.x(),pos.y(),widget.width(),widget.height()]}
                if isinstance(widget,(W.QAbstractButton,W.QLineEdit)):item['text']=widget.text()
                if isinstance(widget,W.QDialog):item['title']=widget.windowTitle()
                if isinstance(widget,(W.QMenuBar,W.QMenu)):
                    item['actions']=[]
                    for action in widget.actions():
                        r=widget.actionGeometry(action).translated(pos)
                        item['actions'].append({'text':action.text(),'enabled':action.isEnabled(),'rect':[r.x(),r.y(),r.width(),r.height()]})
                widgets.append(item)
        canvas=self.bridge.workflow.view.canvas
        pos=canvas.mapToGlobal(C.QPoint())-origin
        offset=canvas.offset_to_center()
        cursor=canvas.mapFromGlobal(self.last_global) if getattr(self,'last_global',None) is not None else None
        return {'platform':W.QApplication.platformName(),'enabled':self.enabled,'widgets':widgets,
                'input_trace':getattr(self,'input_trace',[]),'editing':canvas.editing(),'selected':len(canvas.selected_shapes),'hover':getattr(canvas.h_shape,'label',None),
                'cursor':[cursor.x(),cursor.y()] if cursor is not None else None,
                'render_scale':getattr(self,'last_scale',self.render_scale()),
                'canvas':{'pos':[pos.x(),pos.y()],'offset':[offset.x(),offset.y()],'scale':canvas.scale,
                          'shapes':[s.to_dict() for s in canvas.shapes]}}
