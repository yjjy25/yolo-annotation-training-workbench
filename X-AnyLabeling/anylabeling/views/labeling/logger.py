import logging
import sys
from functools import wraps
from typing import Callable, Dict

import termcolor

COLORS: Dict[str, str] = {
    "WARNING": "yellow",
    "INFO": "white",
    "DEBUG": "blue",
    "CRITICAL": "red",
    "ERROR": "red",
}

EMOJI_PREFIXES = (
    "🔧️ ",
    "🔧 ",
    "🔄 ",
    "🖥️ ",
    "🖼️ ",
    "🎉 ",
    "🌐 ",
    "⌛ ",
    "✅ ",
    "❌ ",
    "⚠️ ",
    "🚀 ",
    "📥 ",
    "📤 ",
)


def strip_emoji_prefix(text: str) -> str:
    lines = []
    for line in text.split("\n"):
        for prefix in EMOJI_PREFIXES:
            if line.startswith(prefix):
                line = line.removeprefix(prefix)
                break
        lines.append(line)
    return "\n".join(lines)


def singleton(cls):
    instances = {}

    @wraps(cls)
    def get_instance(*args, **kwargs):
        if cls not in instances:
            instances[cls] = cls(*args, **kwargs)
        return instances[cls]

    return get_instance


class ColoredFormatter(logging.Formatter):
    def __init__(self, fmt: str, use_color: bool = True):
        super().__init__(fmt)
        self.use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        if self.use_color and record.levelname in COLORS:
            record = self._color_record(record)
        record.asctime = self.formatTime(record, self.datefmt)
        return super().format(record)

    def _color_record(self, record: logging.LogRecord) -> logging.LogRecord:
        def colored(text, color):
            return termcolor.colored(text, color=color, attrs={"bold": True})

        message = record.msg
        if isinstance(message, str):
            message = strip_emoji_prefix(message)
        record.levelname2 = colored(
            f"{record.levelname:<7}", COLORS[record.levelname]
        )
        record.message2 = colored(message, COLORS[record.levelname])
        record.asctime2 = termcolor.colored(
            self.formatTime(record, self.datefmt), color="green"
        )
        record.module2 = termcolor.colored(record.module, color="cyan")
        record.funcName2 = termcolor.colored(record.funcName, color="cyan")
        record.lineno2 = termcolor.colored(record.lineno, color="cyan")

        return record


@singleton
class AppLogger:
    def __init__(self, name="X-AnyLabeling"):
        self.logger = logging.getLogger(name)
        self.logger.propagate = False
        self._setup_handler()

    def _setup_handler(self):
        stream_handler = logging.StreamHandler(sys.stderr)
        handler_format = ColoredFormatter(
            "%(asctime)s | %(levelname2)s | %(module2)s:%(funcName2)s:%(lineno2)s %(message2)s"
        )
        stream_handler.setFormatter(handler_format)
        self.logger.addHandler(stream_handler)

    def __getattr__(self, name: str) -> Callable:
        return getattr(self.logger, name)

    def set_level(self, level: str):
        self.logger.setLevel(level)


logger = AppLogger()
