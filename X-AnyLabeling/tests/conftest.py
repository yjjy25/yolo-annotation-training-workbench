"""Keep one QApplication alive across GUI test modules.

Dropping a module-local application while Qt objects from another test still
exist can abort the interpreter during collection or fixture teardown.
"""
import os
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
_application = None


@pytest.fixture(scope="session", autouse=True)
def application_session():
    global _application
    from PyQt6.QtWidgets import QApplication
    _application = QApplication.instance() or QApplication([])
    return _application
