from types import SimpleNamespace
import sys
import pytest
from PyQt6 import QtCore
from anylabeling.services.workflow.project import write_json, read_json
from anylabeling.views.workflow.desktop_controller import DesktopController


@pytest.mark.parametrize('terminal', ['completed', 'failed', 'stopped'])
def test_terminal_import_waits_for_process_exit(tmp_path, terminal):
    payload = tmp_path / 'payload.json'
    progress = tmp_path / 'progress.json'
    write_json(payload, {})
    job = QtCore.QProcess()
    controller = SimpleNamespace(video_payload=payload, video_job=job, video_kind='import')
    # Atomically publish a complete result, like the real worker, then keep the
    # process alive during cleanup. File existence must never expose partial JSON.
    code = "import json,sys,time;from pathlib import Path;p=Path(sys.argv[1]);tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps({'status':sys.argv[2],'count':39,'id':'clip'}));tmp.replace(p);time.sleep(1.5)"
    job.start(sys.executable, ['-c', code, str(progress), terminal])
    try:
        assert job.waitForStarted(3000)
        deadline = QtCore.QDeadlineTimer(3000)
        while not progress.exists() and not deadline.hasExpired():
            QtCore.QCoreApplication.processEvents()
            QtCore.QThread.msleep(10)
        assert read_json(progress)['status'] == terminal
        assert job.state() != QtCore.QProcess.ProcessState.NotRunning
        status = DesktopController.video_status(controller)
        assert status['status'] == 'running', 'A terminal file is not proof that the worker released the job lock'
        assert status['count'] == 39
        with pytest.raises(ValueError, match='视频任务正在运行'):
            DesktopController.ensure_video_idle(controller)
        assert job.waitForFinished(5000)
        assert DesktopController.video_status(controller)['status'] == terminal
        DesktopController.ensure_video_idle(controller)
    finally:
        if job.state() != QtCore.QProcess.ProcessState.NotRunning:
            job.kill()
            job.waitForFinished(3000)


def test_unexpected_worker_exit_remains_failed(tmp_path):
    payload = tmp_path / 'payload.json'
    write_json(payload.with_name('progress.json'), {'status': 'running', 'count': 4})
    controller = SimpleNamespace(video_payload=payload, video_job=QtCore.QProcess(), video_kind='import')
    assert DesktopController.video_status(controller)['status'] == 'failed'


def test_tracking_pause_stays_visible_while_waiting_for_exit(tmp_path):
    payload = tmp_path / 'payload.json'
    write_json(payload.with_name('progress.json'), {'status': 'paused', 'frame': 39})
    controller = SimpleNamespace(video_payload=payload, video_job=SimpleNamespace(state=lambda:QtCore.QProcess.ProcessState.Running), video_kind='tracking')
    assert DesktopController.video_status(controller)['status'] == 'paused'
