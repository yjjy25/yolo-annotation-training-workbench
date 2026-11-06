"""MaixCAM / MaixCAM2 WiFi 采集端（配「标注训练工作台」使用）。

用 MaixVision 单独运行本文件。它只依赖设备系统的 MaixPy 和 Python 标准库，
不需要模型文件，也不会运行识别或串口发送。工作台通过

    http://<设备IP>:8080/snapshot.jpg   取得摄像头端编码的原始 JPG
    http://<设备IP>:8080/status.json    查看帧号、画面新旧和相机参数

访问设备。运行后先在设备「设置 / 网络」查看 IP，电脑与设备需在同一局域网。
采集结束后停止本程序，再运行原来的识别程序，不要让两个程序同时打开摄像头。
分辨率、帧率和 JPG 质量可直接修改下面的常量（须为传感器支持的尺寸）。
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

WIDTH, HEIGHT = 1280, 720
FPS = 10
JPEG_QUALITY = 85
PORT = 8080
STALE_SECONDS = 3.0

HELP_PAGE = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>MaixCAM 采集端</title><body style="font:16px/1.7 sans-serif;max-width:680px;margin:40px auto">
<h1>MaixCAM 网络采集已启动</h1>
<p>在工作台的「WiFi 摄像头采集」页填写本机 IP，或浏览器打开
<a href="/snapshot.jpg">/snapshot.jpg</a> 刷新查看实时画面。</p>
<p>帧号与相机参数见 <a href="/status.json">/status.json</a>。</p>
<p>这是供可信局域网使用的普通 HTTP 接口，没有账号鉴权，请勿把 8080 端口映射到公网。</p>
</body></html>"""


class FrameStore:
    """Latest JPEG plus a monotonic sequence, shared by camera and HTTP threads."""

    def __init__(self):
        self.lock = threading.Lock()
        self.frame = None
        self.sequence = 0
        self.updated = 0.0

    def publish(self, jpeg):
        with self.lock:
            self.frame = bytes(jpeg)
            self.sequence += 1
            self.updated = time.monotonic()

    def snapshot(self):
        with self.lock:
            if self.frame is None or time.monotonic() - self.updated > STALE_SECONDS:
                return None, self.sequence
            return self.frame, self.sequence

    def info(self):
        with self.lock:
            age = time.monotonic() - self.updated if self.updated else None
            return {
                "ready": self.frame is not None and age is not None and age <= STALE_SECONDS,
                "sequence": self.sequence,
                "age_seconds": round(age, 3) if age is not None else None,
                "width": WIDTH,
                "height": HEIGHT,
                "fps": FPS,
                "quality": JPEG_QUALITY,
                "port": PORT,
            }


def create_server(host="0.0.0.0", port=PORT, store=None):
    """Build the HTTP server. Exposed so a PC can run a mock camera in tests."""
    store = store if store is not None else FrameStore()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            target = urlsplit(self.path).path
            if target == "/snapshot.jpg":
                frame, sequence = store.snapshot()
                if frame is None:
                    self.send_error(503, "Camera not ready or frame is stale")
                    return
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(frame)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Frame-Sequence", str(sequence))
                    self.end_headers()
                    self.wfile.write(frame)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass
                return
            if target == "/status.json":
                payload = json.dumps(store.info()).encode("utf-8")
                self._send(payload, "application/json")
                return
            if target == "/":
                self._send(HELP_PAGE.encode("utf-8"), "text/html; charset=utf-8")
                return
            self.send_error(404, "Use /snapshot.jpg or /status.json")

        def _send(self, payload, content_type):
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server, store


def main():
    from maix import app, camera, display

    cam = camera.Camera(WIDTH, HEIGHT, fps=FPS)
    screen = display.Display()
    server = None
    try:
        server, frames = create_server()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print("Network camera ready: http://<DEVICE-IP>:%d/snapshot.jpg" % PORT)
        print("Find DEVICE-IP in the device Settings / Network page.")
        while not app.need_exit():
            frame = cam.read()
            if frame is None:
                time.sleep(0.01)
                continue
            jpeg = frame.to_jpeg(quality=JPEG_QUALITY)
            frames.publish(jpeg.to_bytes())
            screen.show(frame)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        cam.close()


if __name__ == "__main__":
    main()
